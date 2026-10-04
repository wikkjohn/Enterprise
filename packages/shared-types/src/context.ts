import type { Uuid } from "./common";

export type ActorType = "user" | "api_key" | "system" | "agent";

export interface Actor {
  type: ActorType;
  /** user id, api key id, agent id, or a stable system component name */
  id: string;
  /** Human-readable label for audit trails (email, key name, component). */
  label: string;
  /** For api_key actors: the permission keys the key is scoped to. */
  scopes?: string[];
  /** For user actors: whether the user is a platform administrator. */
  isPlatformAdmin?: boolean;
}

export interface RequestMeta {
  correlationId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * The context every tenant-scoped service call requires.
 * `organizationId` is the ONLY source of truth for tenant ownership —
 * services never accept an organization id from request bodies.
 */
export interface TenantContext extends RequestMeta {
  organizationId: Uuid;
  actor: Actor;
  /** Session id for user actors (used for session-bound operations). */
  sessionId?: Uuid;
  /** Request-scoped memo (e.g. effective permissions). Not serialised. */
  cache?: Map<string, unknown>;
}

/** Context for platform-level (non-tenant) operations. */
export interface PlatformContext extends RequestMeta {
  actor: Actor;
}

export const SYSTEM_ACTOR = (component: string): Actor => ({ type: "system", id: component, label: `system:${component}` });
