import { type z } from "zod";
import { and, eq, idempotencyKeys, scopeOf } from "@eaop/db";
import { runWithCorrelation, sanitizeCorrelationId } from "@eaop/observability";
import { type Platform } from "@eaop/platform";
import { CSRF_COOKIE, CSRF_HEADER, RATE_LIMITS, SESSION_COOKIE, sha256, verifyCsrf, type RateLimitRule } from "@eaop/security";
import { AppError, type ModuleId, type RequestMeta, type TenantContext } from "@eaop/shared-types";
import { USAGE_METRICS } from "@eaop/usage";
import { clientIp, errorResponse, json, parseCookies, serializeCookie } from "./http";
import { type SessionRecord, type SessionUser } from "@eaop/auth";

/**
 * auth modes:
 *  public          – no authentication (login, invitation acceptance, probes)
 *  session         – browser session with an active tenant
 *  session_any     – browser session, tenant optional (profile, MFA, org switch)
 *  any             – session OR API key (Authorization: Bearer eaop_...)
 */
export type AuthMode = "public" | "session" | "session_any" | "any";

export interface RouteArgs<B, Q> {
  req: Request;
  platform: Platform;
  params: Record<string, string>;
  body: B;
  query: Q;
  meta: RequestMeta;
  /** Present for authenticated routes with an active tenant. */
  ctx: TenantContext;
  session?: { user: SessionUser; session: SessionRecord; token: string };
  cookies: Record<string, string>;
  /** Append Set-Cookie headers to the response. */
  setCookie(cookie: string): void;
}

export interface RouteOptions<BS extends z.ZodTypeAny | undefined, QS extends z.ZodTypeAny | undefined> {
  auth: AuthMode;
  /** Permission required. Checked server-side, with module entitlement. */
  permission?: string;
  /** Require this module to be enabled for the tenant. */
  module?: ModuleId;
  body?: BS;
  query?: QS;
  rateLimit?: RateLimitRule;
  /** Honour the Idempotency-Key header for this mutating route. */
  idempotent?: boolean;
  /** Allowed while the org requires MFA and the user has not enrolled yet. */
  allowDuringMfaEnrollment?: boolean;
  status?: number;
  handler(args: RouteArgs<BS extends z.ZodTypeAny ? z.infer<BS> : undefined, QS extends z.ZodTypeAny ? z.infer<QS> : undefined>): Promise<unknown>;
}

/** Matches Next.js App Router handlers: the second argument is always present. */
export interface RouteContext {
  params: Promise<Record<string, string | string[] | undefined>>;
}
export type RouteHandler = (req: Request, routeCtx: RouteContext) => Promise<Response>;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

