/** Regression tests for defects found during documentation review. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Platform } from "../../packages/platform/src";
import { redact } from "../../packages/observability/src";
import { addMember, createOrg, createTestPlatform, expectCode, meta, PASSWORD } from "../helpers/platform";

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;
beforeAll(async () => {
  p = await createTestPlatform();
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("review fixes", () => {
  it("prompt retention 'none' keeps no hash or sizes", async () => {
    await p.organizations.updateRetention(O.adminCtx(), { aiPromptRetention: "none" });
    const r = await p.ai.execute(O.adminCtx(), { moduleId: "core", useCase: "test.none", messages: [{ role: "user", content: "secret" }], model: "sandbox-echo" });
    const run = await p.ai.getRun(O.adminCtx(), r.runId);
    expect(run).toMatchObject({ promptHash: null, request: null, response: null });
    await p.organizations.updateRetention(O.adminCtx(), { aiPromptRetention: "metadata" });
  });

  it("AI calls cannot be attributed to a module that is not enabled", async () => {
    await expectCode(p.ai.execute(O.adminCtx(), { moduleId: "agent_governance", useCase: "x.y", messages: [{ role: "user", content: "x" }], model: "sandbox-echo" }), "MODULE_NOT_ENABLED");
    await expectCode(p.ai.execute(O.adminCtx(), { moduleId: "made_up", useCase: "x.y", messages: [{ role: "user", content: "x" }], model: "sandbox-echo" }), "MODULE_NOT_ENABLED");
  });

  it("the last active administrator cannot be suspended or removed", async () => {
    const o = await createOrg(p);
    const other = await addMember(p, o.org.id, ["org_admin"]);
    const adminMembership = (await p.organizations.listMembers(other.ctx())).find((m) => m.userId === o.admin.id)!;
    await p.organizations.setMemberStatus(other.ctx(), adminMembership.membershipId, "suspended"); // ok: `other` remains
    const mgr = await addMember(p, o.org.id, ["security_admin"]); // has user.manage
    await expectCode(p.organizations.setMemberStatus(mgr.ctx(), other.membership.id, "suspended"), "CONFLICT");
  });

  it("session ids in audit metadata are kept; session tokens are redacted", async () => {
    expect(redact({ sessionId: "abc", sessionToken: "t", session_token: "t" })).toEqual({ sessionId: "abc", sessionToken: "[REDACTED]", session_token: "[REDACTED]" });
    await p.auth.login({ email: O.admin.email, password: PASSWORD }, meta());
    const ev = (await p.audit.query(O.adminCtx(), { action: "auth.login", limit: 1 })).data[0]!;
    expect(String(ev.metadata.sessionId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("webhook creation and deletion are audited", async () => {
    const { webhook } = await p.events.webhooks.create(O.adminCtx(), { url: "https://hooks.example/a", eventTypes: ["connector.created"] });
    await p.events.webhooks.remove(O.adminCtx(), webhook.id);
    const actions = (await p.audit.query(O.adminCtx(), { resourceId: webhook.id, limit: 10 })).data.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["webhook.created", "webhook.deleted"]));
  });

  it("SSO enforcement applies to the active organization on every request", async () => {
    const o = await createOrg(p);
    const r = await p.auth.login({ email: o.admin.email, password: PASSWORD }, meta());
    await p.organizations.updateSecurity(o.adminCtx(), { ssoEnforced: true });
    await expectCode(p.auth.resolve(r.token, meta()), "FORBIDDEN");
  });
});
