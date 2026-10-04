import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CorrelationScope {
  correlationId: string;
  organizationId?: string;
  actorId?: string;
  module?: string;
}

const storage = new AsyncLocalStorage<CorrelationScope>();

export function runWithCorrelation<T>(scope: Partial<CorrelationScope>, fn: () => T): T {
  const parent = storage.getStore();
  const next: CorrelationScope = {
    ...parent,
    ...scope,
    correlationId: scope.correlationId ?? parent?.correlationId ?? newCorrelationId(),
  };
  return storage.run(next, fn);
}

export function currentCorrelation(): CorrelationScope | undefined {
  return storage.getStore();
}

export function newCorrelationId(): string {
  return randomUUID();
}

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
/** Accept a client-supplied request id only if it is well-formed. */
export function sanitizeCorrelationId(value: string | null | undefined): string {
  return value && SAFE_ID.test(value) ? value : newCorrelationId();
}