export function createRouteFactory(getPlatform: () => Platform | Promise<Platform>) {
  return function route<BS extends z.ZodTypeAny | undefined = undefined, QS extends z.ZodTypeAny | undefined = undefined>(opts: RouteOptions<BS, QS>): RouteHandler {
    return async (req, routeCtx) => {
      const requestId = sanitizeCorrelationId(req.headers.get("x-request-id"));
      const platform = await getPlatform();
      const started = performance.now();
      const url = new URL(req.url);
      const cookiesOut: string[] = [];
      let orgForLog: string | undefined;

      return runWithCorrelation({ correlationId: requestId }, async () => {
        let response: Response;
        try {
          const meta: RequestMeta = { correlationId: requestId, ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined };
          const cookies = parseCookies(req.headers.get("cookie"));
          const rawParams = (await routeCtx?.params) ?? {};
          const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, Array.isArray(v) ? v.join("/") : (v ?? "")]));

          // ── Authentication ────────────────────────────────────────────────
          let ctx: TenantContext | undefined;
          let session: RouteArgs<unknown, unknown>["session"];
          const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(eaop_\S+)$/)?.[1];
          const allowedOrigins = [new URL(platform.env.APP_URL).origin];
          // Public mutations (login, signup, invitation acceptance): reject cross-site browser requests
          // (login CSRF). Non-browser clients send no Origin header and are unaffected.
          const origin = req.headers.get("origin");
          if (opts.auth === "public" && MUTATING.has(req.method) && origin && !allowedOrigins.includes(origin)) {
            throw new AppError("CSRF_FAILED", undefined, { reason: "origin_mismatch" });
          }
          if (opts.auth !== "public") {
            if (bearer && opts.auth === "any") {
              const key = await platform.apiKeys.authenticate(bearer);
              if (!key) throw new AppError("UNAUTHENTICATED", "Invalid or expired API key.");
              ctx = { organizationId: key.organizationId, actor: key.actor, ...meta, cache: new Map() };
            } else {
              const token = cookies[SESSION_COOKIE];
              if (!token) throw new AppError("UNAUTHENTICATED");
              // Cookie-authenticated mutations must pass the CSRF check.
              const csrf = verifyCsrf({
                method: req.method,
                origin: req.headers.get("origin"),
                referer: req.headers.get("referer"),
                allowedOrigins,
                csrfHeader: req.headers.get(CSRF_HEADER),
                csrfCookie: cookies[CSRF_COOKIE] ?? null,
              });
              if (!csrf.ok) throw new AppError("CSRF_FAILED", undefined, { reason: csrf.reason });
              const resolved = await platform.auth.resolve(token, meta);
              if (!resolved) throw new AppError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
              session = { user: resolved.user, session: resolved.session, token };
              if (resolved.tenant) ctx = resolved.tenant;
              if (resolved.mfaEnrollmentRequired && !opts.allowDuringMfaEnrollment) {
                throw new AppError("MFA_REQUIRED", "Your organization requires multi-factor authentication. Enroll to continue.", { enrollment: true });
              }
              if (!ctx && opts.auth === "session") throw new AppError("FORBIDDEN", "You are not an active member of any organization.");
            }
            orgForLog = ctx?.organizationId;
          }

          // ── Rate limiting (per actor, or per IP for public routes) ────────
          const rlKey = ctx ? `api:${ctx.organizationId}:${ctx.actor.id}` : `ip:${meta.ip ?? "unknown"}:${url.pathname}`;
          const rl = await platform.rateLimiter.consume(rlKey, opts.rateLimit ?? RATE_LIMITS.api);
          if (!rl.allowed) throw new AppError("RATE_LIMITED", undefined, { retryAfterSeconds: rl.retryAfterSeconds });

          // ── Entitlement + authorization (server-side, always) ─────────────
          if (opts.module) {
            if (!ctx) throw new AppError("FORBIDDEN");
            await platform.modules.requireEnabled(ctx, opts.module);
          }
          if (opts.permission) {
            if (!ctx) throw new AppError("FORBIDDEN");
            await platform.rbac.authorizer.require(ctx, opts.permission);
          }

          // ── Validation ─────────────────────────────────────────────────────
          let rawBody: string | undefined;
          let body: unknown = undefined;
          if (opts.body) {
            rawBody = await req.text();
            if (rawBody.length > MAX_BODY_BYTES) throw new AppError("VALIDATION_FAILED", "Request body too large.");
            if (rawBody && !(req.headers.get("content-type") ?? "").includes("application/json")) throw new AppError("VALIDATION_FAILED", "Content-Type must be application/json.");
            let parsed: unknown = {};
            try {
              parsed = rawBody ? JSON.parse(rawBody) : {};
            } catch {
              throw new AppError("VALIDATION_FAILED", "Malformed JSON body.");
            }
            body = opts.body.parse(parsed);
          }
          const query = opts.query ? opts.query.parse(Object.fromEntries(url.searchParams)) : undefined;

          // ── Idempotency ────────────────────────────────────────────────────
          const idemKey = req.headers.get("idempotency-key");
          let idem: { orgId: string; key: string } | undefined;
          if (opts.idempotent && idemKey && ctx && MUTATING.has(req.method)) {
            if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idemKey)) throw new AppError("VALIDATION_FAILED", "Invalid Idempotency-Key.");
            const hash = sha256(`${req.method} ${url.pathname} ${rawBody ?? ""}`);
            const c = ctx;
            const replay = await platform.db.withTenant(scopeOf(c), async (tx) => {
              const inserted = await tx
                .insert(idempotencyKeys)
                .values({ organizationId: c.organizationId, key: `${c.actor.id}:${idemKey}`, requestHash: hash, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS) })
                .onConflictDoNothing()
                .returning();
              if (inserted[0]) return null;
              const [row] = await tx.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.organizationId, c.organizationId), eq(idempotencyKeys.key, `${c.actor.id}:${idemKey}`))).limit(1);
              if (!row) return null;
              if (row.requestHash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT");
              if (row.responseStatus === null) throw new AppError("CONFLICT", "A request with this Idempotency-Key is still in progress.");
              return row;
            });
            if (replay) {
              return new Response(JSON.stringify(replay.responseBody), { status: replay.responseStatus!, headers: { "content-type": "application/json", "idempotent-replayed": "true", "x-request-id": requestId } });
            }
            idem = { orgId: c.organizationId, key: `${c.actor.id}:${idemKey}` };
          }

          const result = await opts.handler({
            req,
            platform,
            params,
            body: body as never,
            query: query as never,
            meta,
            ctx: ctx as TenantContext,
            session,
            cookies,
            setCookie: (c) => cookiesOut.push(c),
          });
          response = result instanceof Response ? result : json(result ?? null, { status: opts.status ?? (req.method === "POST" ? 201 : 200) });

          if (idem && ctx) {
            const stored = await response.clone().json().catch(() => null);
            const c = ctx;
            const id = idem;
            await platform.db.withTenant(scopeOf(c), (tx) =>
              tx.update(idempotencyKeys).set({ responseStatus: response.status, responseBody: stored }).where(and(eq(idempotencyKeys.organizationId, id.orgId), eq(idempotencyKeys.key, id.key))),
            );
          }
          if (ctx?.actor.type === "api_key") {
            await platform.usage.record(ctx, { moduleId: "core", metric: USAGE_METRICS.API_REQUESTS.key, unit: USAGE_METRICS.API_REQUESTS.unit, quantity: 1, endpoint: `${req.method} ${url.pathname.replace(/[0-9a-f-]{36}/g, ":id")}` });
          }
        } catch (err) {
          const { response: r, unexpected } = errorResponse(err, requestId);
          response = r;
          if (unexpected) await platform.errors.report(err, { source: `api ${req.method} ${url.pathname}`, severity: "error", organizationId: orgForLog ?? null, correlationId: requestId });
        }

        const headers = new Headers(response.headers);
        headers.set("x-request-id", requestId);
        if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
        for (const c of cookiesOut) headers.append("set-cookie", c);
        const ms = Math.round(performance.now() - started);
        platform.metrics.increment("eaop_http_requests_total", { method: req.method, status: response.status });
        platform.metrics.observe("eaop_http_request_duration_ms", ms, { method: req.method });
        platform.logger.info("http.request", { method: req.method, path: url.pathname, status: response.status, durationMs: ms, organizationId: orgForLog });
        return new Response(response.body, { status: response.status, headers });
      });
    };
  };
}

export { serializeCookie };
