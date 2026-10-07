import { generateKeyPair, SignJWT } from "../../packages/auth/src/testing-jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSsoService } from "../../packages/auth/src/sso";
import { eq, identityProviders, memberships } from "../../packages/db/src";
import { sha256 } from "../../packages/security/src";
import { createOrg, createTestPlatform, createUser, meta, uniq } from "../helpers/platform";

/**
 * SECURITY: SSO / OIDC account-takeover via JIT provisioning.
 *
 * completeOidc() links the id_token's email to any PRE-EXISTING user and
 * issues a session as that user, with no proof that the organization owns the
 * email domain — and an empty `domains` list skips the domain check entirely.
 * A tenant admin who runs their own IdP can therefore assert a victim's email,
 * receive a session as the victim, and (because org-switch trusts the victim's
 * real memberships) pivot into the victim's other tenants.
 *
 * These tests assert the SECURE behaviour, so they FAIL against today's code
 * and document the vulnerability. The attacker controls the IdP: we sign the
 * id_token with our own key and serve the token endpoint from a stub.
 */
type P = Awaited<ReturnType<typeof createTestPlatform>>;

let p: P;
let victim: Awaited<ReturnType<typeof createUser>>;
let victimOrg: Awaited<ReturnType<typeof createOrg>>;
let attackerOrg: Awaited<ReturnType<typeof createOrg>>;
let priv: CryptoKey;
let pub: CryptoKey;

const ISSUER = "https://attacker-idp.example";
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URI = `${ISSUER}/jwks`;

