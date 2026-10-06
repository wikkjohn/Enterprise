/**
 * AI request workflow:
 *
 *   submitted → business_review → security_review → technical_review → financial_review
 *             → approved | rejected → implementation → measurement → closed
 *
 * Reviewers record a decision at each review stage: approve (advance),
 * not_applicable (advance, with a reason), request_changes (back to the
 * requester) or reject (final). Nobody reviews their own request.
 */

export const REQUEST_KINDS = ["tool", "automation", "model", "agent", "integration", "use_case"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STAGES = ["submitted", "business_review", "security_review", "technical_review", "financial_review", "approved", "rejected", "implementation", "measurement", "closed"] as const;
export type RequestStage = (typeof REQUEST_STAGES)[number];

export const REVIEW_STAGES = ["business_review", "security_review", "technical_review", "financial_review"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export const REVIEW_DECISIONS = ["approve", "not_applicable", "request_changes", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const STAGE_LABEL: Record<RequestStage, string> = {
  submitted: "Submitted", business_review: "Business review", security_review: "Security review", technical_review: "Technical review", financial_review: "Financial review",
  approved: "Approved", rejected: "Rejected", implementation: "Implementation", measurement: "Measurement", closed: "Closed",
};

export const isReviewStage = (s: string): s is ReviewStage => (REVIEW_STAGES as readonly string[]).includes(s);

export type RequestAction =
  | { type: "start_review" }
  | { type: "review"; decision: ReviewDecision }
  | { type: "start_implementation" }
  | { type: "start_measurement" }
  | { type: "close" }
  | { type: "withdraw" }
  | { type: "resubmit" };

export class TransitionError extends Error {}

/** Next stage for an action, or a TransitionError explaining why it is not allowed. */
export function nextStage(stage: RequestStage, action: RequestAction, opts: { changesRequested?: boolean } = {}): RequestStage {
  switch (action.type) {
    case "start_review":
      if (stage !== "submitted") break;
      if (opts.changesRequested) throw new TransitionError("The requester must update and resubmit the request first.");
      return "business_review";
    case "resubmit":
      if (stage !== "submitted" || !opts.changesRequested) break;
      return "submitted";
    case "review": {
      if (!isReviewStage(stage)) break;
      if (action.decision === "reject") return "rejected";
      if (action.decision === "request_changes") return "submitted";
      const i = REVIEW_STAGES.indexOf(stage);
      return i === REVIEW_STAGES.length - 1 ? "approved" : REVIEW_STAGES[i + 1]!;
    }
    case "start_implementation":
      if (stage === "approved") return "implementation";
      break;
    case "start_measurement":
      if (stage === "implementation") return "measurement";
      break;
    case "close":
      if (stage === "measurement" || stage === "implementation" || stage === "approved" || stage === "rejected") return "closed";
      break;
    case "withdraw":
      if (stage === "submitted" || isReviewStage(stage)) return "closed";
      break;
  }
  throw new TransitionError(`Cannot ${action.type.replace(/_/g, " ")}${action.type === "review" ? ` (${action.decision})` : ""} while the request is ${STAGE_LABEL[stage].toLowerCase()}.`);
}

/** Progress for the stepper: done, current or upcoming per main-line stage. */
export function progress(stage: RequestStage): Array<{ stage: RequestStage; state: "done" | "current" | "upcoming" | "skipped" }> {
  const line: RequestStage[] = ["submitted", ...REVIEW_STAGES, "approved", "implementation", "measurement", "closed"];
  type Step = { stage: RequestStage; state: "done" | "current" | "upcoming" | "skipped" };
  if (stage === "rejected") return [...line.map((s): Step => ({ stage: s, state: "skipped" })), { stage: "rejected", state: "current" }];
  const at = line.indexOf(stage);
  return line.map((s, i) => ({ stage: s, state: i < at ? "done" : i === at ? "current" : "upcoming" }));
}
