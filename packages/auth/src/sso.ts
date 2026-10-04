import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { and, eq, identityProviders, memberships, scopeOf, sql, users, type Database } from "@eaop/db";
import { AuditActions, type AuditService } from "@eaop/audit";
import { type EventBus } from "@eaop/events";
import { type RoleService, type Authorizer } from "@eaop/rbac";
import { type SecretStore } from "@eaop/secrets";
import { assertSafeOutboundUrl, constantTimeEqual, hmacSha256, randomToken, sha256, type UrlGuardOptions } from "@eaop/security";
import { AppError, notFound, SYSTEM_ACTOR, type RequestMeta, type TenantContext } from "@eaop/shared-types";
import { type AuthService } from "./auth-service";

/**
 * Enterprise SSO.
 *  - OIDC (authorization code + PKCE, signed state, nonce, JWKS-verified
 *    id_token) is implemented and works once an IdP is configured.
 *  - SAML 2.0 configuration is stored, but the assertion consumer requires an
 *    XML-signature library and IdP metadata — it fails closed with
 *    NOT_IMPLEMENTED (see docs/AUTHENTICATION.md).
 *  - SCIM provisioning: contract documented, endpoint not implemented.
 */
export const configureOidcSchema = z.object({
  name: z.string().min(1).max(120),
  issuer: z.string().url().max(500),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(2000).optional(),
  scopes: z.array(z.string().max(64)).max(20).default(["openid", "email", "profile"]),
  domains: z.array(z.string().toLowerCase().max(253)).max(20).default([]),
  jitProvisioning: z.boolean().default(false),
  defaultRoleKey: z.string().default("standard_user"),
});

export const configureSamlSchema = z.object({
  name: z.string().min(1).max(120),
  entityId: z.string().min(1).max(500),
  ssoUrl: z.string().url().max(1000),
  certificateFingerprint: z.string().min(16).max(200),
  domains: z.array(z.string().toLowerCase().max(253)).max(20).default([]),
});

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdentityProviderView {
  id: string;
  protocol: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
  domains: string[];
  jitProvisioning: boolean;
  defaultRoleKey: string;
  hasClientSecret: boolean;
}