// The attacker's IdP: a stub token endpoint that returns an id_token the attacker minted.
async function attackerFetch(mintedIdToken: string): Promise<typeof fetch> {
  return (async (input: unknown) => {
    const url = String((input as Request).url ?? input);
    if (url === TOKEN_ENDPOINT) return new Response(JSON.stringify({ id_token: mintedIdToken }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

function ssoWith(fetchImpl: typeof fetch) {
  // jwksFor returns a resolver that yields the attacker's public key for every kid.
  return createSsoService({
    db: p.db, authorizer: p.rbac.authorizer, roles: p.rbac.roles, audit: p.audit, bus: p.events.bus, secrets: p.secrets, auth: p.auth,
    appUrl: "http://localhost:3000", appSecret: "test-app-secret-that-is-at-least-32-chars-long",
    urlGuard: { allowPrivateNetworks: true }, fetchImpl, jwksFor: () => async () => pub,
  });
}

async function mintIdToken(claims: Record<string, unknown>, nonce: string) {
  return new SignJWT({ ...claims, nonce }).setProtectedHeader({ alg: "ES256" }).setIssuedAt().setIssuer(ISSUER).setAudience("attacker-client").setExpirationTime("5m").sign(priv);
}

/** Drive the attacker's org IdP through start→complete with a victim-email id_token. */
async function attemptTakeover(victimEmail: string, extraClaims: Record<string, unknown> = {}, defaultRoleKey = "standard_user") {
  const [idp] = await p.db.withSystem("test.idp", (tx) =>
    tx.insert(identityProviders).values({
      organizationId: attackerOrg.org.id, protocol: "oidc", name: uniq("rogue-idp"), status: "active",
      config: { issuer: ISSUER, clientId: "attacker-client", scopes: ["openid", "email"], authorizationEndpoint: `${ISSUER}/auth`, tokenEndpoint: TOKEN_ENDPOINT, jwksUri: JWKS_URI },
      domains: [], jitProvisioning: true, defaultRoleKey,
    }).returning(),
  );
  const sso0 = ssoWith((async () => new Response("{}")) as unknown as typeof fetch);
  const { state } = await sso0.startLogin(idp!.id); // signed state + nonce the attacker now holds
  const nonce = JSON.parse(Buffer.from(state.split(".")[0]!, "base64url").toString()).nonce as string;
  const idToken = await mintIdToken({ email: victimEmail, email_verified: true, ...extraClaims }, nonce);
  const sso = ssoWith(await attackerFetch(idToken));
  return sso.completeOidc({ code: "attacker-code", state: sha256(state), stateCookie: state }, meta());
}

beforeAll(async () => {
  p = await createTestPlatform();
  ({ privateKey: priv, publicKey: pub } = await generateKeyPair("ES256"));
  victimOrg = await createOrg(p);
  attackerOrg = await createOrg(p);
  // A pre-existing victim with a password account and their own org.
  victim = await createUser(p, { email: `victim-${uniq()}@victim-corp.example` });
  await p.db.withSystem("test.victim_member", (tx) => tx.insert(memberships).values({ organizationId: victimOrg.org.id, userId: victim.id, status: "active", joinedAt: new Date() }));
});
afterAll(() => p.close());

describe("SSO JIT provisioning must not take over existing accounts", () => {
  it("refuses to issue a session as a pre-existing user whose email domain the org has not proven it owns", async () => {
    // SECURE expectation: the rogue IdP cannot authenticate as the victim.
    await expect(attemptTakeover(victim.email)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|UNAUTHENTICATED|VALIDATION_FAILED/) });

    // And no membership for the victim should have been created in the attacker's org.
    const linked = await p.db.withSystem("test.check", (tx) => tx.select().from(memberships).where(eq(memberships.userId, victim.id)));
    expect(linked.some((m) => m.organizationId === attackerOrg.org.id)).toBe(false);
  });

  it("if a session is somehow issued, it must not be able to pivot into the victim's real organization", async () => {
    // Demonstrates blast radius: whatever session the takeover yields must not reach victimOrg.
    let token: string | null = null;
    try {
      token = (await attemptTakeover(victim.email)).token;
    } catch {
      return; // takeover refused — covered by the test above
    }
    await expect(p.auth.switchOrganization(token, victimOrg.org.id, meta())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an empty domains list must not mean 'accept every email domain'", async () => {
    // Even for a brand-new email, an org with no configured domains should not JIT-provision arbitrary domains.
    const outsiderEmail = `outsider-${uniq()}@someone-elses-domain.example`;
    await expect(attemptTakeover(outsiderEmail)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|VALIDATION_FAILED/) });
  });

  it("JIT provisioning must not grant a privileged role chosen in the IdP config (defaultRoleKey escalation)", async () => {
    // An IdP configured with defaultRoleKey "org_admin" must not mint org_admin accounts.
    const freshEmail = `jit-escalate-${uniq()}@someone-elses-domain.example`;
    try {
      await attemptTakeover(freshEmail, {}, "org_admin");
    } catch {
      return; // refused at sign-in — also a secure outcome
    }
    const member = (await p.organizations.listMembers(attackerOrg.adminCtx())).find((m) => m.email === freshEmail);
    expect(member?.roles.map((r) => r.key) ?? []).not.toContain("org_admin");
  });

  it("control: a genuine member of the IdP's org with a matching, owned domain can sign in", async () => {
    // This should PASS today and after the fix: legitimate SSO still works.
    const member = await createUser(p, { email: `employee-${uniq()}@attacker-org-domain.example` });
    await p.db.withSystem("test.member", (tx) => tx.insert(memberships).values({ organizationId: attackerOrg.org.id, userId: member.id, status: "active", joinedAt: new Date() }));
    const [idp] = await p.db.withSystem("test.idp", (tx) =>
      tx.insert(identityProviders).values({
        organizationId: attackerOrg.org.id, protocol: "oidc", name: uniq("idp"), status: "active",
        config: { issuer: ISSUER, clientId: "attacker-client", scopes: ["openid", "email"], authorizationEndpoint: `${ISSUER}/auth`, tokenEndpoint: TOKEN_ENDPOINT, jwksUri: JWKS_URI },
        domains: ["attacker-org-domain.example"], jitProvisioning: false, defaultRoleKey: "standard_user",
      }).returning(),
    );
    const sso0 = ssoWith((async () => new Response("{}")) as unknown as typeof fetch);
    const { state } = await sso0.startLogin(idp!.id);
    const nonce = JSON.parse(Buffer.from(state.split(".")[0]!, "base64url").toString()).nonce as string;
    const idToken = await mintIdToken({ email: member.email, email_verified: true }, nonce);
    const sso = ssoWith(await attackerFetch(idToken));
    const r = await sso.completeOidc({ code: "c", state: sha256(state), stateCookie: state }, meta());
    expect(r.organizationId).toBe(attackerOrg.org.id);
  });
});
