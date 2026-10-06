/**
 * Sensitive-data detection — pure, deterministic, no I/O.
 *
 * Detectors return matches with spans (redactable values: SSNs, cards, keys…)
 * or document-level signals (source code, contracts, payroll…). Every match
 * carries a confidence and the basis for it, so classification results are
 * explainable. Raw matched values exist only in memory; callers persist
 * counts, categories, confidence and fingerprints — never the values.
 */

export const CATEGORIES = ["pii", "financial", "customer_records", "employee", "credentials", "source_code", "contracts", "trade_secrets", "health", "regulated"] as const;
export type BuiltinCategory = (typeof CATEGORIES)[number];
export type Confidence = "low" | "medium" | "high";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export type DetectionMethod = "pattern" | "checksum" | "keyword" | "heuristic" | "custom" | "manual";

export const CATEGORY_META: Record<BuiltinCategory, { label: string; sensitivity: Sensitivity }> = {
  pii: { label: "Personal information (PII)", sensitivity: "confidential" },
  financial: { label: "Financial data", sensitivity: "restricted" },
  customer_records: { label: "Customer records", sensitivity: "confidential" },
  employee: { label: "Employee information", sensitivity: "confidential" },
  credentials: { label: "Credentials & secrets", sensitivity: "restricted" },
  source_code: { label: "Source code", sensitivity: "confidential" },
  contracts: { label: "Contracts", sensitivity: "confidential" },
  trade_secrets: { label: "Trade secrets", sensitivity: "restricted" },
  health: { label: "Health data", sensitivity: "restricted" },
  regulated: { label: "Regulated records", sensitivity: "restricted" },
};

export const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export interface Match {
  category: string;
  detector: string;
  /** Redaction label, e.g. "SSN". */
  label: string;
  method: DetectionMethod;
  confidence: Confidence;
  basis: string;
  /** Span in the input; absent for document-level signals. */
  start?: number;
  end?: number;
  /** In-memory only. Never persisted. */
  value?: string;
}

export interface CustomRule {
  key: string;
  label: string;
  sensitivity: Sensitivity;
  patterns: string[];
  keywords: string[];
  confidence: Confidence;
}

export interface CategorySummary {
  category: string;
  count: number;
  confidence: Confidence;
  methods: DetectionMethod[];
  detectors: string[];
  basis: string[];
  redactable: number;
}

export const MAX_SCAN_CHARS = 2_000_000;

const near = (text: string, index: number, re: RegExp, window = 48) => re.test(text.slice(Math.max(0, index - window), index + 8).toLowerCase());

// ── Checksums ───────────────────────────────────────────────────────────────

export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function cardBrand(digits: string): string | null {
  const n2 = Number(digits.slice(0, 2));
  const n3 = Number(digits.slice(0, 3));
  const n4 = Number(digits.slice(0, 4));
  const len = digits.length;
  if (digits.startsWith("4") && [13, 16, 19].includes(len)) return "Visa";
  if (((n2 >= 51 && n2 <= 55) || (n4 >= 2221 && n4 <= 2720)) && len === 16) return "Mastercard";
  if ((n2 === 34 || n2 === 37) && len === 15) return "American Express";
  if ((digits.startsWith("6011") || n2 === 65 || (n3 >= 644 && n3 <= 649)) && len >= 16 && len <= 19) return "Discover";
  if (n2 === 35 && len >= 16 && len <= 19) return "JCB";
  if ((n2 === 36 || n2 === 38 || (n3 >= 300 && n3 <= 305)) && len === 14) return "Diners Club";
  return null;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function abaValid(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  const n = d.split("").map(Number);
  const sum = 3 * (n[0]! + n[3]! + n[6]!) + 7 * (n[1]! + n[4]! + n[7]!) + (n[2]! + n[5]! + n[8]!);
  return sum % 10 === 0 && sum > 0;
}

function ssnValid(area: string, group: string, serial: string): boolean {
  return area !== "000" && area !== "666" && area[0] !== "9" && group !== "00" && serial !== "0000";
}

// ── Span detectors ──────────────────────────────────────────────────────────

interface SpanDetector {
  detector: string;
  category: BuiltinCategory;
  label: string;
  re: RegExp;
  /** Return null to reject; otherwise confidence + basis (+ optional value group). */
  check: (m: RegExpExecArray, text: string) => { confidence: Confidence; basis: string; method: DetectionMethod; group?: number } | null;
}

const SECRET_PLACEHOLDER = /^(\*+|x+|\.{3,}|<[^>]*>|\$\{?[A-Za-z_][\w.]*\}?|\{\{[^}]*\}\}|changeme|change[-_]me|password|secret|example|redacted|null|none|true|false|undefined|your[-_].*|xxx.*)$/i;

