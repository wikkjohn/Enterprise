import { z } from "zod";
import { type EventContract } from "./contracts";

const id = z.string().uuid();
const c = <S extends z.ZodTypeAny>(type: string, description: string, schema: S, externallyVisible = true): EventContract<z.infer<S>> => ({
  type,
  owner: "core",
  version: 1,
  description,
  schema,
  externallyVisible,
});

/** Contracts for events emitted by the shared core. */
export const CORE_EVENTS: EventContract[] = [
  c("organization.created", "A tenant organization was provisioned.", z.object({ organizationId: id, name: z.string(), slug: z.string() })),
  c("organization.updated", "Organization profile, status or settings changed.", z.object({ organizationId: id, fields: z.array(z.string()) })),
  c("user.invited", "A user was invited to the organization.", z.object({ invitationId: id, email: z.string(), roleKeys: z.array(z.string()) })),
  c("user.joined", "A user joined the organization.", z.object({ userId: id, membershipId: id, source: z.string() })),
  c("user.suspended", "A member was suspended.", z.object({ userId: id, membershipId: id })),
  c("role.assigned", "A role was granted to a member.", z.object({ membershipId: id, roleKey: z.string(), scopeType: z.string().nullable(), scopeId: z.string().nullable() })),
  c("role.revoked", "A role was revoked from a member.", z.object({ membershipId: id, roleKey: z.string() })),
  c("module.enabled", "A module was enabled for the organization.", z.object({ moduleId: z.string() })),
  c("module.disabled", "A module was disabled for the organization.", z.object({ moduleId: z.string() })),
  c("connector.created", "A connector was configured.", z.object({ connectorId: id, type: z.string(), name: z.string() })),
  c("connector.updated", "Connector configuration changed.", z.object({ connectorId: id, fields: z.array(z.string()) })),
  c("connector.deleted", "A connector was deleted.", z.object({ connectorId: id })),
  c("connector.failed", "A connector health check or action failed.", z.object({ connectorId: id, errorClass: z.string(), message: z.string() })),
  c("connector.health_changed", "A connector's health status changed.", z.object({ connectorId: id, from: z.string(), to: z.string() })),
  c("credential.rotated", "A connector credential was rotated.", z.object({ connectorId: id, credentialId: id })),
  c("credential.expiring", "A connector credential will expire soon.", z.object({ connectorId: id, credentialId: id, expiresAt: z.string() })),
  c("policy.activated", "A policy version was activated.", z.object({ policyId: id, key: z.string(), version: z.number().int() })),
  c("ai.run.completed", "An AI run completed.", z.object({ runId: id, moduleId: z.string(), useCase: z.string(), provider: z.string(), model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number(), latencyMs: z.number() })),
  c("ai.run.failed", "An AI run failed or was blocked.", z.object({ runId: id, moduleId: z.string(), useCase: z.string(), status: z.string(), errorCode: z.string().nullable() })),
  c("usage.threshold.exceeded", "Usage crossed an organization limit.", z.object({ metric: z.string(), limit: z.number(), current: z.number(), period: z.string() })),
  c("api_key.created", "An API key was created.", z.object({ apiKeyId: id, name: z.string(), scopes: z.array(z.string()) }), false),
  c("api_key.revoked", "An API key was revoked.", z.object({ apiKeyId: id }), false),
];