interface SignedState {
  idp: string;
  org: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export interface SsoService {
  list(ctx: TenantContext): Promise<IdentityProviderView[]>;
  configureOidc(ctx: TenantContext, input: z.input<typeof configureOidcSchema>): Promise<IdentityProviderView>;
  configureSaml(ctx: TenantContext, input: z.input<typeof configureSamlSchema>): Promise<IdentityProviderView>;
  setStatus(ctx: TenantContext, id: string, status: "active" | "disabled"): Promise<void>;
  /** Find an active IdP for an email domain (home-realm discovery). */
  discover(email: string): Promise<{ idpId: string; protocol: string; name: string } | null>;
  startLogin(idpId: string): Promise<{ authorizationUrl: string; state: string }>;
  /** `stateCookie` is the value set by startLogin; it must match the `state` query param. */
  completeOidc(params: { code: string; state: string; stateCookie: string }, meta: RequestMeta): Promise<{ token: string; organizationId: string }>;
}

export function createSsoService(deps: {
  db: Database;
  authorizer: Authorizer;
  roles: RoleService;
  audit: AuditService;
  bus: EventBus;
  secrets: SecretStore;
  auth: AuthService;
  appUrl: string;
  appSecret: string;
  urlGuard: UrlGuardOptions;
  fetchImpl?: typeof fetch;
  jwksFor?: (uri: string) => JWTVerifyGetKey;
}): SsoService {
  const { db, authorizer, audit, secrets } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const jwksCache = new Map<string, JWTVerifyGetKey>();
  const jwks = (uri: string) => {
    if (deps.jwksFor) return deps.jwksFor(uri);
    let k = jwksCache.get(uri);
    if (!k) jwksCache.set(uri, (k = createRemoteJWKSet(new URL(uri))));
    return k;
  };
  const redirectUri = `${deps.appUrl.replace(/\/$/, "")}/api/v1/auth/sso/oidc/callback`;

  const view = (r: typeof identityProviders.$inferSelect): IdentityProviderView => ({
    id: r.id,
    protocol: r.protocol,
    name: r.name,
    status: r.status,
    config: r.config,
    domains: r.domains,
    jitProvisioning: r.jitProvisioning,
    defaultRoleKey: r.defaultRoleKey,
    hasClientSecret: !!r.clientSecretRef,
  });

  async function discovery(issuer: string): Promise<OidcDiscovery> {
    await assertSafeOutboundUrl(issuer, deps.urlGuard);
    const res = await doFetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new AppError("UPSTREAM_ERROR", `OIDC discovery failed (${res.status}).`);
    const d = (await res.json()) as OidcDiscovery;
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new AppError("UPSTREAM_ERROR", "OIDC discovery document is incomplete.");
    if (d.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new AppError("VALIDATION_FAILED", "Issuer mismatch in discovery document.");
    for (const u of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) await assertSafeOutboundUrl(u, deps.urlGuard);
    return d;
  }

  const sign = (s: SignedState) => {
    const body = Buffer.from(JSON.stringify(s)).toString("base64url");
    return `${body}.${hmacSha256(deps.appSecret, body)}`;
  };
  const unsign = (v: string): SignedState | null => {
    const [body, mac] = v.split(".");
    if (!body || !mac || !constantTimeEqual(mac, hmacSha256(deps.appSecret, body))) return null;
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as SignedState;
    return s.exp > Date.now() ? s : null;
  };

  async function loadIdp(id: string) {
    const [idp] = await db.withSystem("sso.load_idp", (tx) => tx.select().from(identityProviders).where(eq(identityProviders.id, id)).limit(1));
    if (!idp || idp.status !== "active") throw new AppError("NOT_FOUND", "Identity provider not found or inactive.");
    return idp;
  }

  return {
    async list(ctx) {
      await authorizer.require(ctx, "org.security.read");
      const rows = await db.withTenant(scopeOf(ctx), (tx) => tx.select().from(identityProviders).where(eq(identityProviders.organizationId, ctx.organizationId)));
      return rows.map(view);
    },

    async configureOidc(ctx, raw) {
      await authorizer.require(ctx, "org.security.manage");
      const input = configureOidcSchema.parse(raw);
      const disco = await discovery(input.issuer); // validates reachability + SSRF policy
      const secretRef = input.clientSecret ? await secrets.put({ organizationId: ctx.organizationId, name: "oidc-client-secret", value: input.clientSecret }) : null;
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(identityProviders)
          .values({
            organizationId: ctx.organizationId,
            protocol: "oidc",
            name: input.name,
            status: "draft",
            config: { issuer: disco.issuer, clientId: input.clientId, scopes: input.scopes, authorizationEndpoint: disco.authorization_endpoint, tokenEndpoint: disco.token_endpoint, jwksUri: disco.jwks_uri },
            clientSecretRef: secretRef,
            domains: input.domains,
            jitProvisioning: input.jitProvisioning,
            defaultRoleKey: input.defaultRoleKey,
          })
          .returning(),
      );
      await audit.record(ctx, { action: AuditActions.IDP_CHANGED, resourceType: "identity_provider", resourceId: row!.id, after: { protocol: "oidc", name: input.name, issuer: disco.issuer, domains: input.domains, jit: input.jitProvisioning } });
      return view(row!);
    },

    async configureSaml(ctx, raw) {
      await authorizer.require(ctx, "org.security.manage");
      const input = configureSamlSchema.parse(raw);
      const [row] = await db.withTenant(scopeOf(ctx), (tx) =>
        tx
          .insert(identityProviders)
          .values({ organizationId: ctx.organizationId, protocol: "saml", name: input.name, status: "draft", config: { entityId: input.entityId, ssoUrl: input.ssoUrl, certificateFingerprint: input.certificateFingerprint }, domains: input.domains })
          .returning(),
      );
      await audit.record(ctx, { action: AuditActions.IDP_CHANGED, resourceType: "identity_provider", resourceId: row!.id, after: { protocol: "saml", name: input.name } });
      return view(row!);
    },

    async setStatus(ctx, id, status) {
      await authorizer.require(ctx, "org.security.manage");
      const [row] = await db.withTenant(scopeOf(ctx), (tx) => tx.update(identityProviders).set({ status, updatedAt: new Date() }).where(eq(identityProviders.id, id)).returning());
      if (!row) throw notFound("Identity provider", id);
      await audit.record(ctx, { action: AuditActions.IDP_CHANGED, resourceType: "identity_provider", resourceId: id, after: { status } });
    },

    async discover(email) {
      const domain = email.toLowerCase().split("@")[1];
      if (!domain) return null;
      const [row] = await db.withSystem("sso.discover", (tx) =>
        tx.select().from(identityProviders).where(and(eq(identityProviders.status, "active"), sql`${domain} = any(${identityProviders.domains})`)).limit(1),
      );
      return row ? { idpId: row.id, protocol: row.protocol, name: row.name } : null;
    },

    async startLogin(idpId) {
      const idp = await loadIdp(idpId);
      if (idp.protocol === "saml") throw new AppError("NOT_IMPLEMENTED", "SAML sign-in is not implemented yet. See docs/AUTHENTICATION.md.");
      const cfg = idp.config as { clientId: string; scopes: string[]; authorizationEndpoint: string };
      const verifier = randomToken(48);
      const nonce = randomToken(16);
      const state = sign({ idp: idp.id, org: idp.organizationId, nonce, verifier, exp: Date.now() + 10 * 60_000 });
      const url = new URL(cfg.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", cfg.scopes.join(" "));
      url.searchParams.set("state", sha256(state));
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url"));
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: url.toString(), state };
    },

    async completeOidc(params, meta) {
      const state = unsign(params.stateCookie);
      if (!state || !constantTimeEqual(sha256(params.stateCookie), params.state)) throw new AppError("UNAUTHENTICATED", "SSO state is invalid or expired.");
      const idp = await loadIdp(state.idp);
      const cfg = idp.config as { issuer: string; clientId: string; tokenEndpoint: string; jwksUri: string };
      const body = new URLSearchParams({ grant_type: "authorization_code", code: params.code, redirect_uri: redirectUri, client_id: cfg.clientId, code_verifier: state.verifier });
      if (idp.clientSecretRef) body.set("client_secret", await secrets.get(idp.clientSecretRef, idp.organizationId));
      await assertSafeOutboundUrl(cfg.tokenEndpoint, deps.urlGuard);
      const res = await doFetch(cfg.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new AppError("UNAUTHENTICATED", "The identity provider rejected the sign-in.");
      const tokens = (await res.json()) as { id_token?: string };
      if (!tokens.id_token) throw new AppError("UNAUTHENTICATED", "No id_token returned by the identity provider.");
      await assertSafeOutboundUrl(cfg.jwksUri, deps.urlGuard);
      const { payload } = await jwtVerify(tokens.id_token, jwks(cfg.jwksUri), { issuer: cfg.issuer, audience: cfg.clientId }).catch(() => {
        throw new AppError("UNAUTHENTICATED", "The identity token could not be verified.");
      });
      if (payload.nonce !== state.nonce) throw new AppError("UNAUTHENTICATED", "SSO nonce mismatch.");
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
      if (!email || payload.email_verified === false) throw new AppError("UNAUTHENTICATED", "The identity provider did not return a verified email.");
      const domain = email.split("@")[1]!;
      if (idp.domains.length && !idp.domains.includes(domain)) throw new AppError("FORBIDDEN", "Your email domain is not permitted for this identity provider.");

      const orgId = idp.organizationId;
      const ctx: TenantContext = { organizationId: orgId, actor: SYSTEM_ACTOR("sso"), ...meta, cache: new Map() };
      let [user] = await db.withSystem("sso.find_user", (tx) => tx.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1));
      const [member] = user
        ? await db.withTenant({ organizationId: orgId }, (tx) => tx.select().from(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, user!.id))).limit(1))
        : [];
      if (member?.status === "active") {
        // existing member — fall through
      } else if (idp.jitProvisioning && (!member || member.status === "invited")) {
        if (!user) {
          const name = typeof payload.name === "string" ? payload.name.slice(0, 160) : email;
          [user] = await db.withSystem("sso.jit_user", (tx) => tx.insert(users).values({ email, name, status: "active" }).returning());
        }
        const [m] = await db.withTenant({ organizationId: orgId }, (tx) =>
          tx
            .insert(memberships)
            .values({ organizationId: orgId, userId: user!.id, status: "active", source: "sso_jit", joinedAt: new Date() })
            .onConflictDoUpdate({ target: [memberships.organizationId, memberships.userId], set: { status: "active", updatedAt: new Date() } })
            .returning(),
        );
        await deps.roles.grantInternal(ctx, m!.id, idp.defaultRoleKey);
        await deps.bus.publish(ctx, "user.joined", { userId: user!.id, membershipId: m!.id, source: "sso_jit" });
      } else {
        await audit.recordDetached(ctx, { action: AuditActions.LOGIN_FAILED, outcome: "denied", metadata: { reason: "sso_not_member", email } });
        throw new AppError("FORBIDDEN", "You are not a member of this organization.");
      }
      const { token } = await deps.auth.createSessionForUser(user!.id, orgId, "oidc", meta);
      return { token, organizationId: orgId };
    },
  };
}
