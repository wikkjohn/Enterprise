import { CATEGORIES, CONFIDENCE_RANK, type BuiltinCategory, type CategorySummary, type Confidence } from "./detect";
import { type RedactionMode } from "./redact";

/**
 * AI DLP decision — pure.
 *
 *   per-category actions (org-configurable, by destination trust)
 *     → destination status (blocked / restricted tools)
 *     → organization "ai_dlp" policies (shared policy engine; evaluated by the service)
 *   strictest wins:  ALLOW < REDACT < REQUIRE_APPROVAL < BLOCK
 *
 * REDACT only applies to values that can be cut out of the text. A category
 * set to REDACT that was detected only as a document-level signal (source
 * code, a contract…) cannot be redacted, so it escalates to REQUIRE_APPROVAL.
 */
export const DLP_DECISIONS = ["ALLOW", "REDACT", "REQUIRE_APPROVAL", "BLOCK"] as const;
export type DlpDecision = (typeof DLP_DECISIONS)[number];
export const DLP_ORDER: Record<DlpDecision, number> = { ALLOW: 0, REDACT: 1, REQUIRE_APPROVAL: 2, BLOCK: 3 };
export const stricter = (a: DlpDecision, b: DlpDecision): DlpDecision => (DLP_ORDER[b] > DLP_ORDER[a] ? b : a);

/** How much the destination is trusted. */
export type DestinationTrust = "approved" | "experimental" | "unknown" | "restricted" | "blocked";

export interface CategoryAction {
  category: string;
  approved: DlpDecision;
  unapproved: DlpDecision;
  minConfidence: Confidence;
  redactionMode: RedactionMode;
}

/** Defaults; organizations override per category (and add custom categories). */
export const DEFAULT_ACTIONS: Record<BuiltinCategory, Omit<CategoryAction, "category">> = {
  credentials: { approved: "BLOCK", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "label" },
  pii: { approved: "REDACT", unapproved: "REDACT", minConfidence: "medium", redactionMode: "mask" },
  financial: { approved: "REDACT", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "mask" },
  customer_records: { approved: "REDACT", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "tokenize" },
  employee: { approved: "REQUIRE_APPROVAL", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "tokenize" },
  source_code: { approved: "ALLOW", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "label" },
  contracts: { approved: "ALLOW", unapproved: "REQUIRE_APPROVAL", minConfidence: "medium", redactionMode: "label" },
  trade_secrets: { approved: "REQUIRE_APPROVAL", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "label" },
  health: { approved: "REDACT", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "label" },
  regulated: { approved: "REQUIRE_APPROVAL", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "label" },
};
export const CUSTOM_DEFAULT: Omit<CategoryAction, "category"> = { approved: "REDACT", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "label" };

export function actionFor(category: string, overrides: CategoryAction[]): CategoryAction {
  return overrides.find((o) => o.category === category) ?? { category, ...((CATEGORIES as readonly string[]).includes(category) ? DEFAULT_ACTIONS[category as BuiltinCategory] : CUSTOM_DEFAULT) };
}

export interface DlpOutcome {
  decision: DlpDecision;
  reasons: string[];
  /** Categories whose spans must be redacted (when the decision is REDACT). */
  redactCategories: string[];
  /** Categories that drove the decision (at their minimum confidence). */
  triggered: string[];
}

export function decideDlp(summaries: CategorySummary[], trust: DestinationTrust, actions: CategoryAction[]): DlpOutcome {
  const reasons: string[] = [];
  const redactCategories: string[] = [];
  const triggered: string[] = [];
  let decision: DlpDecision = "ALLOW";

  if (trust === "blocked") return { decision: "BLOCK", reasons: ["Destination is blocked by the organization."], redactCategories: [], triggered: [] };

  const trusted = trust === "approved";
  for (const s of summaries) {
    const a = actionFor(s.category, actions);
    if (CONFIDENCE_RANK[s.confidence] < CONFIDENCE_RANK[a.minConfidence]) continue;
    let d = trusted ? a.approved : a.unapproved;
    if (d === "REDACT" && s.redactable === 0) {
      d = "REQUIRE_APPROVAL";
      reasons.push(`${s.category}: detected as a whole-document signal that cannot be redacted → approval required`);
    } else if (d !== "ALLOW") {
      reasons.push(`${s.category} (${s.count}, ${s.confidence} confidence) → ${d.replace("_", " ").toLowerCase()} for ${trusted ? "approved" : `${trust}`} destinations`);
    }
    if (d === "REDACT") redactCategories.push(s.category);
    if (d !== "ALLOW") triggered.push(s.category);
    decision = stricter(decision, d);
  }

  if (trust === "restricted" && triggered.length > 0) {
    decision = stricter(decision, "REQUIRE_APPROVAL");
    reasons.push("Destination is restricted: sensitive content needs approval.");
  }
  return { decision, reasons, redactCategories: decision === "REDACT" ? redactCategories : [], triggered };
}

/** Map a shared policy effect onto a DLP decision. */
export function fromPolicyEffect(effect: string): DlpDecision {
  if (effect === "DENY") return "BLOCK";
  if (effect === "REQUIRE_APPROVAL" || effect === "ESCALATE") return "REQUIRE_APPROVAL";
  return "ALLOW";
}
