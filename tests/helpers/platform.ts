import { randomBytes, randomUUID } from "node:crypto";
import { createPlatform, loadEnv, type Platform, type PlatformOverrides } from "../../packages/platform/src";
import { MODULE_DEFINITIONS } from "../../packages/module-catalog/src";
import { MemorySink } from "../../packages/observability/src";
import { hashPassword } from "../../packages/security/src";
import { eq, memberships, users } from "../../packages/db/src";
import { type TenantContext } from "../../packages/shared-types/src";
import { TEST_APP_URL } from "./env";

export const TEST_ENV = {
  APP_ENV: "test",
  APP_URL: "http://localhost:3000",
  APP_SECRET: "test-app-secret-that-is-at-least-32-chars-long",
  DATABASE_URL: TEST_APP_URL,
  SECRETS_PROVIDER: "local",
  LOCAL_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOW_SELF_SERVE_SIGNUP: "true",
  LOG_LEVEL: "error",
};

export async function createTestPlatform(overrides: PlatformOverrides = {}, envOverrides: Record<string, string> = {}): Promise<Platform & { logs: MemorySink }> {
  const logs = new MemorySink();
  const platform = createPlatform(loadEnv({ ...TEST_ENV, ...envOverrides }), {
    logSink: logs,
    resolveTxt: async () => [],
    urlGuard: { resolve: async () => ["93.184.216.34"] },
    modules: MODULE_DEFINITIONS,
    ...overrides,
  });
  await platform.bootstrap();
  return Object.assign(platform, { logs });
}

export const uniq = (p = "t") => `${p}-${randomBytes(4).toString("hex")}`;
export const PASSWORD = "correct-horse-battery-staple";

let cachedHash: string | undefined;
export async function createUser(p: Platform, opts: { email?: string; name?: string; platformAdmin?: boolean } = {}) {
  cachedHash ??= await hashPassword(PASSWORD);
  const email = opts.email ?? `${uniq("user")}@example.com`;
  const [u] = await p.db.withSystem("test.create_user", (tx) =>
    tx.insert(users).values({ email, name: opts.name ?? email.split("@")[0]!, passwordHash: cachedHash!, status: "active", isPlatformAdmin: !!opts.platformAdmin }).returning(),
  );
  return u!;
}

export function meta() {
  return { correlationId: randomUUID(), ip: "203.0.113.10", userAgent: "vitest" };
}

export function userCtx(organizationId: string, user: { id: string; email: string; isPlatformAdmin?: boolean }): TenantContext {
  return { organizationId, actor: { type: "user", id: user.id, label: user.email, isPlatformAdmin: user.isPlatformAdmin }, ...meta(), cache: new Map() };
}

export function systemCtx(organizationId: string): TenantContext {
  return { organizationId, actor: { type: "system", id: "test", label: "system:test" }, ...meta(), cache: new Map() };
}

/** Org with an admin user (org_admin) — returns ctx factories. */
export async function createOrg(p: Platform, name = uniq("org")) {
  const admin = await createUser(p);
  const org = await p.organizations.create({ actor: { type: "system", id: "test", label: "system:test" }, correlationId: randomUUID() }, { name, slug: name, adminUserId: admin.id });
  return { org, admin, adminCtx: () => userCtx(org.id, admin) };
}

/** Add a member with the given system role(s) to an org. */
export async function addMember(p: Platform, organizationId: string, roleKeys: string[], user?: { id: string; email: string }) {
  const u = user ?? (await createUser(p));
  const [m] = await p.db.withSystem("test.add_member", (tx) => tx.insert(memberships).values({ organizationId, userId: u.id, status: "active", joinedAt: new Date() }).returning());
  for (const k of roleKeys) await p.rbac.roles.grantInternal(systemCtx(organizationId), m!.id, k);
  return { user: u, membership: m!, ctx: () => userCtx(organizationId, u) };
}

export async function membershipOf(p: Platform, organizationId: string, userId: string) {
  const [m] = await p.db.withSystem("test.membership", (tx) => tx.select().from(memberships).where(eq(memberships.userId, userId)));
  return m!.organizationId === organizationId ? m! : undefined;
}

export async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (e) {
    const actual = (e as { code?: string }).code;
    if (actual !== code) throw new Error(`Expected error code ${code} but got ${actual ?? (e as Error).message}`);
    return e;
  }
  throw new Error(`Expected error code ${code} but the call succeeded`);
}
