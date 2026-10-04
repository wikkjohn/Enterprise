import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sessions, sql, users } from "../../packages/db/src";
import { type Platform } from "../../packages/platform/src";
import { totpCode } from "../../packages/security/src";
import { addMember, createOrg, createTestPlatform, createUser, expectCode, meta, PASSWORD } from "../helpers/platform";

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("password login and sessions", () => {
  it("logs in, resolves a tenant context, and stores only a token hash", async () => {
    const r = await p.auth.login({ email: O.admin.email.toUpperCase(), password: PASSWORD }, meta());
    expect(r.status).toBe("ok");
    const resolved = await p.auth.resolve(r.token, meta());
    expect(resolved?.tenant?.organizationId).toBe(O.org.id);
    const raw = await p.db.withSystem("t", (tx) => tx.execute(sql`select count(*)::int as n from sessions where token_hash = ${r.token}`));
    expect((raw.rows[0] as { n: number }).n).toBe(0);
  });

  it("returns the same generic error for unknown users and bad passwords", async () => {
    const e1 = (await expectCode(p.auth.login({ email: "nobody@example.com", password: "whatever-password" }, meta()), "UNAUTHENTICATED")) as Error;
    const e2 = (await expectCode(p.auth.login({ email: O.admin.email, password: "wrong-password-123" }, meta()), "UNAUTHENTICATED")) as Error;
    expect(e1.message).toBe(e2.message);
  });

  it("locks the account after repeated failures", async () => {
    const u = await createUser(p);
    await addMember(p, O.org.id, ["read_only"], u);
    for (let i = 0; i < 5; i++) await expectCode(p.auth.login({ email: u.email, password: "bad-password-xx" }, meta()), "UNAUTHENTICATED");
    const e = (await expectCode(p.auth.login({ email: u.email, password: PASSWORD }, meta()), "UNAUTHENTICATED")) as Error;
    expect(e.message).toMatch(/locked/);
  });

  it("logout revokes the session", async () => {
    const r = await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta());
    await p.auth.logout(r.token, meta());
    expect(await p.auth.resolve(r.token, meta())).toBeNull();
  });

  it("idle sessions expire per organization policy", async () => {
    const r = await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta());
    await p.db.withSystem("t", (tx) => tx.update(sessions).set({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(sessions.id, r.session.id)));
    expect(await p.auth.resolve(r.token, meta())).toBeNull();
  });

  it("deactivated users lose their sessions", async () => {
    const u = await createUser(p);
    await addMember(p, O.org.id, ["read_only"], u);
    const r = await p.auth.login({ email: u.email, password: PASSWORD }, meta());
    await p.db.withSystem("t", (tx) => tx.update(users).set({ status: "suspended" }).where(eq(users.id, u.id)));
    expect(await p.auth.resolve(r.token, meta())).toBeNull();
  });

  it("enforces IP allowlists from the organization security policy", async () => {
    const o = await createOrg(p);
    await p.organizations.updateSecurity(o.adminCtx(), { ipAllowlist: ["10.0.0.0/8"] });
    await expectCode(p.auth.login({ email: o.admin.email, password: PASSWORD }, { ...meta(), ip: "203.0.113.5" }), "FORBIDDEN");
    const ok = await p.auth.login({ email: o.admin.email, password: PASSWORD }, { ...meta(), ip: "10.1.2.3" });
    expect(ok.status).toBe("ok");
  });
});

describe("multi-factor authentication", () => {
  it("enrolls TOTP and requires the second factor at login", async () => {
    const u = await createUser(p);
    await addMember(p, O.org.id, ["read_only"], u);
    const { secret } = await p.auth.beginMfaEnrollment(u.id);
    await expectCode(p.auth.confirmMfaEnrollment(u.id, "000000", meta()), "VALIDATION_FAILED");
    await p.auth.confirmMfaEnrollment(u.id, totpCode(secret), meta());
    const [row] = await p.db.withSystem("t", (tx) => tx.select().from(users).where(eq(users.id, u.id)));
    expect(row!.mfaSecretRef).toMatch(/^secret:\/\/local\//); // a reference, never the seed
    const r = await p.auth.login({ email: u.email, password: PASSWORD }, meta());
    expect(r.status).toBe("mfa_required");
    expect(await p.auth.resolve(r.token, meta())).toBeNull(); // pending session has no access
    await expectCode(p.auth.verifyMfa(r.token, "123456", meta()), "UNAUTHENTICATED");
    await p.auth.verifyMfa(r.token, totpCode(secret), meta());
    expect((await p.auth.resolve(r.token, meta()))?.tenant?.organizationId).toBe(O.org.id);
  });

  it("flags MFA enrollment when the organization requires it", async () => {
    const o = await createOrg(p);
    await p.organizations.updateSecurity(o.adminCtx(), { mfaRequired: true });
    const r = await p.auth.login({ email: o.admin.email, password: PASSWORD }, meta());
    expect((await p.auth.resolve(r.token, meta()))?.mfaEnrollmentRequired).toBe(true);
  });
});

describe("invitations", () => {
  it("invites, accepts (new account), and grants the invited roles", async () => {
    const email = `invitee-${Date.now()}@example.com`;
    const inv = await p.organizations.invite(O.adminCtx(), { email, roleKeys: ["analyst"] });
    expect((await p.auth.describeInvitation(inv.token))?.organizationName).toBe(O.org.name);
    const r = await p.auth.acceptInvitation({ token: inv.token, name: "Invitee", password: "a-long-enough-passphrase" }, meta());
    const ctx = (await p.auth.resolve(r.token, meta()))!.tenant!;
    expect(await p.rbac.authorizer.can(ctx, "ai.use")).toBe(true);
    expect(await p.rbac.authorizer.can(ctx, "role.manage")).toBe(false);
    await expectCode(p.auth.acceptInvitation({ token: inv.token, name: "x", password: "a-long-enough-passphrase" }, meta()), "NOT_FOUND"); // single use
  });

  it("rejects weak passwords and revoked invitations", async () => {
    const inv = await p.organizations.invite(O.adminCtx(), { email: `weak-${Date.now()}@example.com`, roleKeys: ["read_only"] });
    await expectCode(p.auth.acceptInvitation({ token: inv.token, name: "x", password: "short" }, meta()), "VALIDATION_FAILED");
    await p.organizations.revokeInvitation(O.adminCtx(), inv.invitationId);
    await expectCode(p.auth.acceptInvitation({ token: inv.token, name: "x", password: "a-long-enough-passphrase" }, meta()), "NOT_FOUND");
  });

  it("enforces allowed email domains", async () => {
    const o = await createOrg(p);
    await p.organizations.updateSecurity(o.adminCtx(), { allowedEmailDomains: ["corp.example"] });
    await expectCode(p.organizations.invite(o.adminCtx(), { email: "x@gmail.com", roleKeys: ["read_only"] }), "VALIDATION_FAILED");
  });
});

describe("password reset", () => {
  it("never reveals whether an account exists", async () => {
    await expect(p.auth.requestPasswordReset("nobody@example.com", meta())).resolves.toBeUndefined();
  });
});

describe("organization switching", () => {
  it("switches between organizations the user belongs to", async () => {
    const other = await createOrg(p);
    await addMember(p, other.org.id, ["read_only"], O.admin);
    const r = await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta());
    await p.auth.switchOrganization(r.token, other.org.id, meta());
    expect((await p.auth.resolve(r.token, meta()))?.tenant?.organizationId).toBe(other.org.id);
  });
});
