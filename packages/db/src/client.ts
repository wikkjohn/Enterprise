import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { AppError, isUuid, type Uuid } from "@eaop/shared-types";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The DB scope a transaction runs in. Mirrors the PostgreSQL GUCs read by RLS policies. */
export type DbScope =
  | { kind: "tenant"; organizationId: Uuid; userId?: Uuid }
  | { kind: "user"; userId: Uuid }
  | { kind: "system"; reason: string };

interface ActiveTx {
  tx: Tx;
  scope: DbScope;
  afterCommit: Array<() => void | Promise<void>>;
}

export interface Database {
  /** Raw pool — for health checks and migrations only. */
  readonly pool: pg.Pool;
  /**
   * Run `fn` in a transaction scoped to one tenant. RLS restricts every
   * tenant-owned table to rows of `organizationId`. Re-entrant: nested calls
   * for the same scope join the outer transaction.
   */
  withTenant<T>(scope: { organizationId: Uuid; userId?: Uuid }, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** User-scoped access (no active tenant): only the user's own memberships/sessions are visible. */
  withUser<T>(userId: Uuid, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Platform-level access that bypasses tenant RLS. Reserved for auth bootstrap,
   * organization provisioning, workers and migrations. Every call site must
   * pass a reason; calls are logged at debug level.
   */
  withSystem<T>(reason: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Run `fn` after the current transaction commits. Outside a transaction it
   * runs immediately; the returned promise settles when it has run (or, inside
   * a transaction, as soon as it is registered).
   */
  afterCommit(fn: () => void | Promise<void>): Promise<void>;
  /** Serialise a critical section across instances (transaction-scoped advisory lock). */
  lockKey: (name: string) => number;
  /** Current scope, if inside a transaction. */
  currentScope(): DbScope | undefined;
  close(): Promise<void>;
}

const als = new AsyncLocalStorage<ActiveTx>();

function sameScope(a: DbScope, b: DbScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tenant" && b.kind === "tenant") return a.organizationId === b.organizationId && (a.userId ?? null) === (b.userId ?? null);
  if (a.kind === "user" && b.kind === "user") return a.userId === b.userId;
  return a.kind === "system";
}

export interface CreateDatabaseOptions {
  connectionString: string;
  max?: number;
  onAfterCommitError?: (err: unknown) => void;
}

export function createDatabase(opts: CreateDatabaseOptions): Database {
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.max ?? 10 });
  const db = drizzle(pool, { schema });

  async function run<T>(scope: DbScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const active = als.getStore();
    if (active) {
      if (sameScope(active.scope, scope)) return fn(active.tx);
      // A different scope requires its own connection/transaction. Detach from the
      // outer ALS so the nested work cannot see or reuse the outer tenant's tx.
    }
    if (scope.kind === "tenant" && !isUuid(scope.organizationId)) throw new AppError("INTERNAL", "Invalid tenant scope.");
    const afterCommit: ActiveTx["afterCommit"] = [];
    const result = await db.transaction(async (tx) => {
      const orgId = scope.kind === "tenant" ? scope.organizationId : "";
      const userId = scope.kind === "tenant" ? (scope.userId ?? "") : scope.kind === "user" ? scope.userId : "";
      const system = scope.kind === "system" ? "on" : "";
      // set_config(..., true) is transaction-local: it can never leak to another request on the pooled connection.
      await tx.execute(
        sql`select set_config('app.current_org_id', ${orgId}, true), set_config('app.current_user_id', ${userId}, true), set_config('app.system_context', ${system}, true)`,
      );
      return als.run({ tx, scope, afterCommit }, () => fn(tx));
    });
    for (const cb of afterCommit) {
      try {
        await cb();
      } catch (err) {
        opts.onAfterCommitError?.(err);
      }
    }
    return result;
  }

  return {
    pool,
    withTenant: (scope, fn) => run({ kind: "tenant", ...scope }, fn),
    withUser: (userId, fn) => run({ kind: "user", userId }, fn),
    withSystem: (reason, fn) => run({ kind: "system", reason }, fn),
    async afterCommit(fn) {
      const active = als.getStore();
      if (active) active.afterCommit.push(fn);
      else await fn();
    },
    lockKey: (name) => {
      let h = 0;
      for (const ch of name) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0;
      return h;
    },
    currentScope: () => als.getStore()?.scope,
    close: () => pool.end(),
  };
}

/** Map a service TenantContext to the DB scope used for RLS. */
export function scopeOf(ctx: { organizationId: Uuid; actor: { type: string; id: string } }): { organizationId: Uuid; userId?: Uuid } {
  return ctx.actor.type === "user" && isUuid(ctx.actor.id)
    ? { organizationId: ctx.organizationId, userId: ctx.actor.id }
    : { organizationId: ctx.organizationId };
}