const SPAN_DETECTORS: SpanDetector[] = [
  {
    detector: "us_ssn", category: "pii", label: "SSN",
    re: /\b(\d{3})-(\d{2})-(\d{4})\b/g,
    check: (m, t) => {
      if (!ssnValid(m[1]!, m[2]!, m[3]!)) return null;
      // A trailing/leading digit run (e.g. part of a longer ID) is not an SSN.
      if (/[\d-]/.test(t[m.index - 1] ?? "") || /[\d-]/.test(t[m.index + m[0].length] ?? "")) return null;
      return near(t, m.index, /ssn|social security|soc\.? sec|taxpayer|tin\b/) ? { confidence: "high", basis: "SSN format and area/group/serial rules, with SSN keyword nearby", method: "pattern" } : { confidence: "medium", basis: "SSN format (AAA-GG-SSSS) with valid area/group/serial", method: "pattern" };
    },
  },
  {
    detector: "us_ssn_unformatted", category: "pii", label: "SSN",
    re: /\b(\d{3})[ ]?(\d{2})[ ]?(\d{4})\b/g,
    check: (m, t) => {
      if (m[0].includes("-") || !ssnValid(m[1]!, m[2]!, m[3]!)) return null;
      return near(t, m.index, /ssn|social security|soc\.? sec/) ? { confidence: "high", basis: "9 digits next to an SSN keyword", method: "keyword" } : null;
    },
  },
  {
    detector: "payment_card", category: "financial", label: "CARD",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (m, t) => {
      const digits = m[0].replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return null;
      // Mixed separators inside one number (e.g. "4111-1111 1111-1111") are fine; trailing digit runs are not.
      if (/\d/.test(t[m.index + m[0].length] ?? "")) return null;
      const brand = cardBrand(digits);
      if (!brand || !luhn(digits)) return null;
      return { confidence: "high", basis: `${brand} number: issuer prefix + length + Luhn checksum`, method: "checksum" };
    },
  },
  {
    detector: "iban", category: "financial", label: "IBAN",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    check: (m) => (ibanValid(m[0]) ? { confidence: "high", basis: "IBAN structure with valid mod-97 check digits", method: "checksum" } : null),
  },
  {
    detector: "aba_routing", category: "financial", label: "ROUTING_NUMBER",
    re: /\b\d{9}\b/g,
    check: (m, t) => (abaValid(m[0]) && near(t, m.index, /routing|\baba\b|\brtn\b|transit/) ? { confidence: "high", basis: "ABA routing checksum with routing keyword nearby", method: "checksum" } : null),
  },
  {
    detector: "bank_account", category: "financial", label: "BANK_ACCOUNT",
    re: /\b(?:account|acct)(?:\s*(?:number|no\.?|num|#))?\s*[:#]?\s*(\d{6,17})\b/gi,
    check: () => ({ confidence: "medium", basis: "Account-number keyword followed by 6–17 digits", method: "keyword", group: 1 }),
  },
  {
    detector: "aws_access_key", category: "credentials", label: "AWS_ACCESS_KEY",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    check: () => ({ confidence: "high", basis: "AWS access key ID format (AKIA/ASIA + 16)", method: "pattern" }),
  },
  {
    detector: "aws_secret_key", category: "credentials", label: "AWS_SECRET_KEY",
    re: /aws_?secret_?access_?key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    check: () => ({ confidence: "high", basis: "aws_secret_access_key assignment with a 40-character secret", method: "keyword", group: 1 }),
  },
  {
    detector: "github_token", category: "credentials", label: "GITHUB_TOKEN",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    check: () => ({ confidence: "high", basis: "GitHub token prefix and length", method: "pattern" }),
  },
  {
    detector: "slack_token", category: "credentials", label: "SLACK_TOKEN",
    re: /\bxox[abposr]-[A-Za-z0-9-]{10,200}\b/g,
    check: () => ({ confidence: "high", basis: "Slack token prefix (xox?-)", method: "pattern" }),
  },
  {
    detector: "stripe_key", category: "credentials", label: "STRIPE_KEY",
    re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,128}\b/g,
    check: () => ({ confidence: "high", basis: "Stripe secret/restricted key prefix", method: "pattern" }),
  },
  {
    detector: "google_api_key", category: "credentials", label: "GOOGLE_API_KEY",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    check: () => ({ confidence: "high", basis: "Google API key format (AIza + 35)", method: "pattern" }),
  },
  {
    detector: "ai_provider_key", category: "credentials", label: "AI_API_KEY",
    re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,200}\b/g,
    check: () => ({ confidence: "high", basis: "AI provider secret key prefix (sk-…)", method: "pattern" }),
  },
  {
    detector: "platform_api_key", category: "credentials", label: "PLATFORM_API_KEY",
    re: /\beaop_[A-Za-z0-9_-]{20,200}\b/g,
    check: () => ({ confidence: "high", basis: "This platform's API key prefix (eaop_)", method: "pattern" }),
  },
  {
    detector: "private_key", category: "credentials", label: "PRIVATE_KEY",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    check: () => ({ confidence: "high", basis: "PEM private key block", method: "pattern" }),
  },
  {
    detector: "jwt", category: "credentials", label: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    check: () => ({ confidence: "medium", basis: "JSON Web Token structure (header.payload.signature)", method: "pattern" }),
  },
  {
    detector: "connection_string", category: "credentials", label: "CONNECTION_STRING",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:([^\s@/]{3,200})@[^\s/]{2,200}/gi,
    check: (m) => (SECRET_PLACEHOLDER.test(m[1]!) ? null : { confidence: "high", basis: "URL with embedded username:password", method: "pattern" }),
  },
  {
    detector: "secret_assignment", category: "credentials", label: "SECRET",
    re: /\b(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?([^\s"',;]{6,200})/gi,
    check: (m) => (SECRET_PLACEHOLDER.test(m[1]!) || /^[a-z_][\w.]*\(|^process\.env|^os\.environ|^env\[/i.test(m[1]!) ? null : { confidence: "medium", basis: "Secret-named key assigned a literal value", method: "keyword", group: 1 }),
  },
  {
    detector: "email", category: "pii", label: "EMAIL",
    re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}\b/g,
    check: () => ({ confidence: "low", basis: "Email address format", method: "pattern" }),
  },
  {
    detector: "phone", category: "pii", label: "PHONE",
    re: /(?<![\d-])(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d-])/g,
    // Business phone numbers are everywhere; on their own they never make content sensitive.
    check: () => ({ confidence: "low", basis: "North-American phone format", method: "pattern" }),
  },
  {
    detector: "date_of_birth", category: "pii", label: "DOB",
    re: /\b(?:dob|d\.o\.b\.|date of birth|birth ?date|born(?: on)?)\s*[:\-]?\s*(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})/gi,
    check: () => ({ confidence: "medium", basis: "Date next to a date-of-birth keyword", method: "keyword", group: 1 }),
  },
  {
    detector: "customer_id", category: "customer_records", label: "CUSTOMER_ID",
    re: /\b(?:customer|client|cust|member|account holder)\s*(?:id|number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,30})\b/gi,
    check: () => ({ confidence: "medium", basis: "Customer-identifier keyword followed by an identifier", method: "keyword", group: 1 }),
  },
  {
    detector: "employee_id", category: "employee", label: "EMPLOYEE_ID",
    re: /\b(?:employee|emp|staff|worker)\s*(?:id|number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,20})\b/gi,
    check: () => ({ confidence: "medium", basis: "Employee-identifier keyword followed by an identifier", method: "keyword", group: 1 }),
  },
];

