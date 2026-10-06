import { describe, expect, it } from "vitest";
import { analyzeAccess, inferExposure, observedExposure } from "../../modules/data-security/src/analysis";
import { abaValid, detect, ibanValid, luhn, overallSensitivity, safePattern, summarize, type Match } from "../../modules/data-security/src/detect";
import { actionFor, decideDlp, fromPolicyEffect, stricter } from "../../modules/data-security/src/dlp";
import { maskValue, redact, safePreview, tokenFor } from "../../modules/data-security/src/redact";
import { matchCatalog, normalizeDomain, toolRisk } from "../../modules/data-security/src/shadow";

const cats = (text: string, min: "low" | "medium" | "high" = "medium") => summarize(detect(text), min).map((s) => s.category).sort();
const detectors = (text: string) => detect(text).map((m) => m.detector);

describe("detection — SSNs", () => {
  it("detects formatted SSNs and raises confidence with a keyword", () => {
    expect(detect("Employee 123-45-6789 joined")[0]).toMatchObject({ detector: "us_ssn", confidence: "medium" });
    expect(detect("SSN: 123-45-6789").find((m) => m.detector === "us_ssn")?.confidence).toBe("high");
  });
  it("detects unformatted SSNs only next to an SSN keyword", () => {
    expect(detectors("social security number 123456789")).toContain("us_ssn_unformatted");
    expect(detectors("order number 123456789")).not.toContain("us_ssn_unformatted");
  });
  it("rejects impossible SSNs (000/666/9xx area, 00 group, 0000 serial)", () => {
    for (const bad of ["000-12-3456", "666-12-3456", "912-34-5678", "123-00-4567", "123-45-0000"]) expect(detectors(`SSN ${bad}`)).not.toContain("us_ssn");
  });
  it("does not mistake dates, phone numbers, ZIP+4 or longer IDs for SSNs", () => {
    for (const t of ["2026-10-06", "Call 555-123-4567", "ZIP 94105-1234", "part 1123-45-67890", "ref 123-45-6789-01", "v1.2.3-45"]) expect(detectors(t), t).not.toContain("us_ssn");
  });
});

describe("detection — financial data", () => {
  it("detects Luhn-valid card numbers by brand, with spaces or dashes", () => {
    for (const c of ["4111 1111 1111 1111", "5555-5555-5555-4444", "378282246310005", "6011111111111117"]) expect(detectors(`card ${c}`), c).toContain("payment_card");
  });
  it("rejects Luhn-invalid numbers, wrong lengths, repeated digits and non-card prefixes", () => {
    for (const c of ["4111 1111 1111 1112", "4111111111111", "0000000000000000", "1234567812345678", "9111111111111111"]) expect(detectors(c), c).not.toContain("payment_card");
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });
  it("validates IBAN check digits and ABA routing checksums", () => {
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(detectors("Pay to IBAN DE89370400440532013000")).toContain("iban");
    expect(abaValid("011000015")).toBe(true);
    expect(abaValid("011000016")).toBe(false);
    expect(detectors("routing number 011000015")).toContain("aba_routing");
    expect(detectors("invoice 011000015")).not.toContain("aba_routing");
  });
  it("detects bank account numbers next to an account keyword", () => {
    const m = detect("Account number: 000123456789").find((x) => x.detector === "bank_account");
    expect(m?.value).toBe("000123456789");
  });
});

