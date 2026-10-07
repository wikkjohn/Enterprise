import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSsoService } from "../../packages/auth/src/sso";
import { addMember, createOrg, createTestPlatform, uniq } from "../helpers/platform";

/**
 * SECURITY finding #2 (fixed): SSO JIT `defaultRoleKey` privilege escalation.
 *
 * Configuring an IdP requires only `org.security.manage`. Before the fix, the
 * chosen JIT role was stored and granted via the check-free `grantInternal`,
 * so a `security_admin` (which lacks `role.manage`) could set
 * `defaultRoleKey: "org_admin"` and mint org_admin accounts. `configureOidc`
 * now applies the same anti-escalation holds-check as invitations: the
 * configurer may only choose a role whose permissions they themselves hold.
 */
type P = Awaited<ReturnType<typeof createTestPlatform>>;
let p: P;
let org: Awaited<ReturnType<typeof createOrg>>;
let securityAdmin: Awaited<ReturnType<typeof addMember>>;

const ISSUER = "https://idp.corp-owned.example";

// Minimal OIDC discovery document so configureOidc's reachability/SSRF step succeeds in the control.
const discoveryFetch = (async (input: unknown) => {
  const url = String((input as Request).url ?? input);
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return new Response(
      JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as unknown as typeof fetch;

function sso() {
  return createSsoService({
    db: p.db, authorizer: p.rbac.authorizer, roles: p.rbac.roles, audit: p.audit, bus: p.events.bus, secrets: p.secrets, auth: p.auth,
    appUrl: "http://localhost:3000", appSecret: "test-app-secret-that-is-at-least-32-chars-long",
    urlGuard: { allowPrivateNetworks: true }, fetchImpl: discoveryFetch,
  });
}

const cfg = (defaultRoleKey: string) => ({ name: uniq("idp"), issuer: ISSUER, clientId: "client", scopes: ["openid", "email"], domains: ["corp-owned.example"], jitProvisioning: true, defaultRoleKey });

beforeAll(async () => {
  p = await createTestPlatform();
  org = await createOrg(p);
  securityAdmin = await addMember(p, org.org.id, ["security_admin"]);
});
afterAll(() => p.close());

describe("SSO configuration cannot escalate via the JIT role", () => {
  it("security_admin may configure SSO but not with a role it does not hold (org_admin)", async () => {
    await expect(sso().configureOidc(securityAdmin.ctx(), cfg("org_admin"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unknown JIT role", async () => {
    await expect(sso().configureOidc(securityAdmin.ctx(), cfg("not_a_role"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("control: an org_admin can configure SSO with a standard JIT role", async () => {
    const idp = await sso().configureOidc(org.adminCtx(), cfg("standard_user"));
    expect(idp).toMatchObject({ protocol: "oidc", jitProvisioning: true, defaultRoleKey: "standard_user" });
  });
});
