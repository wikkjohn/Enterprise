import { agentGovernanceService, type AgentGovernanceService } from "@eaop/module-agent-governance";
import { type Platform } from "@eaop/platform";
import { z } from "zod";

/** The Agent Governance service, built by the module's install hook on the shared platform. */
export const ag = (platform: Platform): AgentGovernanceService => agentGovernanceService(platform);

export const AG_MODULE = "agent_governance" as const;
export const AG_BASE = "/m/agent-governance";
export const anyBody = z.record(z.unknown());
const s = (max = 64) => z.string().max(max).optional();
export const listQuery = z.object({ status: s(), q: s(200), environment: s(), agentId: s(), effect: s(), source: s(), kind: s(), decision: s(), userId: s(), system: s(120), action: s(120), from: s(), to: s(), incidentId: s(), limit: z.coerce.number().int().min(1).max(500).optional() });
