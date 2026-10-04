import { ZodError } from "zod";
import { isAppError } from "@eaop/shared-types";

/** Success envelope: { data, meta? }. Error envelope: { error: { code, message, details?, requestId } }. */
export function json(data: unknown, init: { status?: number; headers?: Record<string, string>; meta?: Record<string, unknown> } = {}) {
  return new Response(JSON.stringify(init.meta ? { data, meta: init.meta } : { data }), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init.headers },
  });
}

/** ZodError check that survives duplicate module copies (see isAppError). */
function asZodError(err: unknown): ZodError | null {
  if (err instanceof ZodError) return err;
  const e = err as { name?: unknown; issues?: unknown } | null;
  return e && typeof e === "object" && e.name === "ZodError" && Array.isArray(e.issues) ? (err as ZodError) : null;
}

export function errorResponse(err: unknown, requestId: string): { response: Response; unexpected: boolean } {
  let status = 500;
  let body: { code: string; message: string; details?: unknown; requestId: string };
  let unexpected = false;
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId };
  if (isAppError(err)) {
    status = err.status;
    body = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId };
    const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (status === 429 && retry) headers["retry-after"] = String(retry);
  } else if (asZodError(err)) {
    status = 422;
    body = { code: "VALIDATION_FAILED", message: "Request validation failed.", details: { issues: asZodError(err)!.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) }, requestId };
  } else {
    unexpected = true;
    // Never leak internals: no stack, no raw message.
    body = { code: "INTERNAL", message: "An internal error occurred.", requestId };
  }
  return { response: new Response(JSON.stringify({ error: body }), { status, headers }), unexpected };
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { httpOnly?: boolean; secure?: boolean; sameSite?: "lax" | "strict"; path?: string; maxAge?: number }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`, `SameSite=${opts.sameSite === "strict" ? "Strict" : "Lax"}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

/**
 * Client IP. Behind a reverse proxy the proxy appends the real client
 * address as the LAST x-forwarded-for entry, which clients cannot forge.
 */
export function clientIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return req.headers.get("x-real-ip") ?? undefined;
}
