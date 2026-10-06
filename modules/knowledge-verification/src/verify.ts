import { hasNegation, quantities, sentences, terms, type Quantity } from "./text";

/**
 * Claim extraction, claim verification and confidence — pure, deterministic,
 * explainable. Verification compares each claim with the sentences of the
 * retrieved, permission-filtered sources (never with the model's own
 * knowledge): content-term coverage, numbers with units, and polarity.
 */
export const VERIFICATION_STATUSES = ["VERIFIED", "PARTIALLY_VERIFIED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const AUTHORITIES = ["authoritative", "preferred", "secondary", "deprecated"] as const;
export type Authority = (typeof AUTHORITIES)[number];
export const AUTHORITY_RANK: Record<Authority, number> = { authoritative: 3, preferred: 2, secondary: 1, deprecated: 0 };

export interface SourcePassage {
  marker: string; // "S1"
  chunkId: string;
  documentId: string;
  title: string;
  text: string;
  authority: Authority;
  freshness: "fresh" | "stale";
  score: number;
}

export interface Claim { ordinal: number; text: string; important: boolean; cited: string[] }

const HEDGE = /^(i (don't|do not) know|i('m| am) not sure|the (provided |available )?sources? (do not|don't)|no (approved )?(information|source)|i could not find|i can't find|unable to)/i;
const IMPORTANT = /\b(must|shall|required|requires|prohibited|not allowed|may not|cannot|deadline|limit|maximum|minimum|eligible|entitled|approval|approve|policy|within|up to|at least|no more than)\b/i;

/** Split an answer into claims; citation markers like [S1] are attached to the sentence they follow. */
export function extractClaims(answer: string): Claim[] {
  const out: Claim[] = [];
  // "Sentence. [S1] Next…" → "Sentence [S1]. Next…" so markers stay with their sentence and splitting works.
  const normalized = answer.replace(/\r/g, "").replace(/([.!?])((?:\s*\[S\d+\])+)/g, "$2$1");
  for (const s of sentences(normalized)) {
    const cited = [...s.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]!);
    const text = s.replace(/\s*\[S\d+\](?:\s*,?\s*\[S\d+\])*/g, "").replace(/\s+([.,;:!?])/g, "$1").trim();
    if (text.length < 12 || /\?$/.test(text) || HEDGE.test(text) || terms(text).length < 2) continue;
    out.push({ ordinal: out.length, text, important: quantities(text).length > 0 || IMPORTANT.test(text), cited: [...new Set(cited)] });
    if (out.length >= 40) break;
  }
  return out;
}

export interface ClaimVerification {
  status: VerificationStatus;
  explanation: string;
  supporting: string[]; // markers
  contradicting: string[];
  coverage: number;
}

const qEq = (a: Quantity, b: Quantity) => a.value === b.value && (a.unit === b.unit || !a.unit || !b.unit);

export function verifyClaim(claim: Claim, sources: SourcePassage[]): ClaimVerification {
  const ct = [...new Set(terms(claim.text).filter((t) => !/^\d/.test(t)))];
  const cq = quantities(claim.text);
  const cneg = hasNegation(claim.text);
  let bestCov = 0;
  let bestSentence = "";
  let bestMarker = "";
  const support: Array<{ marker: string; sentence: string }> = [];
  const contra: Array<{ marker: string; sentence: string; why: string }> = [];
  for (const src of sources) {
    for (const s of sentences(src.text)) {
      const st = new Set(terms(s));
      const cov = ct.length ? ct.filter((t) => st.has(t)).length / ct.length : 0;
      if (cov > bestCov) {
        bestCov = cov;
        bestSentence = s;
        bestMarker = src.marker;
      }
      if (cov < 0.6) continue;
      const sq = quantities(s);
      const numbersOk = cq.every((q) => sq.some((x) => qEq(q, x)));
      const numbersClash = cq.length > 0 && sq.length > 0 && cq.some((q) => sq.some((x) => x.unit === q.unit) && !sq.some((x) => qEq(q, x)));
      const polarityClash = cov >= 0.6 && cneg !== hasNegation(s);
      if (numbersClash) contra.push({ marker: src.marker, sentence: s, why: `states ${sq.map((x) => x.raw).join(", ")} where the claim says ${cq.map((x) => x.raw).join(", ")}` });
      else if (polarityClash) contra.push({ marker: src.marker, sentence: s, why: "states the opposite" });
      else if (cov >= 0.6 && numbersOk) support.push({ marker: src.marker, sentence: s });
    }
  }
  const sup = [...new Set(support.map((x) => x.marker))];
  const con = [...new Set(contra.map((x) => x.marker))];
  const quote = (s: string) => `"${s.length > 160 ? `${s.slice(0, 157)}…` : s}"`;
  const citedNote = claim.cited.length && sup.length && !claim.cited.some((c) => sup.includes(c)) ? ` (cited ${claim.cited.join(", ")}, but the support is in ${sup.join(", ")})` : "";
  const missing = claim.cited.filter((c) => !sources.some((s) => s.marker === c));
  const missingNote = missing.length ? ` Cites ${missing.join(", ")}, which is not among the retrieved sources.` : "";

  if (sup.length && con.length) {
    return { status: "PARTIALLY_VERIFIED", explanation: `Supported by ${sup.join(", ")} (${quote(support[0]!.sentence)}) but ${contra[0]!.marker} ${contra[0]!.why}: ${quote(contra[0]!.sentence)}. Sources disagree.${missingNote}`, supporting: sup, contradicting: con, coverage: 1 };
  }
  if (sup.length) return { status: "VERIFIED", explanation: `Stated in ${sup.join(", ")}: ${quote(support[0]!.sentence)}${citedNote}.${missingNote}`, supporting: sup, contradicting: [], coverage: 1 };
  if (con.length) return { status: "CONTRADICTED", explanation: `${contra[0]!.marker} ${contra[0]!.why}: ${quote(contra[0]!.sentence)}.${missingNote}`, supporting: [], contradicting: con, coverage: bestCov };
  if (bestCov >= 0.35) {
    const qNote = cq.length ? ` The figures (${cq.map((q) => q.raw).join(", ")}) are not stated there.` : "";
    return { status: "PARTIALLY_VERIFIED", explanation: `Related content in ${bestMarker} covers ${Math.round(bestCov * 100)}% of the claim's terms: ${quote(bestSentence)}.${qNote}${missingNote}`, supporting: [bestMarker], contradicting: [], coverage: bestCov };
  }
  return { status: "UNSUPPORTED", explanation: `No retrieved source states this${bestCov > 0 ? ` (closest match covers ${Math.round(bestCov * 100)}% of its terms)` : ""}.${missingNote}`, supporting: [], contradicting: [], coverage: bestCov };
}

// ── Confidence ──────────────────────────────────────────────────────────────
export const CONFIDENCE_LEVELS = ["high", "medium", "low", "insufficient"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ConfidenceFactor { factor: string; label: string; value: string; effect: "raises" | "lowers" | "neutral"; detail: string }
export interface Confidence { level: ConfidenceLevel; factors: ConfidenceFactor[]; summary: string }

export interface ConfidenceInput {
  sources: SourcePassage[];
  claims: Array<Claim & ClaimVerification>;
  openConflicts: number;
  /** Top retrieval score after normalisation (0–1). */
  topRetrieval: number;
}

/**
 * Rule-based confidence (no percentages). Methodology:
 *   insufficient — nothing retrieved, or no claim could be verified at all.
 *   low          — an important claim is UNSUPPORTED or CONTRADICTED, a cited
 *                  document has an open conflict, the only support is
 *                  deprecated, or retrieval is weak and fewer than half of
 *                  the claims are verified.
 *   high         — every important claim VERIFIED, support from an
 *                  authoritative or preferred source that is not stale, no
 *                  conflicts or contradictions, retrieval not weak, and
 *                  either two or more supporting documents or an
 *                  authoritative one.
 *   medium       — everything else.
 */
export function assessConfidence(input: ConfidenceInput): Confidence {
  const { sources, claims, openConflicts, topRetrieval } = input;
  const factors: ConfidenceFactor[] = [];
  const byMarker = new Map(sources.map((s) => [s.marker, s]));
  const supportingSources = [...new Set(claims.flatMap((c) => (c.status === "VERIFIED" || c.status === "PARTIALLY_VERIFIED" ? c.supporting : [])))].map((m) => byMarker.get(m)).filter((s): s is SourcePassage => !!s);
  const supportingDocs = new Set(supportingSources.map((s) => s.documentId));
  const verified = claims.filter((c) => c.status === "VERIFIED").length;
  const important = claims.filter((c) => c.important);
  const badImportant = important.filter((c) => c.status === "UNSUPPORTED" || c.status === "CONTRADICTED");
  const contradicted = claims.filter((c) => c.status === "CONTRADICTED" || c.contradicting.length).length;
  const bestAuthority = supportingSources.reduce<SourcePassage["authority"] | null>((b, s) => (!b || AUTHORITY_RANK[s.authority] > AUTHORITY_RANK[b] ? s.authority : b), null);
  const staleSupport = supportingSources.some((s) => s.freshness === "stale");
  const retrieval = topRetrieval >= 0.5 ? "strong" : topRetrieval >= 0.2 ? "moderate" : "weak";

  factors.push({ factor: "retrieval_strength", label: "Retrieval strength", value: sources.length ? retrieval : "none", effect: !sources.length || retrieval === "weak" ? "lowers" : retrieval === "strong" ? "raises" : "neutral", detail: `${sources.length} permitted passage(s) retrieved; best match ${retrieval}.` });
  factors.push({ factor: "source_quality", label: "Source quality", value: bestAuthority ?? "none", effect: bestAuthority === "authoritative" || bestAuthority === "preferred" ? "raises" : bestAuthority ? "lowers" : "lowers", detail: bestAuthority ? `Best supporting source is ${bestAuthority}.` : "No source supports the answer." });
  factors.push({ factor: "supporting_sources", label: "Supporting sources", value: String(supportingDocs.size), effect: supportingDocs.size >= 2 ? "raises" : supportingDocs.size === 1 ? "neutral" : "lowers", detail: `${supportingDocs.size} distinct document(s) support the claims.` });
  factors.push({ factor: "source_agreement", label: "Source agreement", value: contradicted || openConflicts ? "disagreement" : "agree", effect: contradicted || openConflicts ? "lowers" : "raises", detail: `${contradicted} claim(s) contradicted by a source; ${openConflicts} open conflict(s) on the cited documents.` });
  factors.push({ factor: "freshness", label: "Freshness", value: staleSupport ? "stale" : supportingSources.length ? "current" : "n/a", effect: staleSupport ? "lowers" : "neutral", detail: staleSupport ? "Some supporting documents are past their review date." : "Supporting documents are within their review period (expired documents are never used)." });
  factors.push({ factor: "claim_verification", label: "Claim verification", value: `${verified}/${claims.length} verified`, effect: claims.length && verified === claims.length ? "raises" : badImportant.length ? "lowers" : "neutral", detail: `${verified} of ${claims.length} claim(s) verified; ${badImportant.length} important claim(s) unsupported or contradicted.` });

  let level: ConfidenceLevel;
  let summary: string;
  if (!sources.length || !claims.length || (verified === 0 && !claims.some((c) => c.status === "PARTIALLY_VERIFIED"))) {
    level = "insufficient";
    summary = !sources.length ? "No approved source you can access covers this question." : "The answer could not be checked against the sources.";
  } else if (badImportant.length || openConflicts > 0 || bestAuthority === "deprecated" || bestAuthority === null || (retrieval === "weak" && verified / claims.length < 0.5)) {
    level = "low";
    summary = badImportant.length ? `${badImportant.length} important claim(s) are not supported by the sources.` : openConflicts ? "The cited documents have unresolved conflicts." : bestAuthority === "deprecated" ? "Only deprecated sources support this answer." : "Support for this answer is weak.";
  } else if (important.every((c) => c.status === "VERIFIED") && (bestAuthority === "authoritative" || bestAuthority === "preferred") && !staleSupport && !contradicted && retrieval !== "weak" && (supportingDocs.size >= 2 || bestAuthority === "authoritative")) {
    level = "high";
    summary = "Every important claim is stated in current, authoritative sources that agree.";
  } else {
    level = "medium";
    summary = "Mostly supported; see the factors for what limits confidence.";
  }
  return { level, factors, summary };
}

/** Extractive answer: best-matching sentences from the top passages, each cited. Used when no real AI model is available. */
export function extractiveAnswer(query: string, sources: SourcePassage[], max = 3): string {
  const qt = new Set(terms(query));
  const scored: Array<{ s: string; marker: string; score: number; hit: number }> = [];
  for (const src of sources.slice(0, 5)) {
    for (const s of sentences(src.text)) {
      if (s.length < 20 || /^[^:]{1,40}:\s*$/.test(s)) continue;
      const st = terms(s);
      const hit = st.filter((t) => qt.has(t)).length;
      if (hit) scored.push({ s, marker: src.marker, hit, score: hit / Math.sqrt(st.length + 1) + AUTHORITY_RANK[src.authority] * 0.05 });
    }
  }
  // The best sentence is always used; further ones only if they cover enough of the question (no padding with loosely related text).
  const picked: typeof scored = [];
  for (const c of scored.sort((a, b) => b.score - a.score)) {
    if (picked.some((p) => p.s === c.s)) continue;
    if (picked.length && (c.hit < Math.min(2, qt.size) || c.score < picked[0]!.score * 0.5)) continue;
    picked.push(c);
    if (picked.length >= max) break;
  }
  return picked.map((p) => `${/[.!?]$/.test(p.s) ? p.s : `${p.s}.`} [${p.marker}]`).join(" ");
}
