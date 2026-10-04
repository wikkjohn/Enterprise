import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Platform } from "../../packages/platform/src";
import { type ModuleManifest } from "../../packages/module-registry/src";
import { MODULE_MANIFESTS } from "../../packages/platform/src";
import { addMember, createOrg, createTestPlatform, expectCode, meta } from "../helpers/platform";

const testModule: ModuleManifest = {
  id: "workflow_intelligence",
  name: "Test Workflow Module",
  shortName: "Test WF",
  description: "Installed test double used to exercise entitlement-aware RBAC.",
  version: "0.0.1",
  installStatus: "installed",
  icon: "Workflow",
  basePath: "/m/workflow-intelligence",
  permissions: [
    { key: "workflow.read", description: "read" },
    { key: "workflow.manage", description: "manage", risk: "high" },
  ],
  roleGrants: { analyst: ["workflow.read"] },
  navigation: [{ label: "Dashboard", href: "/", permission: "workflow.read" }],
};

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform({ modules: [testModule, ...MODULE_MANIFESTS.filter((m) => m.id !== "workflow_intelligence")] });
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("system roles and least privilege", () => {
  it("org_admin holds every core permission but never platform.admin", async () => {
    const perms = await p.rbac.authorizer.list(O.adminCtx());
    expect(perms).toContain("role.manage");
    expect(perms).toContain("connector.credential.manage");
    expect(perms).not.toContain("platform.admin");
  });

  it("standard users cannot administer anything, even via direct service calls", async () => {
    const u = await addMember(p, O.org.id, ["standard_user"]);
    await expectCode(p.connectors.create(u.ctx(), { type: "sandbox", name: "x", authType: "none", config: {} }), "FORBIDDEN");
    await expectCode(p.organizations.invite(u.ctx(), { email: "x@example.com", roleKeys: ["read_only"] }), "FORBIDDEN");
    await expectCode(p.audit.query(u.ctx(), { limit: 10 }).then(async () => p.rbac.authorizer.require(u.ctx(), "audit.read")), "FORBIDDEN");
    await expectCode(p.modules.enable(u.ctx(), "workflow_intelligence"), "FORBIDDEN");
    await expectCode(p.apiKeys.create(u.ctx(), { name: "k", scopes: ["org.read"] }), "FORBIDDEN");
  });

  it("auditor is read-only", async () => {
    const a = await addMember(p, O.org.id, ["auditor"]);
    expect(await p.rbac.authorizer.can(a.ctx(), "audit.read")).toBe(true);
    expect(await p.rbac.authorizer.can(a.ctx(), "policy.manage")).toBe(false);
    expect(await p.rbac.authorizer.can(a.ctx(), "connector.manage")).toBe(false);
  });

  it("permission denials are audited", async () => {
    const u = await addMember(p, O.org.id, ["read_only"]);
    await expectCode(p.rbac.authorizer.require(u.ctx(), "connector.manage"), "FORBIDDEN");
    await new Promise((r) => setTimeout(r, 50));
    const log = await p.audit.query(O.adminCtx(), { action: "rbac.permission_denied", actorId: u.user.id, limit: 10 });
    expect(log.data[0]?.metadata).toMatchObject({ permission: "connector.manage" });
  });
});

describe("module permissions and entitlements", () => {
  it("module permissions are denied until the module is enabled", async () => {
    const analyst = await addMember(p, O.org.id, ["analyst"]);
    await expectCode(p.rbac.authorizer.require(analyst.ctx(), "workflow.read"), "MODULE_NOT_ENABLED");
    await p.modules.enable(O.adminCtx(), "workflow_intelligence");
    expect(await p.rbac.authorizer.can(analyst.ctx(), "workflow.read")).toBe(true); // via roleGrants
    expect(await p.rbac.authorizer.can(analyst.ctx(), "workflow.manage")).toBe(false);
    await p.modules.disable(O.adminCtx(), "workflow_intelligence");
    expect(await p.rbac.authorizer.can({ ...analyst.ctx(), cache: new Map() }, "workflow.read")).toBe(false);
  });

  it("module-scoped grants apply only to that module's permissions", async () => {
    await p.modules.enable(O.adminCtx(), "workflow_intelligence");
    await p.rbac.roles.createRole(O.adminCtx(), { key: "wf_editor", name: "WF editor", permissions: ["workflow.manage", "connector.manage"] });
    const m = await addMember(p, O.org.id, ["read_only"]);
    await p.rbac.roles.assign(O.adminCtx(), { membershipId: m.membership.id, roleKey: "wf_editor", scopeType: "module", scopeId: "workflow_intelligence" });
    expect(await p.rbac.authorizer.can(m.ctx(), "workflow.manage")).toBe(true);
    expect(await p.rbac.authorizer.can(m.ctx(), "connector.manage")).toBe(false); // core perm is not in the module scope
  });

  it("resource-scoped grants apply only to that resource", async () => {
    const c1 = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "scoped-1", authType: "none", config: {} });
    const c2 = await p.connectors.create(O.adminCtx(), { type: "sandbox", name: "scoped-2", authType: "none", config: {} });
    await p.rbac.roles.createRole(O.adminCtx(), { key: "connector_operator", name: "Connector operator", permissions: ["connector.use", "connector.read"] });
    const m = await addMember(p, O.org.id, []);
    await p.rbac.roles.assign(O.adminCtx(), { membershipId: m.membership.id, roleKey: "connector_operator", scopeType: "resource", scopeId: `connector:${c1.id}` });
    const out = await p.connectors.execute(m.ctx(), c1.id, { capability: "records.list", operation: "list" });
    expect(out).toMatchObject({ simulated: true });
    await expectCode(p.connectors.execute(m.ctx(), c2.id, { capability: "records.list", operation: "list" }), "FORBIDDEN");
  });
});

