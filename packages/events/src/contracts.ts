import { type z } from "zod";
import { type OwnerId } from "@eaop/shared-types";

/**
 * An event contract. Event types are namespaced by owner
 * ("connector.created", "workflow.analyzed"). Breaking payload changes MUST
 * bump `version` and keep publishing the old version until consumers migrate.
 */
export interface EventContract<P = unknown> {
  type: string;
  owner: OwnerId;
  version: number;
  description: string;
  schema: z.ZodType<P>;
  /** Whether the event may be delivered to tenant webhooks. Default true. */
  externallyVisible?: boolean;
}

export interface PlatformEvent<P = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  organizationId: string | null;
  occurredAt: string;
  actor: { type: string; id: string } | null;
  correlationId: string | null;
  payload: P;
}

const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class EventRegistry {
  private contracts = new Map<string, EventContract>();

  register<P>(contract: EventContract<P>): void {
    if (!TYPE_RE.test(contract.type)) throw new Error(`Invalid event type "${contract.type}"`);
    const existing = this.contracts.get(contract.type);
    if (existing && existing.owner !== contract.owner) {
      throw new Error(`Event type "${contract.type}" is already owned by "${existing.owner}"`);
    }
    this.contracts.set(contract.type, contract as EventContract);
  }

  get(type: string) {
    return this.contracts.get(type);
  }

  list(): EventContract[] {
    return [...this.contracts.values()].sort((a, b) => a.type.localeCompare(b.type));
  }
}
