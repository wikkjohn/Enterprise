import { generateKeyPair, SignJWT } from "../../packages/auth/src/testing-jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSsoService } from "../../packages/auth/src/sso";
import { identityProviders } from "../../packages/db/src";
import { sha256 } from "../../packages/security/src";
import { createOrg, createTestPlatform, meta, uniq } from "../helpers/platform";

/**
 * SECURITY finding #2 (separate from the fixed takeover #1): SSO JIT
 * `defaultRoleKey` is unvalidated, and `grantInternal` performs no
 * anti-escalation check. An actor with only `org.security.manage` (e.g.
 * security_admin, which lacks `role.manage`) can configure an IdP with
 * `defaultRoleKey: "org_admin"` and JIT-provision an org_admin account — even
 * for a domain they own (so the #1 domain gate does not stop it).
 *
 * This asserts the SECURE behaviour and FAILS today; it lives in the
 * expected-red `security` project until the finding is fixed (validate
 * defaultRoleKey against the configurer's held permissions at configureOidc).
 */
type P = Awaited<ReturnType<typeof createTestPlatform>>;
let p: P;
let org: Awaited<ReturnType<typeof createOrg>>;
let priv: CryptoKey;
let pub: CryptoKey;

const ISSUER = "https://idp.corp-owned.example";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const DOMAIN = "corp-owned.example";

function ssoWith(fetchImpl: typeof fetch) {
  return createSsoService({
    db: p.db, authorizer: p.rbac.authorizer, roles: p.rbac.roles, audit: p.audit, bus: p.events.bus, secrets: p.secrets, auth: p.auth,
    appUrl: "http://localhost:3000", appSecret: "test-app-secret-that-is-at-least-32-chars-long",
    urlGuard: { allowPrivateNetworks: true }, fetchImpl, jwksFor: () => async () => pub,
  });
}

beforeAll(async () => {
  p = await createTestPlatform();
  ({ privateKey: priv, publicKey: pub } = await generateKeyPair("ES256"));
  org = await createOrg(p);
});
afterAll(() => p.close());

describe("SSO JIT must not grant a privileged role chosen in IdP config", () => {
  it("defaultRoleKey=org_admin does not mint an org_admin account (even for an owned domain)", async () => {
    const [idp] = await p.db.withSystem("test.idp", (tx) =>
      tx.insert(identityProviders).values({
        organizationId: org.org.id, protocol: "oidc", name: uniq("idp"), status: "active",
        config: { issuer: ISSUER, clientId: "client", scopes: ["openid", "email"], authorizationEndpoint: `${ISSUER}/auth`, tokenEndpoint: TOKEN_ENDPOINT, jwksUri: `${ISSUER}/jwks` },
        domains: [DOMAIN], jitProvisioning: true, defaultRoleKey: "org_admin",
      }).returning(),
    );
    const { state } = await ssoWith((async () => new Response("{}")) as unknown as typeof fetch).startLogin(idp!.id);
    const nonce = JSON.parse(Buffer.from(state.split(".")[0]!, "base64url").toString()).nonce as string;
    const email = `newhire-${uniq()}@${DOMAIN}`;
    const idToken = await new SignJWT({ email, email_verified: true, nonce }).setProtectedHeader({ alg: "ES256" }).setIssuedAt().setIssuer(ISSUER).setAudience("client").setExpirationTime("5m").sign(priv);
    const fetchImpl = (async (input: unknown) => {
      const url = String((input as Request).url ?? input);
      if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    await ssoWith(fetchImpl).completeOidc({ code: "c", state: sha256(state), stateCookie: state }, meta());
    const member = (await p.organizations.listMembers(org.adminCtx())).find((m) => m.email === email);
    expect(member, "JIT member should exist").toBeTruthy();
    expect(member!.roles.map((r) => r.key)).not.toContain("org_admin");
  });
});