describe("detection — credentials and API keys", () => {
  const keys: Array<[string, string]> = [
    ["AKIAIOSFODNN7EXAMPLE", "aws_access_key"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_key"],
    [`ghp_${"a".repeat(36)}`, "github_token"],
    ["xoxb-123456789012-abcdefghij", "slack_token"],
    [`sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`, "stripe_key"],
    [`AIza${"S".repeat(35)}`, "google_api_key"],
    [`sk-ant-api03-${"x".repeat(40)}`, "ai_provider_key"],
    [`eaop_${"k".repeat(32)}`, "platform_api_key"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "private_key"],
    ["postgres://admin:s3cr3tPass@db.internal:5432/app", "connection_string"],
    ['config.password = "Tr0ub4dor&3"', "secret_assignment"],
  ];
  it.each(keys)("detects %s", (text, detector) => {
    expect(detectors(text)).toContain(detector);
    expect(cats(text)).toContain("credentials");
  });
  it("ignores placeholders and environment lookups", () => {
    for (const t of ["password = ********", "password: <your password>", "api_key=${API_KEY}", "token = process.env.TOKEN", "password = changeme", "secret: {{ vault.secret }}", "postgres://user:password@localhost/db"]) {
      expect(cats(t), t).not.toContain("credentials");
    }
  });
});

describe("detection — documents and false positives", () => {
  it("recognises payroll files from their header", () => {
    const payroll = "employee,department,salary,net pay,tax\nJane,Finance,98000,6120,1200";
    expect(detect(payroll).find((m) => m.detector === "payroll_table")).toMatchObject({ category: "employee", confidence: "high" });
  });
  it("recognises source code", () => {
    const code = ["import { x } from './x';", "export function add(a, b) {", "  const c = a + b;", "  if (c > 10) {", "    return c;", "  }", "  return 0;", "}"].join("\n");
    expect(cats(code)).toContain("source_code");
  });
  it("recognises contracts, health, trade-secret and regulatory markings", () => {
    expect(cats("This Agreement is made by the parties. Governing law: NY. Each party shall indemnify the other. In witness whereof.")).toContain("contracts");
    expect(cats("Patient diagnosis: E11.9 type 2 diabetes. Prescription updated in the medical record.")).toContain("health");
    expect(cats("PROPRIETARY AND CONFIDENTIAL — trade secret")).toContain("trade_secrets");
    expect(cats("Contains PCI DSS cardholder scope and GDPR personal data")).toContain("regulated");
  });
  it("benign business text is not sensitive", () => {
    const benign = "Quarterly planning: we shipped 3 features, revenue grew 12% to $4.5M. Meeting on 2026-11-03 at 10:30, room 404. Version 2.14.1 released. Call the front desk at extension 4411.";
    expect(cats(benign)).toEqual([]);
    expect(overallSensitivity(summarize(detect(benign)))).toBe("internal");
  });
  it("emails and plain phone numbers are low-confidence PII that alone never raise sensitivity", () => {
    const s = summarize(detect("Contact jane@example.com or 415 555 0100"));
    expect(s.find((x) => x.category === "pii")?.confidence).toBe("low");
    expect(overallSensitivity(s)).toBe("internal");
  });
  it("a prose mention of a keyword is not a secret", () => {
    expect(cats("Please reset your password using the portal. The API key rotation policy is 90 days.")).toEqual([]);
  });
});

describe("custom classifications", () => {
  const rule = { key: "project_x", label: "Project X", sensitivity: "restricted" as const, patterns: ["PRJX-\\d{4}"], keywords: ["project falcon"], confidence: "high" as const };
  it("matches custom patterns and keywords", () => {
    const m = detect("Ticket PRJX-1234 relates to Project Falcon", { customRules: [rule] });
    expect(m.filter((x) => x.category === "project_x").length).toBe(2);
    expect(overallSensitivity(summarize(m), [rule])).toBe("restricted");
  });
  it("rejects dangerous or empty-matching regexes", () => {
    expect(safePattern("(a+)+$")).toMatch(/Nested/);
    expect(safePattern("(\\w)\\1")).toMatch(/Backreferences/);
    expect(safePattern("x*")).toMatch(/empty/);
    expect(safePattern("[")).toMatch(/Invalid/);
    expect(safePattern("ACME-\\d{6}")).toBeNull();
  });
});

describe("redaction", () => {
  const text = "SSN 123-45-6789, card 4111 1111 1111 1111, key AKIAIOSFODNN7EXAMPLE, mail jane@example.com.";
  const matches = detect(text);
  it("masks with standard partial reveal and never reveals secrets", () => {
    const r = redact(text, matches, { mode: "mask" });
    expect(r.text).toContain("***-**-6789");
    expect(r.text).toContain("1111");
    expect(r.text).not.toContain("4111 1111 1111 1111");
    expect(r.text).toContain("[REDACTED:AWS_ACCESS_KEY]");
    expect(r.text).not.toContain("AKIA");
    expect(r.text).toContain("j***@example.com");
    expect(r.redacted).toBe(4);
  });
  it("labels and tokenizes deterministically per key without the original value", () => {
    expect(redact(text, matches, { mode: "label" }).text).toBe("SSN [SSN], card [CARD], key [AWS_ACCESS_KEY], mail [EMAIL].");
    const t1 = redact("123-45-6789", detect("123-45-6789"), { mode: "tokenize", tokenKey: "k1" }).text;
    const t2 = redact("again 123-45-6789", detect("again 123-45-6789"), { mode: "tokenize", tokenKey: "k1" }).text;
    expect(t1).toMatch(/^\[SSN:tok_[A-Za-z0-9_-]{12}\]$/);
    expect(t2.endsWith(t1)).toBe(true);
    expect(tokenFor("k2", "SSN", "123-45-6789")).not.toBe(tokenFor("k1", "SSN", "123-45-6789"));
    expect(t1).not.toContain("6789");
  });
  it("redacts only the requested categories and leaves the rest intact", () => {
    const r = redact(text, matches, { mode: "label", categories: new Set(["pii"]) });
    expect(r.text).toContain("[SSN]");
    expect(r.text).toContain("AKIAIOSFODNN7EXAMPLE");
  });
  it("keeps surrounding text byte-for-byte and handles adjacent matches", () => {
    const t = "a123-45-6789b";
    expect(redact(t, detect(t), { mode: "label" }).text).toBe(t); // embedded in a word: not an SSN
    const adj = "123-45-6789 234-56-7890";
    expect(redact(adj, detect(adj), { mode: "label" }).text).toBe("[SSN] [SSN]");
  });
  it("maskValue and safePreview never echo secrets", () => {
    expect(maskValue("GITHUB_TOKEN", `ghp_${"a".repeat(36)}`)).toBe("[REDACTED:GITHUB_TOKEN]");
    expect(safePreview(text, matches)).not.toMatch(/6789|AKIA|4111/);
  });
});

describe("DLP decisions", () => {
  const s = (text: string) => summarize(detect(text));
  it("ALLOWs benign content everywhere except blocked destinations", () => {
    expect(decideDlp(s("Hello team, notes attached."), "approved", []).decision).toBe("ALLOW");
    expect(decideDlp(s("Hello team, notes attached."), "unknown", []).decision).toBe("ALLOW");
    expect(decideDlp(s("Hello team"), "blocked", []).decision).toBe("BLOCK");
  });
  it("REDACTs SSNs for approved AI and BLOCKs credentials", () => {
    const r = decideDlp(s("SSN: 123-45-6789"), "approved", []);
    expect(r).toMatchObject({ decision: "REDACT", redactCategories: ["pii"] });
    expect(decideDlp(s("key AKIAIOSFODNN7EXAMPLE"), "approved", []).decision).toBe("BLOCK");
  });
  it("is stricter for unapproved destinations", () => {
    expect(decideDlp(s("card 4111 1111 1111 1111"), "approved", []).decision).toBe("REDACT");
    expect(decideDlp(s("card 4111 1111 1111 1111"), "unknown", []).decision).toBe("BLOCK");
  });
  it("requires approval for payroll content and for unredactable REDACT categories", () => {
    expect(decideDlp(s("employee,salary,net pay,department\nJane,1,2,3"), "approved", []).decision).toBe("REQUIRE_APPROVAL");
    const r = decideDlp(s("Patient diagnosis E11.9, treatment plan and prescription"), "approved", []);
    expect(r.decision).toBe("REQUIRE_APPROVAL");
    expect(r.reasons.join(" ")).toMatch(/cannot be redacted/);
  });
  it("restricted destinations need approval for any sensitive content", () => {
    expect(decideDlp(s("SSN: 123-45-6789"), "restricted", []).decision).toBe("REQUIRE_APPROVAL");
  });
  it("respects organization overrides and minimum confidence", () => {
    expect(decideDlp(s("SSN: 123-45-6789"), "approved", [{ category: "pii", approved: "BLOCK", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "mask" }]).decision).toBe("BLOCK");
    expect(decideDlp(s("mail jane@example.com"), "approved", [{ category: "pii", approved: "BLOCK", unapproved: "BLOCK", minConfidence: "medium", redactionMode: "mask" }]).decision).toBe("ALLOW");
    expect(actionFor("unknown_custom", []).unapproved).toBe("BLOCK");
  });
  it("policy effects only tighten", () => {
    expect(stricter("REDACT", fromPolicyEffect("ALLOW"))).toBe("REDACT");
    expect(stricter("REDACT", fromPolicyEffect("DENY"))).toBe("BLOCK");
    expect(stricter("ALLOW", fromPolicyEffect("ESCALATE"))).toBe("REQUIRE_APPROVAL");
  });
});

describe("permission and AI exposure analysis", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  it("ranks public restricted data critical and recommends removing sharing", () => {
    const f = analyzeAccess({ sensitivity: "restricted", permissions: { scope: "public", publicLink: true }, hasOwner: true }, { now, inactiveEmails: new Set() });
    expect(f[0]).toMatchObject({ severity: "critical" });
    expect(f.map((x) => x.kind)).toEqual(expect.arrayContaining(["public_link", "sensitive_broad_access"]));
  });
  it("flags broad groups, departed and stale users, inherited access and missing owners", () => {
    const f = analyzeAccess({
      sensitivity: "confidential", hasOwner: false,
      permissions: { scope: "group", principals: [{ type: "group", name: "Everyone", inherited: true }, { type: "user", email: "gone@example.com" }, { type: "user", email: "old@example.com", lastActiveAt: "2026-01-01T00:00:00Z" }, { type: "group", name: "Finance", memberCount: 40 }] },
    }, { now, inactiveEmails: new Set(["gone@example.com"]) });
    const kinds = f.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["overly_broad_group", "departed_user", "stale_user", "inherited_access", "no_owner", "sensitive_broad_access"]));
    expect(f.filter((x) => x.kind === "overly_broad_group")).toHaveLength(1);
  });
  it("private internal data has no findings", () => {
    expect(analyzeAccess({ sensitivity: "internal", permissions: { scope: "private" }, hasOwner: false }, { now, inactiveEmails: new Set() })).toEqual([]);
  });
  it("infers copilot exposure for org-wide sharing in collaboration suites, and nothing for internal data", () => {
    expect(inferExposure({ sensitivity: "confidential", sourceSystem: "microsoft_graph", permissions: { scope: "organization" } }).map((e) => e.type)).toEqual(["enterprise_copilot"]);
    expect(inferExposure({ sensitivity: "internal", sourceSystem: "microsoft_graph", permissions: { scope: "public" } })).toEqual([]);
    expect(observedExposure({ trust: "unknown", category: "chat_assistant", actorType: "user" }, "BLOCK", "restricted")).toMatchObject({ type: "employee_ai_tool", severity: "low", basis: "observed" });
  });
});

describe("shadow AI recognition", () => {
  it("normalises domains and URLs and matches subdomains", () => {
    expect(normalizeDomain("https://chatgpt.com/c/123")).toBe("chatgpt.com");
    expect(matchCatalog("eu.chatgpt.com")?.name).toBe("ChatGPT");
    expect(matchCatalog("notchatgpt.com")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
  });
  it("scores risk from status, data categories and population; approved tools are capped", () => {
    expect(toolRisk({ status: "unknown", dataCategories: ["credentials", "pii"], userCount: 120 }).level).toBe("critical");
    expect(toolRisk({ status: "approved", dataCategories: ["credentials", "pii", "financial"], userCount: 500 }).score).toBeLessThanOrEqual(40);
  });
});

describe("summaries never carry raw values", () => {
  it("summaries contain counts and basis only", () => {
    const m: Match[] = detect("SSN: 123-45-6789 and AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(summarize(m))).not.toMatch(/123-45-6789|AKIAIOSFODNN7EXAMPLE/);
  });
});
