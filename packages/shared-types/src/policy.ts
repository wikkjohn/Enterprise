/** Shared policy decision vocabulary used by every module. */
export const POLICY_EFFECTS = ["ALLOW", "DENY", "REQUIRE_APPROVAL", "ESCALATE"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

/** Higher wins under deny-overrides combining. */
export const POLICY_EFFECT_PRECEDENCE: Record<PolicyEffect, number> = {
  ALLOW: 0,
  REQUIRE_APPROVAL: 1,
  ESCALATE: 2,
  DENY: 3,
};