// ── Document-level detectors ────────────────────────────────────────────────

const countDistinct = (text: string, terms: Array<string | RegExp>) => terms.filter((t) => (typeof t === "string" ? text.includes(t) : t.test(text))).length;

const EMPLOYEE_TERMS = ["salary", "payroll", "compensation", "bonus", "net pay", "gross pay", "pay stub", "paystub", "w-2", "hire date", "termination date", "performance review", "pto balance", "401(k)", "withholding", "pay grade", "pay rate"];
const PAYROLL_HEADERS = ["employee", "salary", "ssn", "net pay", "gross", "department", "tax", "bank", "routing", "pay period", "hours", "rate"];
const CONTRACT_TERMS = ["this agreement", "hereinafter", "indemnif", "governing law", "in witness whereof", "terms and conditions", "effective date", "termination of this agreement", "the parties agree", "limitation of liability", "confidentiality obligations", "whereas"];
const TRADE_SECRET_TERMS = ["trade secret", "proprietary and confidential", "confidential - do not distribute", "confidential – do not distribute", "do not distribute", "internal use only", "strictly confidential", "secret formula", "unreleased product", "patent pending"];
const HEALTH_TERMS = ["diagnosis", "patient", "medical record", "mrn", "prescription", "treatment plan", "lab result", "icd-10", "hipaa", "clinical", "physician", "dosage", "medical history"];
const REGULATED_MARKERS: Array<[RegExp, string]> = [
  [/\bhipaa\b/i, "HIPAA"], [/\bpci[- ]?dss\b/i, "PCI DSS"], [/\bgdpr\b/i, "GDPR"], [/\bitar\b/i, "ITAR"], [/\bear99\b|\bexport[- ]controlled\b/i, "export control"],
  [/\bcui\b|controlled unclassified/i, "CUI"], [/\bferpa\b/i, "FERPA"], [/\bsox\b|sarbanes[- ]oxley/i, "SOX"], [/\bglba\b|gramm[- ]leach/i, "GLBA"], [/\bmaterial non[- ]public information\b|\bmnpi\b/i, "MNPI"],
];
const CODE_LINE = /^\s*(?:import\s+[\w{*]|from\s+\S+\s+import\s|export\s+(?:default\s+)?(?:function|const|class|interface|type)|def\s+\w+\s*\(|class\s+\w+[\s:({]|(?:async\s+)?function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|public\s+(?:static\s+)?\w+|private\s+\w+|#include\s*[<"]|package\s+[\w.]+;|using\s+[\w.]+;|return\b|if\s*\(.+\)\s*\{|for\s*\(.+\)\s*\{|}\s*else\s*\{|\w+\s*\(.*\)\s*;\s*$|SELECT\s+.+\s+FROM\s+)|[{};]\s*$|=>\s*[{(]?/;

function documentSignals(text: string, hint?: string): Match[] {
  const lower = text.toLowerCase();
  const out: Match[] = [];
  const hintLower = (hint ?? "").toLowerCase();

  const emp = countDistinct(lower, EMPLOYEE_TERMS);
  const firstLines = lower.split(/\r?\n/, 3).join(" ");
  const headers = countDistinct(firstLines, PAYROLL_HEADERS);
  if (headers >= 3 && (firstLines.includes("salary") || firstLines.includes("net pay") || firstLines.includes("gross"))) out.push({ category: "employee", detector: "payroll_table", label: "PAYROLL", method: "heuristic", confidence: "high", basis: `Tabular header with ${headers} payroll columns (e.g. employee, salary, net pay)` });
  else if (emp >= 3 || (emp >= 2 && /payroll|salary|compensation|hr/.test(hintLower))) out.push({ category: "employee", detector: "employee_terms", label: "EMPLOYEE_DATA", method: "keyword", confidence: emp >= 4 ? "high" : "medium", basis: `${emp} distinct HR/payroll terms${hintLower && /payroll|salary/.test(hintLower) ? " and a payroll-related name" : ""}` });

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const codeLines = lines.filter((l) => CODE_LINE.test(l)).length;
  if (codeLines >= 5 && codeLines / Math.max(lines.length, 1) >= 0.3) out.push({ category: "source_code", detector: "source_code", label: "SOURCE_CODE", method: "heuristic", confidence: codeLines >= 15 ? "high" : "medium", basis: `${codeLines} of ${lines.length} non-empty lines look like code` });
  else if (/^#!\s*\/(?:usr\/)?bin\//.test(text) || /\.(ts|tsx|js|py|java|go|rb|cs|cpp|c|rs|kt|swift|php|scala|sql)$/.test(hintLower)) {
    if (codeLines >= 2) out.push({ category: "source_code", detector: "source_code", label: "SOURCE_CODE", method: "heuristic", confidence: "medium", basis: `${codeLines} code-like lines and a source file name/shebang` });
  }

  const contract = countDistinct(lower, CONTRACT_TERMS);
  if (contract >= 3) out.push({ category: "contracts", detector: "contract_terms", label: "CONTRACT", method: "keyword", confidence: contract >= 5 ? "high" : "medium", basis: `${contract} distinct contract phrases (e.g. "this agreement", "governing law")` });

  const ts = countDistinct(lower, TRADE_SECRET_TERMS);
  if (ts >= 1) out.push({ category: "trade_secrets", detector: "confidentiality_marking", label: "CONFIDENTIAL", method: "keyword", confidence: ts >= 2 ? "high" : "medium", basis: `${ts} confidentiality/trade-secret marking(s)` });

  const health = countDistinct(lower, HEALTH_TERMS);
  const icd = /\b[A-TV-Z][0-9][0-9AB]\.[0-9A-TV-Z]{1,4}\b/.test(text);
  if (health >= 3 || (health >= 2 && icd)) out.push({ category: "health", detector: "health_terms", label: "HEALTH_DATA", method: "keyword", confidence: icd || health >= 5 ? "high" : "medium", basis: `${health} clinical terms${icd ? " and an ICD-10 code" : ""}` });

  const regs = REGULATED_MARKERS.filter(([re]) => re.test(text)).map(([, n]) => n);
  if (regs.length) out.push({ category: "regulated", detector: "regulatory_marking", label: "REGULATED", method: "keyword", confidence: regs.length >= 2 ? "high" : "medium", basis: `Regulatory marking(s): ${regs.join(", ")}` });
  return out;
}

// ── Custom rules ────────────────────────────────────────────────────────────

/** Reject regexes likely to backtrack catastrophically or match everything. */
export function safePattern(p: string): string | null {
  if (p.length === 0 || p.length > 200) return "Pattern must be 1–200 characters.";
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(p)) return "Nested quantifiers are not allowed.";
  if (/\\[1-9]/.test(p)) return "Backreferences are not allowed.";
  try {
    const re = new RegExp(p, "g");
    if (re.test("")) return "Pattern must not match the empty string.";
  } catch (e) {
    return `Invalid regular expression: ${(e as Error).message}`;
  }
  return null;
}

function customMatches(text: string, rules: CustomRule[]): Match[] {
  const out: Match[] = [];
  const lower = text.toLowerCase();
  for (const r of rules) {
    for (const p of r.patterns) {
      if (safePattern(p)) continue;
      const re = new RegExp(p, "g");
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(text)) && n++ < 1000) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push({ category: r.key, detector: `custom:${r.key}`, label: r.label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 30) || "CUSTOM", method: "custom", confidence: r.confidence, basis: `Custom pattern /${p}/`, start: m.index, end: m.index + m[0].length, value: m[0] });
      }
    }
    const hits = r.keywords.filter((k) => k && lower.includes(k.toLowerCase()));
    if (hits.length) out.push({ category: r.key, detector: `custom:${r.key}:keywords`, label: "CUSTOM", method: "custom", confidence: r.confidence, basis: `Custom keyword(s): ${hits.slice(0, 5).join(", ")}` });
  }
  return out;
}

