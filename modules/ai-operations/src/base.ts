import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type AuditService } from "@eaop/audit";
import { scopeOf, sql, type Database, type Tx } from "@eaop/db";
import { type EventBus } from "@eaop/events";
import { type JobQueue } from "@eaop/jobs";
import { type ModuleService } from "@eaop/module-registry";
import { type NotificationService } from "@eaop/notifications";
import { type Logger } from "@eaop/observability";
import { type InsightRegistry } from "@eaop/platform";
import { type Authorizer } from "@eaop/rbac";
import { AppError, isUuid, notFound, SYSTEM_ACTOR, type TenantContext } from "@eaop/shared-types";

export const MODULE_ID = "ai_operations" as const;
export const BASE = "/m/ai-operations";
export const DAILY_JOB = "ai_operations.daily";

export interface AiOpsDeps {
  db: Database;
  authorizer: Authorizer;
  audit: AuditService;
  bus: EventBus;
  notifications: NotificationService;
  jobs: JobQueue;
  modules: Pick<ModuleService, "isEnabled">;
  insights: Pick<InsightRegistry, "collect">;
  logger: Logger;
}

export type Perm =
  | "ai_ops.read" | "ai_ops.tool.manage" | "ai_ops.vendor.manage" | "ai_ops.cost.read" | "ai_ops.cost.manage"
  | "ai_ops.adoption.read" | "ai_ops.training.manage" | "ai_ops.request.manage" | "ai_ops.admin";

export function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new AppError("VALIDATION_FAILED", r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "input"}: ${r.error.issues[0].message}` : "Request validation failed.", {
    issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

export const text = (max: number) => z.string().trim().max(max);
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const usdAmount = z.number().finite().min(0).max(1e10);
export const uuidish = z.string().uuid();

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function makeBase(deps: AiOpsDeps) {
  const { db, authorizer, audit } = deps;
  const tenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => db.withTenant(scopeOf(ctx), fn);
  const orgScope = <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => db.withTenant({ organizationId: orgId }, fn);
  const org = (ctx: TenantContext) => ctx.organizationId;
  const userId = (ctx: TenantContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);
  const require = (ctx: TenantContext, p: Perm) => authorizer.require(ctx, p);
  const can = (ctx: TenantContext, p: Perm) => authorizer.can(ctx, p);
  /** First permission that passes, else the error of the first. */
  async function requireAny(ctx: TenantContext, perms: Perm[]) {
    for (const p of perms) if (await authorizer.can(ctx, p)) return p;
    await authorizer.require(ctx, perms[0]!);
    return perms[0]!;
  }
  const record = (ctx: TenantContext, action: string, resourceType: string, resourceId: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown>; outcome?: "success" | "failure" | "denied" } = {}) =>
    audit.record(ctx, { module: MODULE_ID, action, resourceType, resourceId, ...extra });
  const sysCtx = (orgId: string): TenantContext => ({ organizationId: orgId, actor: SYSTEM_ACTOR(MODULE_ID), correlationId: randomUUID(), cache: new Map() });
  const uuidOr404 = (id: string, what: string) => {
    if (!isUuid(id)) throw notFound(what, id);
  };
  async function assertMember(tx: Tx, orgId: string, uid: string | null | undefined, field: string) {
    if (!uid) return;
    const r = await tx.execute(sql`select 1 from memberships where organization_id = ${orgId} and user_id = ${uid} and status = 'active' limit 1`);
    if (!r.rows.length) throw new AppError("VALIDATION_FAILED", `${field} must be an active member of this organization.`);
  }
  /** Active members by id or email → user ids (unknown ones reported back). */
  async function resolveMembers(tx: Tx, orgId: string, refs: string[]) {
    const isId = (r: string): boolean => isUuid(r);
    const ids = refs.filter(isId);
    const emails = refs.filter((r) => !isId(r)).map((r) => r.trim().toLowerCase());
    const rows = (await tx.execute(sql`
      select u.id, lower(u.email) as email, u.name, m.department from memberships m join users u on u.id = m.user_id
      where m.organization_id = ${orgId} and m.status = 'active' and (u.id = any(${`{${ids.join(",")}}`}::uuid[]) or lower(u.email) = any(${`{${emails.map((e) => `"${e.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]))`)).rows as Array<{ id: string; email: string; name: string; department: string | null }>;
    const found = new Set(rows.flatMap((r) => [r.id, r.email]));
    return { members: rows, unknown: refs.filter((r) => !found.has(isId(r) ? r : r.trim().toLowerCase())) };
  }
  return { deps, tenant, orgScope, org, userId, require, can, requireAny, record, sysCtx, uuidOr404, assertMember, resolveMembers };
}

export type Base = ReturnType<typeof makeBase>;
