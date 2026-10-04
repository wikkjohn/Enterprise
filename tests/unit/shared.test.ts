import { describe, expect, it } from "vitest";
import { AppError, decodeCursor, encodeCursor, isUuid } from "../../packages/shared-types/src";
import { createMetrics, sanitizeCorrelationId } from "../../packages/observability/src";
import { PermissionRegistry, CORE_PERMISSIONS, SYSTEM_ROLES } from "../../packages/rbac/src";
import { MODULE_MANIFESTS } from "../../packages/platform/src";
import { ModuleRegistry } from "../../packages/module-registry/src";

describe("shared types", () => {
  it("cursor round-trip and tamper resistance", () => {
    const c = encodeCursor({ t: "2026-01-01T00:00:00.000Z", id: "abc" });
    expect(decodeCursor(c)).toEqual({ t: "2026-01-01T00:00:00.000Z", id: "abc" });
    expect(decodeCursor("not-base64-json")).toBeUndefined();
  });
  it("AppError carries status and code", () => {
    const e = new AppError("RATE_LIMITED");
    expect(e.status).toBe(429);
    expect(AppError.is(e, "RATE_LIMITED")).toBe(true);
    expect(isUuid("00000000-0000-4000-8000-000000000000")).toBe(true);
  });
  it("correlation ids from clients are sanitised", () => {
    expect(sanitizeCorrelationId("abc12345-xyz")).toBe("abc12345-xyz");
    expect(sanitizeCorrelationId("<script>")).not.toBe("<script>");
  });
  it("metrics render Prometheus text", () => {
    const m = createMetrics();
    m.increment("eaop_test_total", { a: "1" });
    m.observe("eaop_test_ms", 42);
    const text = m.toPrometheus();
    expect(text).toContain('eaop_test_total{a="1"} 1');
    expect(text).toContain("eaop_test_ms_count 1");
  });
});

describe("permission registry and system roles", () => {
  it("every system role expands to registered permissions; org_admin excludes platform.admin", () => {
    const r = new PermissionRegistry();
    r.register("core", CORE_PERMISSIONS);
    for (const role of SYSTEM_ROLES) expect(() => r.expand(role.permissions), role.key).not.toThrow();
    const admin = r.expand(SYSTEM_ROLES.find((x) => x.key === "org_admin")!.permissions);
    expect(admin).not.toContain("platform.admin");
    expect(admin).toContain("role.manage");
  });
  it("rejects malformed and conflicting permission keys", () => {
    const r = new PermissionRegistry();
    expect(() => r.register("core", [{ key: "Bad Key", description: "" }])).toThrow();
    r.register("core", [{ key: "x.read", description: "" }]);
    expect(() => r.register("workflow_intelligence", [{ key: "x.read", description: "" }])).toThrow(/already registered/);
  });
});

describe("module placeholders", () => {
  it("six placeholders, unique ids/paths, namespaced permissions, all not_installed", () => {
    expect(MODULE_MANIFESTS).toHaveLength(6);
    const reg = new ModuleRegistry();
    MODULE_MANIFESTS.forEach((m) => reg.add(m));
    expect(new Set(MODULE_MANIFESTS.map((m) => m.basePath)).size).toBe(6);
    expect(MODULE_MANIFESTS.every((m) => m.installStatus === "not_installed")).toBe(true);
    const r = new PermissionRegistry();
    r.register("core", CORE_PERMISSIONS);
    for (const m of MODULE_MANIFESTS) expect(() => r.register(m.id, m.permissions)).not.toThrow();
  });
  it("modules cannot claim core permission namespaces", () => {
    const reg = new ModuleRegistry();
    expect(() => reg.add({ ...MODULE_MANIFESTS[0]!, permissions: [{ key: "org.manage", description: "" }] })).toThrow(/core namespace/);
  });
});
