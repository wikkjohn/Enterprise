import { createHmac } from "node:crypto";
import { type Match } from "./detect";

/**
 * Redaction — pure. Replaces matched spans; never returns or stores the
 * originals.
 *
 *  - mask:     keeps a minimal hint where that is standard practice (last 4
 *              digits of cards/accounts/SSNs), otherwise fully masks.
 *              Secrets are never partially revealed.
 *  - tokenize: a deterministic, non-reversible token per organization
 *              (HMAC-SHA256 with the org's tokenization key), so the same
 *              value maps to the same token across prompts without the
 *              platform storing the value or a lookup table.
 *  - label:    a typed placeholder, e.g. [SSN] or [CARD].
 */
export const REDACTION_MODES = ["mask", "tokenize", "label"] as const;
export type RedactionMode = (typeof REDACTION_MODES)[number];

const LAST4 = new Set(["SSN", "CARD", "BANK_ACCOUNT", "IBAN", "ROUTING_NUMBER"]);

export function maskValue(label: string, value: string): string {
  if (LAST4.has(label)) {
    const digits = value.replace(/[^0-9A-Za-z]/g, "");
    const tail = digits.slice(-4);
    if (label === "SSN") return `***-**-${tail}`;
    return `${"•".repeat(Math.max(digits.length - 4, 4))}${tail}`;
  }
  if (label === "EMAIL") {
    const [local, domain] = value.split("@");
    return `${(local ?? "").slice(0, 1)}***@${domain ?? "***"}`;
  }
  // Credentials and everything else: no partial reveal.
  return `[REDACTED:${label}]`;
}

export function tokenFor(key: string, label: string, value: string): string {
  const h = createHmac("sha256", key).update(`${label}\u0000${value.replace(/[\s-]/g, "")}`).digest("base64url").slice(0, 12);
  return `[${label}:tok_${h}]`;
}

export interface RedactionResult {
  text: string;
  redacted: number;
  byLabel: Record<string, number>;
}

/**
 * Apply redaction to the spans in `matches` whose category is in `categories`
 * (all spans when omitted). Overlapping spans must already be resolved
 * (detect() does this).
 */
export function redact(text: string, matches: Match[], opts: { mode: RedactionMode | ((m: Match) => RedactionMode); tokenKey?: string; categories?: Set<string> }): RedactionResult {
  const spans = matches
    .filter((m) => m.start !== undefined && m.end !== undefined && (!opts.categories || opts.categories.has(m.category)))
    .sort((a, b) => a.start! - b.start!);
  let out = "";
  let pos = 0;
  const byLabel: Record<string, number> = {};
  let n = 0;
  for (const m of spans) {
    if (m.start! < pos) continue; // defensive: overlapping span
    const value = text.slice(m.start, m.end);
    const mode = typeof opts.mode === "function" ? opts.mode(m) : opts.mode;
    const replacement = mode === "label" ? `[${m.label}]` : mode === "tokenize" ? (opts.tokenKey ? tokenFor(opts.tokenKey, m.label, value) : `[${m.label}]`) : maskValue(m.label, value);
    out += text.slice(pos, m.start) + replacement;
    pos = m.end!;
    byLabel[m.label] = (byLabel[m.label] ?? 0) + 1;
    n++;
  }
  out += text.slice(pos);
  return { text: out, redacted: n, byLabel };
}

/**
 * A short preview safe to persist: every detected span (any category) is
 * label-redacted, then truncated.
 */
export function safePreview(text: string, matches: Match[], max = 600): string {
  const r = redact(text, matches, { mode: "label" }).text;
  return r.length > max ? `${r.slice(0, max)}…` : r;
}