describe("role management safeguards", () => {
  it("prevents privilege escalation: cannot create or grant roles with permissions you lack", async () => {
    await p.rbac.roles.createRole(O.adminCtx(), { key: "role_mgr", name: "Role manager", permissions: ["role.manage", "role.read", "org.read"] });
    const rm = await addMember(p, O.org.id, ["read_only"]);
    await p.rbac.roles.assign(O.adminCtx(), { membershipId: rm.membership.id, roleKey: "role_mgr" });
    await expectCode(p.rbac.roles.createRole(rm.ctx(), { key: "sneaky", name: "Sneaky", permissions: ["apikey.manage"] }), "FORBIDDEN");
    const victim = await addMember(p, O.org.id, []);
    await expectCode(p.rbac.roles.assign(rm.ctx(), { membershipId: victim.membership.id, roleKey: "org_admin" }), "FORBIDDEN");
  });

  it("users cannot change their own roles", async () => {
    const members = await p.organizations.listMembers(O.adminCtx());
    const self = members.find((m) => m.userId === O.admin.id)!;
    await expectCode(p.rbac.roles.assign(O.adminCtx(), { membershipId: self.membershipId, roleKey: "auditor" }), "FORBIDDEN");
  });

  it("enforces separation of duties (auditor ⟂ org_admin)", async () => {
    const m = await addMember(p, O.org.id, ["auditor"]);
    await expectCode(p.rbac.roles.assign(O.adminCtx(), { membershipId: m.membership.id, roleKey: "org_admin" }), "CONFLICT");
  });

  it("keeps at least one organization administrator", async () => {
    const solo = await createOrg(p);
    const second = await addMember(p, solo.org.id, ["org_admin"]);
    const adminRoleOf = async (userId: string) =>
      (await p.organizations.listMembers(second.ctx())).find((m) => m.userId === userId)!.roles.find((r) => r.key === "org_admin")!;
    await p.rbac.roles.revoke(second.ctx(), (await adminRoleOf(solo.admin.id)).id); // fine: `second` is still an admin
    await p.rbac.roles.createRole(second.ctx(), { key: "role_mgr2", name: "Role manager", permissions: ["role.manage", "role.read", "user.read", "org.read"] });
    const mgr = await addMember(p, solo.org.id, []);
    await p.rbac.roles.assign(second.ctx(), { membershipId: mgr.membership.id, roleKey: "role_mgr2" });
    await expectCode(p.rbac.roles.revoke(mgr.ctx(), (await adminRoleOf(second.user.id)).id), "CONFLICT");
  });

  it("system roles are immutable", async () => {
    await expectCode(p.rbac.roles.updateRolePermissions(O.adminCtx(), "analyst", ["org.read"]), "FORBIDDEN");
    await expectCode(p.rbac.roles.deleteRole(O.adminCtx(), "org_admin"), "FORBIDDEN");
    await expectCode(p.rbac.roles.createRole(O.adminCtx(), { key: "org_admin", name: "x", permissions: [] }), "CONFLICT");
  });

  it("API keys carry only delegated scopes, never non-delegable ones", async () => {
    await expectCode(p.apiKeys.create(O.adminCtx(), { name: "bad", scopes: ["role.manage"] }), "FORBIDDEN");
    const { key } = await p.apiKeys.create(O.adminCtx(), { name: "reader", scopes: ["connector.read"] });
    const a = await p.apiKeys.authenticate(key);
    const ctx = { organizationId: a!.organizationId, actor: a!.actor, ...meta(), cache: new Map() };
    expect(await p.rbac.authorizer.can(ctx, "connector.read")).toBe(true);
    expect(await p.rbac.authorizer.can(ctx, "connector.manage")).toBe(false);
  });

  it("suspending a member removes all access immediately", async () => {
    const m = await addMember(p, O.org.id, ["org_admin"]);
    expect(await p.rbac.authorizer.can(m.ctx(), "org.read")).toBe(true);
    await p.organizations.setMemberStatus(O.adminCtx(), m.membership.id, "suspended");
    expect(await p.rbac.authorizer.can(m.ctx(), "org.read")).toBe(false);
  });

  it("suspended organizations deny everything", async () => {
    const s = await createOrg(p);
    const pa = { actor: { type: "user" as const, id: "pa", label: "pa", isPlatformAdmin: true }, correlationId: "c" };
    await p.organizations.setStatus(pa, s.org.id, "suspended");
    await expectCode(p.connectors.list(s.adminCtx()), "ORGANIZATION_SUSPENDED");
  });
});
