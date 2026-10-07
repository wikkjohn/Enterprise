import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Platform } from "../../packages/platform/src";
import { addMember, createOrg, createTestPlatform, meta, PASSWORD, systemCtx, uniq } from "../helpers/platform";

/**
 * SECURITY: separation-of-duties (SoD) bypass via the invitation path.
 *
 * SoD constraints (auditor ⊥ org_admin, auditor ⊥ security_admin) are enforced
 * only in roles.assign(). The invitation path grants each role via the
 * check-free grantInternal, so an org_admin can hand out a conflicting role
 * pair in a single invitation. The test asserts the SECURE outcome and so
 * FAILS today.
 */
type P = Platform;
let p: P;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("Separation of duties holds across every grant path", () => {
  it("assign() blocks a conflicting role pair (control — passes today)", async () => {
    const m = await addMember(p, O.org.id, ["auditor"]);
    await expect(p.rbac.roles.assign(O.adminCtx(), { membershipId: m.membership.id, roleKey: "org_admin" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("an invitation cannot grant auditor + org_admin together", async () => {
    const email = `sod-${uniq()}@example.com`;
    // Creating the invitation is refused outright (CONFLICT); even if a conflicting
    // invitation were somehow created, acceptance must not grant both roles.
    let token: string | null = null;
    try {
      token = (await p.organizations.invite(O.adminCtx(), { email, roleKeys: ["auditor", "org_admin"] })).token;
    } catch (e) {
      expect((e as { code?: string }).code).toBe("CONFLICT");
      return; // secure: the conflicting invitation was rejected
    }
    try {
      await p.auth.acceptInvitation({ token, name: "SoD Victim", password: PASSWORD }, meta());
    } catch {
      return; // secure: acceptance refused the conflicting pair
    }
    const member = (await p.organizations.listMembers(O.adminCtx())).find((x) => x.email === email)!;
    const keys = member.roles.map((r) => r.key);
    expect(keys.includes("auditor") && keys.includes("org_admin")).toBe(false);
  });

  it("grantInternal (invitation/JIT path) also enforces separation of duties", async () => {
    // Defense in depth: even bypassing invite(), the low-level grant refuses the second conflicting role.
    const m = await addMember(p, O.org.id, ["auditor"]);
    const sys = systemCtx(O.org.id);
    await expect(p.rbac.roles.grantInternal(sys, m.membership.id, "org_admin")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
