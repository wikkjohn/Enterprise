import { hasNegation, quantities, sentences, similarity, termJaccard, type Quantity } from "./text";

/**
 * Duplicate and conflict detection between two documents — pure.
 *
 * Contradictions are *surfaced*, never resolved: the result says what
 * disagrees and which document is newer, and a reviewer decides.
 */
export const CONFLICT_KINDS = ["duplicate", "near_duplicate", "newer_version", "contradiction"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface DocForComparison {
  id: string;
  title: string;
  text: string;
  hash: string;
  signature: number[];
  effectiveDate: Date | null;
  lastModifiedAt: Date | null;
}

export interface Evidence { a: string; b: string; reason: string }

export interface Comparison {
  kind: ConflictKind;
  similarity: number;
  newer: "a" | "b" | null;
  detail: string;
  evidence: Evidence[];
}

const normTitle = (t: string) => t.toLowerCase().replace(/\.(pdf|docx?|pptx?|xlsx?|txt|html?|md|csv)$/, "").replace(/\b(v(ersion)?\s*\d+(\.\d+)*|final|draft|copy|\(\d+\)|\d{4}(-\d{2}){0,2})\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const dateOf = (d: DocForComparison) => d.effectiveDate ?? d.lastModifiedAt;

function sameUnit(a: Quantity, b: Quantity) {
  return a.unit === b.unit || !a.unit || !b.unit;
}

/** Sentence-level disagreements: same statement, different numbers, or opposite polarity. */
export function contradictions(a: string, b: string, limit = 5): Evidence[] {
  const sa = sentences(a).slice(0, 400);
  const sb = sentences(b).slice(0, 400);
  const out: Evidence[] = [];
  for (const x of sa) {
    const qx = quantities(x);
    const negx = hasNegation(x);
    for (const y of sb) {
      if (x === y) continue;
      const overlap = termJaccard(x.replace(/\d[\d,.]*/g, ""), y.replace(/\d[\d,.]*/g, ""));
      if (overlap < 0.5) continue;
      const qy = quantities(y);
      if (qx.length && qy.length) {
        const differ = qx.some((p) => qy.some((q) => sameUnit(p, q) && p.unit === q.unit) && !qy.some((q) => q.value === p.value && sameUnit(p, q)));
        if (differ) {
          out.push({ a: x, b: y, reason: `Same statement with different values (${qx.map((q) => q.raw).join(", ")} vs ${qy.map((q) => q.raw).join(", ")})` });
          break;
        }
      }
      if (overlap >= 0.6 && negx !== hasNegation(y)) {
        out.push({ a: x, b: y, reason: "Same statement with opposite polarity (one says it is not / must not)" });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Compare two documents; null when they are unrelated. */
export function compare(a: DocForComparison, b: DocForComparison): Comparison | null {
  if (a.hash === b.hash) return { kind: "duplicate", similarity: 1, newer: null, detail: "Identical content.", evidence: [] };
  const sim = similarity(a.signature, b.signature);
  const sameTitle = normTitle(a.title) !== "" && normTitle(a.title) === normTitle(b.title);
  const topical = termJaccard(a.text.slice(0, 20_000), b.text.slice(0, 20_000));
  if (sim < 0.35 && !sameTitle && topical < 0.2) return null;
  const da = dateOf(a);
  const db = dateOf(b);
  const newer = da && db && da.getTime() !== db.getTime() ? (da > db ? "a" : "b") : null;
  const ev = contradictions(a.text, b.text);
  if (ev.length) {
    return { kind: "contradiction", similarity: sim, newer, detail: `${ev.length} conflicting statement(s)${newer ? `; "${(newer === "a" ? a : b).title}" is newer, but the platform does not decide which is correct` : ""}.`, evidence: ev };
  }
  if (sim >= 0.8) return { kind: "near_duplicate", similarity: sim, newer, detail: `About ${Math.round(sim * 100)}% of passages are shared.`, evidence: [] };
  if ((sameTitle || sim >= 0.5) && newer) return { kind: "newer_version", similarity: sim, newer, detail: `"${(newer === "a" ? a : b).title}" appears to be a newer version of "${(newer === "a" ? b : a).title}".`, evidence: [] };
  return null;
}
