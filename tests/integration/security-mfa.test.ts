import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "../../packages/security/src";
import { createOrg, createTestPlatform, expectCode, meta, PASSWORD } from "../helpers/platform";

/**
 * SECURITY finding #8 (fixed): MFA (TOTP) verification had no per-account/per-session
 * brute-force lockout — only a per-IP request limit, bypassable by a distributed or
 * X-Forwarded-For-spoofing attacker. verifyMfa now counts failures on the pending
 * session and revokes it after a cap, independently of IP.
 */
type P = Awaited<ReturnType<typeof createTestPlatform>>;
let p: P;
let O: Awaited<ReturnType<typeof createOrg>>;

async function enrollMfa(userId: string) {
  const { secret } = await p.auth.beginMfaEnrollment(userId);
  await p.auth.confirmMfaEnrollment(userId, totpCode(secret), meta());
  return secret;
}

beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("MFA verification is rate-limited per session", () => {
  it("locks the pending session after repeated invalid codes, then accepts no code", async () => {
    const secret = await enrollMfa(O.admin.id);
    const login = await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta());
    expect(login.status).toBe("mfa_required");
    // Five wrong codes exhaust the per-session budget and revoke the pending session.
    for (let i = 0; i < 5; i++) await expectCode(p.auth.verifyMfa(login.token, "000000", meta()), "UNAUTHENTICATED");
    // Even the correct code now fails: the session is gone and the user must sign in again.
    await expectCode(p.auth.verifyMfa(login.token, totpCode(secret), meta()), "UNAUTHENTICATED");
  });

  it("a correct code within the budget still completes MFA (control)", async () => {
    const member = await createOrg(p); // fresh user/org
    const secret = await enrollMfa(member.admin.id);
    const login = await p.auth.login({ email: member.admin.email, password: PASSWORD }, meta());
    await p.auth.verifyMfa(login.token, "111111", meta()).catch(() => undefined); // one wrong attempt
    await p.auth.verifyMfa(login.token, totpCode(secret), meta()); // correct — must succeed
    const resolved = await p.auth.resolve(login.token, meta());
    expect(resolved?.tenant?.organizationId).toBe(member.org.id);
  });
});