// ── Entry points ────────────────────────────────────────────────────────────

/** Detect sensitive data. `hint` is a file/asset name used as weak evidence. */
export function detect(input: string, opts: { customRules?: CustomRule[]; hint?: string } = {}): Match[] {
  const text = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  const spans: Match[] = [];
  for (const d of SPAN_DETECTORS) {
    const re = new RegExp(d.re.source, d.re.flags);
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) && n++ < 5000) {
      const r = d.check(m, text);
      if (!r) continue;
      let start = m.index;
      let end = m.index + m[0].length;
      let value = m[0];
      if (r.group && m[r.group]) {
        const off = m[0].indexOf(m[r.group]!);
        start = m.index + off;
        end = start + m[r.group]!.length;
        value = m[r.group]!;
      }
      spans.push({ category: d.category, detector: d.detector, label: d.label, method: r.method, confidence: r.confidence, basis: r.basis, start, end, value });
    }
  }
  const custom = customMatches(text, opts.customRules ?? []);
  return [...resolveOverlaps([...spans, ...custom.filter((c) => c.start !== undefined)]), ...custom.filter((c) => c.start === undefined), ...documentSignals(text, opts.hint)];
}

/** Keep the strongest match among overlapping spans (higher confidence, then longer). */
export function resolveOverlaps(matches: Match[]): Match[] {
  const sorted = [...matches].sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || b.end! - b.start! - (a.end! - a.start!) || a.start! - b.start!);
  const kept: Match[] = [];
  for (const m of sorted) {
    if (kept.some((k) => m.start! < k.end! && k.start! < m.end!)) continue;
    kept.push(m);
  }
  return kept.sort((a, b) => a.start! - b.start!);
}

