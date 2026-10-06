import { createHash } from "node:crypto";

/**
 * Text utilities shared by chunking, duplicate/conflict detection and claim
 * verification. Pure and deterministic.
 */

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const STOP = new Set(
  "a an the and or but if then else of to in on at by for with from as is are was were be been being this that these those it its it's into about over under than so such not no nor do does did done have has had having can could should would will shall may might must our your their his her we you they i me my us them what which who whom whose when where why how all any each both few more most other some own same very just also only up down out off again further once here there per up via each every".split(" "),
);
/** Words that flip meaning; kept out of stop-word removal so negation can be compared. */
export const NEGATIONS = new Set(["not", "no", "never", "none", "cannot", "can't", "won't", "isn't", "aren't", "doesn't", "don't", "mustn't", "shouldn't", "prohibited", "forbidden", "without"]);

/** Light suffix stemming — enough to align "reimbursed"/"reimbursement"/"reimburse". */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ["ations", "ation", "ments", "ment", "ings", "ing", "ies", "ied", "ers", "er", "ed", "es", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return suf === "ies" || suf === "ied" ? `${w.slice(0, -3)}y` : w.slice(0, -suf.length);
  }
  return w;
}

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).map((w) => w.replace(/^'+|'+$/g, ""));
}

/** Content terms (stop words removed, stemmed, numbers kept as-is). */
export function terms(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w) && !NEGATIONS.has(w) && w.length > 1).map((w) => (/^\d/.test(w) ? w : stem(w)));
}

export const hasNegation = (text: string) => words(text).some((w) => NEGATIONS.has(w)) || /\bmay not\b|\bmust not\b|\bis not\b/i.test(text);

export interface Quantity { value: number; unit: string; raw: string }

/** Numbers with their unit/currency, normalised ("$1,200" → 1200 usd; "30 days" → 30 day; "15%" → 15 percent). */
export function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  const re = /([$€£])\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)?|(\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent|days?|business days?|weeks?|months?|years?|hours?|minutes?|usd|eur|gbp|dollars?|euros?|employees?|people|times?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) {
      let v = Number(m[2]!.replace(/,/g, ""));
      const mult = (m[3] ?? "").toLowerCase();
      if (mult === "k" || mult === "thousand") v *= 1000;
      if (mult === "m" || mult === "million") v *= 1_000_000;
      out.push({ value: v, unit: { $: "usd", "€": "eur", "£": "gbp" }[m[1]] ?? "money", raw: m[0].trim() });
    } else if (m[4]) {
      // Skip parts of dates, versions and identifiers (2026-10-06, 1.2.3, INV-2201).
      const before = text[m.index - 1] ?? "";
      const after = text[m.index + m[0].length] ?? "";
      if (/[-./A-Za-z]/.test(before) || /^[-./]\d/.test(text.slice(m.index + m[4].length, m.index + m[4].length + 2))) continue;
      if (/[A-Za-z]/.test(after) && !m[5]) continue;
      let unit = (m[5] ?? "").toLowerCase().replace(/\s+/g, " ");
      unit = unit.startsWith("business day") ? "business day" : unit.replace(/s$/, "");
      if (unit === "%" || unit === "per cent") unit = "percent";
      if (unit === "dollar") unit = "usd";
      if (unit === "euro") unit = "eur";
      const value = Number(m[4].replace(/,/g, ""));
      if (!unit && value >= 1900 && value <= 2100 && Number.isInteger(value)) continue; // a bare year
      out.push({ value, unit, raw: m[0].trim() });
    }
  }
  return out;
}

export function sentences(text: string): string[] {
  return text
    .replace(/\n+/g, "\n")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n/)
    .map((s) => s.replace(/^[#\-*•\s]+/, "").trim())
    .filter((s) => s.length > 2);
}

// ── Near-duplicate detection (word shingles + MinHash) ──────────────────────
const NUM_HASHES = 64;
const fnv = (s: string, seed: number) => {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

export function shingles(text: string, k = 5): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length < k) {
    if (w.length) out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + k <= w.length && out.size < 50_000; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function minhash(text: string): number[] {
  const sh = shingles(text);
  const sig = new Array<number>(NUM_HASHES).fill(0xffffffff);
  for (const s of sh) for (let i = 0; i < NUM_HASHES; i++) {
    const h = fnv(s, i * 0x9e3779b1);
    if (h < sig[i]!) sig[i] = h;
  }
  // Stored as Postgres integer[]: map unsigned 32-bit values to signed (equality is preserved).
  return sig.map((h) => h | 0);
}

/** Estimated Jaccard similarity of two MinHash signatures. */
export function similarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export function termJaccard(a: string, b: string): number {
  const x = new Set(terms(a));
  const y = new Set(terms(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

// ── Chunking ────────────────────────────────────────────────────────────────
export interface Chunk {
  ordinal: number;
  heading: string | null;
  text: string;
  start: number;
  end: number;
  hash: string;
}

/**
 * Split on headings and paragraphs, pack paragraphs up to `target` chars,
 * split oversized paragraphs on sentence boundaries, and carry a short
 * overlap so facts spanning a boundary stay retrievable. Offsets refer to
 * the extracted text (source references / lineage).
 */
export function chunk(text: string, opts: { target?: number; max?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.target ?? 900;
  const max = opts.max ?? 1600;
  const overlap = opts.overlap ?? 150;
  const out: Chunk[] = [];
  let heading: string | null = null;
  let buf = "";
  let bufStart = 0;
  const flush = (end: number) => {
    const t = buf.trim();
    if (t) out.push({ ordinal: out.length, heading, text: t, start: bufStart, end, hash: sha256(t) });
    const tail = t.length > overlap ? t.slice(t.length - overlap) : "";
    const cut = tail.indexOf(" ");
    buf = cut >= 0 ? tail.slice(cut + 1) : "";
    bufStart = Math.max(0, end - buf.length);
  };
  const paraRe = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(text))) {
    const para = m[0];
    const start = m.index;
    const h = /^#{1,6}\s+(.+)$/.exec(para.trim());
    if (h && !para.includes("\n")) {
      if (buf.trim()) flush(start);
      buf = "";
      bufStart = start;
      heading = h[1]!.trim().slice(0, 300);
      continue;
    }
    const pieces = para.length > max ? splitLong(para, max) : [para];
    let off = start;
    for (const piece of pieces) {
      if (buf.length && buf.length + piece.length + 2 > target) flush(off);
      if (!buf.trim()) bufStart = off;
      buf += (buf ? "\n\n" : "") + piece;
      off += piece.length + 1;
    }
  }
  if (buf.trim()) flush(text.length);
  return dedupeOverlapOnly(out);
}

function splitLong(p: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of p.split(/(?<=[.!?;])\s+/)) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur);
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    cur += (cur ? " " : "") + s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Drop chunks that are only carried-over overlap text. */
function dedupeOverlapOnly(chunks: Chunk[]): Chunk[] {
  const kept = chunks.filter((c, i) => !(i > 0 && chunks[i - 1]!.text.endsWith(c.text)));
  return kept.map((c, i) => ({ ...c, ordinal: i }));
}
