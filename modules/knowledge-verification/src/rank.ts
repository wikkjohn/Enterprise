import { type Authority } from "./verify";
import { words } from "./text";

/**
 * Ranking and request classification — pure.
 *
 *   score = retrieval relevance (normalised 0–1)
 *         × authority weight (authoritative 1.0, preferred 0.85, secondary 0.6, deprecated 0.25)
 *         × freshness (current 1.0, stale 0.8)
 * Expired documents never reach ranking: retrieval excludes them.
 */
export const AUTHORITY_WEIGHT: Record<Authority, number> = { authoritative: 1, preferred: 0.85, secondary: 0.6, deprecated: 0.25 };
export const STALE_WEIGHT = 0.8;

export type Freshness = "fresh" | "stale" | "expired";

/** Expired beats everything; otherwise stale when a review is overdue or neither modified nor reviewed within `staleDays`. */
export function freshnessOf(doc: { expirationDate: Date | null; reviewDueAt: Date | null; lastModifiedAt: Date | null; lastReviewedAt?: Date | null }, now: Date, staleDays: number): Freshness {
  if (doc.expirationDate && doc.expirationDate <= now) return "expired";
  if (doc.reviewDueAt && doc.reviewDueAt <= now) return "stale";
  const touched = Math.max(doc.lastModifiedAt?.getTime() ?? 0, doc.lastReviewedAt?.getTime() ?? 0);
  if (touched && now.getTime() - touched > staleDays * 86400_000) return "stale";
  return "fresh";
}

export interface RankInput { relevance: number; authority: Authority; freshness: Freshness; effectiveDate: Date | null }

export function rankScore(h: RankInput): number {
  if (h.freshness === "expired") return 0;
  return h.relevance * AUTHORITY_WEIGHT[h.authority] * (h.freshness === "stale" ? STALE_WEIGHT : 1);
}

export function rank<T extends RankInput>(hits: T[]): Array<T & { score: number }> {
  return hits
    .map((h) => ({ ...h, score: rankScore(h) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || (b.effectiveDate?.getTime() ?? 0) - (a.effectiveDate?.getTime() ?? 0));
}

// ── Escalation categories ───────────────────────────────────────────────────
export interface EscalationCategory {
  key: string;
  label: string;
  keywords: string[];
  /** "low_confidence": escalate when confidence is low or insufficient. "always": every matching request goes to an expert. */
  escalateWhen: "low_confidence" | "always";
  expertUserIds: string[];
}

export const DEFAULT_CATEGORIES: EscalationCategory[] = [
  { key: "legal", label: "Legal", keywords: ["contract", "lawsuit", "litigation", "liability", "indemnif", "legal", "nda", "subpoena", "intellectual property", "trademark"], escalateWhen: "low_confidence", expertUserIds: [] },
  { key: "hr", label: "HR", keywords: ["salary", "termination", "fired", "harassment", "discrimination", "leave", "parental", "benefits", "disciplinary", "performance review", "payroll"], escalateWhen: "low_confidence", expertUserIds: [] },
  { key: "finance", label: "Finance", keywords: ["budget", "invoice", "revenue", "tax", "expense", "reimburse", "audit", "forecast", "payment terms", "capex"], escalateWhen: "low_confidence", expertUserIds: [] },
  { key: "safety", label: "Safety", keywords: ["safety", "hard hat", "protective equipment", "injury", "hazard", "osha", "emergency", "evacuation", "chemical", "ppe", "accident", "fire", "unsafe"], escalateWhen: "always", expertUserIds: [] },
  { key: "regulatory", label: "Regulatory", keywords: ["regulator", "compliance", "hipaa", "gdpr", "sox", "filing", "fda", "sec ", "export control", "sanction"], escalateWhen: "low_confidence", expertUserIds: [] },
  { key: "security", label: "Security", keywords: ["breach", "password", "vulnerability", "phishing", "malware", "incident", "access control", "encryption", "credential"], escalateWhen: "low_confidence", expertUserIds: [] },
];

/** Categories whose keywords appear in the question (word-prefix match, case-insensitive). */
export function categorize(question: string, categories: EscalationCategory[]): EscalationCategory[] {
  const q = ` ${words(question).join(" ")} `;
  return categories.filter((c) => c.keywords.some((k) => {
    const kw = words(k).join(" ");
    return kw.length > 1 && q.includes(` ${kw}`);
  }));
}

/** Normalise a question for "top questions" grouping. */
export function normalizeQuestion(q: string): string {
  return words(q).filter((w) => !["the", "a", "an", "is", "are", "what", "how", "do", "does", "i", "we", "our", "my", "can", "please"].includes(w)).join(" ").slice(0, 300);
}