export function summarize(matches: Match[], minConfidence: Confidence = "low"): CategorySummary[] {
  const by = new Map<string, CategorySummary>();
  for (const m of matches) {
    if (CONFIDENCE_RANK[m.confidence] < CONFIDENCE_RANK[minConfidence]) continue;
    const s = by.get(m.category) ?? { category: m.category, count: 0, confidence: "low" as Confidence, methods: [], detectors: [], basis: [], redactable: 0 };
    s.count++;
    if (CONFIDENCE_RANK[m.confidence] > CONFIDENCE_RANK[s.confidence]) s.confidence = m.confidence;
    if (!s.methods.includes(m.method)) s.methods.push(m.method);
    if (!s.detectors.includes(m.detector)) s.detectors.push(m.detector);
    if (!s.basis.includes(m.basis) && s.basis.length < 5) s.basis.push(m.basis);
    if (m.start !== undefined) s.redactable++;
    by.set(m.category, s);
  }
  return [...by.values()].sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || b.count - a.count);
}

export function sensitivityOf(category: string, custom: CustomRule[] = []): Sensitivity {
  return (CATEGORY_META as Record<string, { sensitivity: Sensitivity }>)[category]?.sensitivity ?? custom.find((c) => c.key === category)?.sensitivity ?? "confidential";
}

/** Highest sensitivity among categories detected at ≥ medium confidence (low-confidence signals alone never raise above internal). */
export function overallSensitivity(summaries: CategorySummary[], custom: CustomRule[] = []): Sensitivity {
  let best: Sensitivity = "internal";
  for (const s of summaries) {
    if (s.confidence === "low") continue;
    const v = sensitivityOf(s.category, custom);
    if (SENSITIVITY_RANK[v] > SENSITIVITY_RANK[best]) best = v;
  }
  return best;
}
