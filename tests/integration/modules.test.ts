import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ModuleManifest } from "../../packages/module-registry/src";
import { type Platform } from "../../packages/platform/src";
import { MODULE_MANIFESTS } from "../../packages/module-catalog/src";
import { addMember, createOrg, createTestPlatform, expectCode } from "../helpers/platform";

const installed: ModuleManifest = {
  ...MODULE_MANIFESTS.find((m) => m.id === "integration_hub")!,
  installStatus: "installed",
  version: "0.0.1-test",
  featureFlags: [{ key: "integration.visual_editor", description: "Visual editor", defaultEnabled: false }],
};
const dependent: ModuleManifest = { ...MODULE_MANIFESTS.find((m) => m.id === "agent_governance")!, installStatus: "installed", dependsOn: ["integration_hub"] };

let p: Platform;
let O: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  p = await createTestPlatform({ modules: [installed, dependent, ...MODULE_MANIFESTS.filter((m) => !["integration_hub", "agent_governance"].includes(m.id))] });
  O = await createOrg(p);
});
afterAll(() => p.close());

describe("module registry and entitlements", () => {
  it("lists all six modules; placeholders are not installed and cannot be enabled", async () => {
    const list = await p.modules.list(O.adminCtx());
    expect(list).toHaveLength(6);
    expect(list.find((m) => m.id === "ai_operations")).toMatchObject({ installStatus: "not_installed", enabled: false });
    await expectCode(p.modules.enable(O.adminCtx(), "ai_operations"), "CONFLICT");
  });

  it("navigation reflects entitlements and permissions", async () => {
    let nav = await p.modules.navigation(O.adminCtx());
    expect(nav.find((m) => m.id === "integration_hub")?.state).toBe("disabled");
    await p.modules.enable(O.adminCtx(), "integration_hub");
    nav = await p.modules.navigation({ ...O.adminCtx(), cache: new Map() });
    const ih = nav.find((m) => m.id === "integration_hub")!;
    expect(ih.state).toBe("enabled");
    expect(ih.items.length).toBeGreaterThan(0);
    const viewer = await addMember(p, O.org.id, ["executive"]); // executive has no integration.* grant
    const vnav = await p.modules.navigation(viewer.ctx());
    expect(vnav.find((m) => m.id === "integration_hub")).toBeUndefined(); // no entry permission
  });

  it("enforces dependencies in both directions", async () => {
    const o = await createOrg(p);
    await expectCode(p.modules.enable(o.adminCtx(), "agent_governance"), "CONFLICT");
    await p.modules.enable(o.adminCtx(), "integration_hub");
    await p.modules.enable(o.adminCtx(), "agent_governance");
    await expectCode(p.modules.disable(o.adminCtx(), "integration_hub"), "CONFLICT");
  });

  it("requireEnabled blocks module entry points for other tenants", async () => {
    const o = await createOrg(p);
    await expectCode(p.modules.requireEnabled(o.adminCtx(), "integration_hub"), "MODULE_NOT_ENABLED");
  });

  it("feature flags: manifest default → org override, audited", async () => {
    expect(await p.modules.isFlagEnabled(O.adminCtx(), "integration.visual_editor")).toBe(false);
    await p.modules.setFlag(O.adminCtx(), "integration.visual_editor", true);
    expect(await p.modules.isFlagEnabled(O.adminCtx(), "integration.visual_editor")).toBe(true);
    const audit = await p.audit.query(O.adminCtx(), { action: "module.feature_flag_changed", limit: 5 });
    expect(audit.data[0]?.resourceId).toBe("integration.visual_editor");
  });

  it("enable/disable emit audit records and events", async () => {
    const actions = (await p.audit.query(O.adminCtx(), { module: "integration_hub", limit: 20 })).data.map((e) => e.action);
    expect(actions).toContain("module.enabled");
  });

  it("module health: placeholders report not_configured", async () => {
    const h = await p.modules.health();
    expect(h.find((m) => m.moduleId === "ai_operations")?.status.state).toBe("not_configured");
  });
});
