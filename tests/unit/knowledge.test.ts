import { describe, expect, it } from "vitest";
import { compare, contradictions } from "../../modules/knowledge-verification/src/conflicts";
import { extract, formatFromName, htmlToText, parseCsv } from "../../modules/knowledge-verification/src/extract";
import { categorize, DEFAULT_CATEGORIES, freshnessOf, rank } from "../../modules/knowledge-verification/src/rank";
import { chunk, minhash, quantities, sha256, similarity } from "../../modules/knowledge-verification/src/text";
import { assessConfidence, extractClaims, extractiveAnswer, verifyClaim, type SourcePassage } from "../../modules/knowledge-verification/src/verify";
import { docx, pdf, pptx, xlsx } from "../helpers/office";

const src = (marker: string, text: string, extra: Partial<SourcePassage> = {}): SourcePassage => ({ marker, chunkId: `c-${marker}`, documentId: `d-${marker}`, title: `Doc ${marker}`, text, authority: "authoritative", freshness: "fresh", score: 0.8, ...extra });

describe("extraction", () => {
  it("detects formats from names and MIME types", () => {
    expect(formatFromName("Policy.DOCX")).toBe("docx");
    expect(formatFromName("x", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx");
    expect(formatFromName("notes.md")).toBe("txt");
    expect(formatFromName("binary.exe")).toBeNull();
  });
  it("extracts DOCX paragraphs, headings and title", () => {
    const e = extract("docx", docx([{ heading: "Travel" }, "Meals are reimbursed up to $50 per day.", "Receipts are required."], "Travel Policy"));
    expect(e.text).toContain("# Travel");
    expect(e.text).toContain("Meals are reimbursed up to $50 per day.");
    expect(e.headings).toEqual(["Travel"]);
    expect(e.metadata.title).toBe("Travel Policy");
  });
  it("extracts XLSX rows as header: value statements and PPTX slides", () => {
    const x = extract("xlsx", xlsx("Limits", [["Item", "Limit"], ["Hotel", "250"], ["Meals", "50"]]));
    expect(x.text).toContain("Item: Hotel; Limit: 250");
    const p = extract("pptx", pptx([["Security basics", "Rotate passwords every 90 days"], ["Phishing", "Report suspicious mail"]]));
    expect(p.text).toContain("# Slide 1: Security basics");
    expect(p.text).toContain("Rotate passwords every 90 days");
  });
  it("extracts text from Flate-compressed PDF content streams", () => {
    const e = extract("pdf", pdf(["Remote work requires manager approval.", "Equipment is provided (laptop)."]));
    expect(e.text).toContain("Remote work requires manager approval.");
    expect(e.text).toContain("Equipment is provided (laptop).");
    expect(e.warnings).toEqual([]);
  });
  it("warns when a PDF has no extractable text and rejects non-PDFs", () => {
    expect(extract("pdf", Buffer.from("%PDF-1.4\n%%EOF")).warnings[0]).toMatch(/OCR/);
    expect(() => extract("pdf", Buffer.from("hello"))).toThrow(/Not a PDF/);
    expect(() => extract("docx", Buffer.from("not a zip"))).toThrow(/ZIP/);
  });
  it("strips scripts from HTML, keeps headings; parses quoted CSV", () => {
    const h = htmlToText("<html><title>T</title><script>alert(1)</script><h2>Leave</h2><p>Employees get 20 days &amp; more.</p></html>");
    expect(h.text).not.toContain("alert");
    expect(h.text).toContain("Employees get 20 days & more.");
    expect(h.headings).toEqual(["Leave"]);
    expect(parseCsv('a,b\n"x, y","he said ""hi"""')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });
});

describe("chunking and hashing", () => {
  it("chunks by headings and size, with offsets and stable hashes", () => {
    const text = `# Intro\n\n${"Alpha sentence here. ".repeat(30)}\n\n# Policy\n\n${"Beta rule applies. ".repeat(80)}`;
    const cs = chunk(text, { target: 500, max: 800 });
    expect(cs.length).toBeGreaterThan(2);
    expect(cs[0]!.heading).toBe("Intro");
    expect(cs.at(-1)!.heading).toBe("Policy");
    expect(cs.every((c) => c.text.length <= 800 + 200)).toBe(true);
    expect(cs.map((c) => c.ordinal)).toEqual(cs.map((_, i) => i));
    expect(chunk(text, { target: 500, max: 800 }).map((c) => c.hash)).toEqual(cs.map((c) => c.hash));
    expect(sha256("a")).toHaveLength(64);
  });
  it("parses quantities with units and ignores dates, versions and IDs", () => {
    expect(quantities("Up to $1,200 within 30 days or 15% of salary").map((q) => [q.value, q.unit])).toEqual([[1200, "usd"], [30, "day"], [15, "percent"]]);
    expect(quantities("Effective 2026-10-06, version 1.2.3, invoice INV-2201, in 2025")).toEqual([]);
  });
});

describe("duplicates and conflicts", () => {
  const base = { effectiveDate: null, lastModifiedAt: null };
  const doc = (id: string, title: string, text: string, eff: string | null = null) => ({ ...base, id, title, text, hash: sha256(text), signature: minhash(text), effectiveDate: eff ? new Date(eff) : null });
  const policy = "Employees may work remotely up to 3 days per week with manager approval. Equipment is provided by IT. Expenses for home internet are reimbursed up to $40 per month. Security training is mandatory every year for all staff.";
  it("detects exact and near duplicates", () => {
    expect(compare(doc("a", "Remote", policy), doc("b", "Remote copy", policy))?.kind).toBe("duplicate");
    const near = compare(doc("a", "Remote", policy), doc("b", "Remote 2", `${policy} Questions go to HR.`));
    expect(near?.kind).toBe("near_duplicate");
    expect(near!.similarity).toBeGreaterThan(0.8);
  });
  it("flags contradictory numbers without choosing a winner, and reports which is newer", () => {
    const v2 = policy.replace("up to 3 days", "up to 2 days");
    const r = compare(doc("a", "Remote work policy", policy, "2025-01-01"), doc("b", "Remote work policy 2026", v2, "2026-01-01"))!;
    expect(r.kind).toBe("contradiction");
    expect(r.newer).toBe("b");
    expect(r.evidence[0]!.reason).toMatch(/different values/);
    expect(r.detail).toMatch(/does not decide/);
  });
  it("flags opposite polarity and newer versions; ignores unrelated documents", () => {
    expect(contradictions("Contractors are allowed to access the VPN from personal devices.", "Contractors are not allowed to access the VPN from personal devices.")[0]?.reason).toMatch(/opposite/);
    const v2 = `${policy} This version adds a section on coworking spaces and travel between offices for staff members.`;
    expect(compare(doc("a", "Remote work policy v1", policy, "2025-01-01"), doc("b", "Remote work policy v2", v2, "2026-01-01"))?.kind).toMatch(/newer_version|near_duplicate/);
    expect(compare(doc("a", "Remote", policy), doc("b", "Cafeteria menu", "Monday: pasta. Tuesday: tacos. Wednesday: soup and salad bar."))).toBeNull();
    expect(similarity(minhash("a b c d e f g"), minhash("a b c d e f g"))).toBe(1);
  });
});

describe("claims and verification", () => {
  const sources = [
    src("S1", "Meals are reimbursed up to $50 per day when travelling. Receipts are required for all expenses."),
    src("S2", "Hotel stays are reimbursed up to $250 per night in major cities.", { authority: "preferred" }),
  ];
  it("extracts claims with citations and skips hedges and questions", () => {
    const c = extractClaims("Meals are reimbursed up to $50 per day [S1]. Do you need a receipt? I don't know about taxis. Receipts are required for all expenses [S1][S2].");
    expect(c.map((x) => x.text)).toEqual(["Meals are reimbursed up to $50 per day.", "Receipts are required for all expenses."]);
    expect(c[0]).toMatchObject({ important: true, cited: ["S1"] });
    expect(c[1]!.cited).toEqual(["S1", "S2"]);
  });
  it("VERIFIED when a source states it, with the same figures", () => {
    const v = verifyClaim(extractClaims("Meals are reimbursed up to $50 per day [S1].")[0]!, sources);
    expect(v.status).toBe("VERIFIED");
    expect(v.explanation).toMatch(/Stated in S1/);
  });
  it("CONTRADICTED when a source states different figures or the opposite", () => {
    const v = verifyClaim(extractClaims("Meals are reimbursed up to $75 per day [S1].")[0]!, sources);
    expect(v.status).toBe("CONTRADICTED");
    expect(v.explanation).toMatch(/\$50/);
    expect(verifyClaim(extractClaims("Receipts are not required for expenses.")[0]!, sources).status).toBe("CONTRADICTED");
  });
  it("UNSUPPORTED when nothing retrieved says it; PARTIALLY_VERIFIED for related content", () => {
    expect(verifyClaim(extractClaims("Employees receive a company car after two years.")[0]!, sources).status).toBe("UNSUPPORTED");
    const p = verifyClaim(extractClaims("Meals and taxis are reimbursed when travelling abroad for conferences.")[0]!, sources);
    expect(p.status).toBe("PARTIALLY_VERIFIED");
  });
  it("notes citations that point to the wrong or a missing source", () => {
    expect(verifyClaim(extractClaims("Meals are reimbursed up to $50 per day [S2].")[0]!, sources).explanation).toMatch(/cited S2, but the support is in S1/);
    expect(verifyClaim(extractClaims("Meals are reimbursed up to $50 per day [S9].")[0]!, sources).explanation).toMatch(/S9, which is not among/);
  });
  it("disagreeing sources make a claim only partially verified", () => {
    const v = verifyClaim(extractClaims("Meals are reimbursed up to $50 per day.")[0]!, [...sources, src("S3", "Meals are reimbursed up to $40 per day when travelling.", { authority: "secondary" })]);
    expect(v.status).toBe("PARTIALLY_VERIFIED");
    expect(v.explanation).toMatch(/disagree/);
  });
  it("splits claims when the marker follows the full stop (extractive format)", () => {
    const c = extractClaims("Meals are reimbursed up to $50 per day. [S1] Receipts are required for all expenses. [S2]");
    expect(c.map((x) => [x.text, x.cited])).toEqual([["Meals are reimbursed up to $50 per day.", ["S1"]], ["Receipts are required for all expenses.", ["S2"]]]);
  });
  it("extractive answers do not pad with loosely related sentences", () => {
    const a = extractiveAnswer("How much are meals reimbursed per day when travelling?", [
      ...sources,
      src("S3", "Expenses for home internet are reimbursed up to $40 per month. Every new hire receives a laptop on their first day."),
    ]);
    expect(a).toContain("Meals are reimbursed up to $50 per day");
    expect(a).not.toContain("home internet");
    expect(a).not.toContain("laptop");
  });
  it("extractive answers quote and cite the best sentences", () => {
    const a = extractiveAnswer("How much are meals reimbursed per day?", sources);
    expect(a).toMatch(/Meals are reimbursed up to \$50 per day when travelling\. \[S1\]/);
  });
});

describe("confidence (rule-based, no percentages)", () => {
  const verified = (text: string, supporting: string[]) => ({ ...extractClaims(text)[0]!, status: "VERIFIED" as const, explanation: "", supporting, contradicting: [], coverage: 1 });
  it("high: important claims verified by agreeing authoritative sources", () => {
    const c = assessConfidence({ sources: [src("S1", "x"), src("S2", "y")], claims: [verified("Meals are reimbursed up to $50 per day.", ["S1", "S2"])], openConflicts: 0, topRetrieval: 0.7 });
    expect(c.level).toBe("high");
    expect(c.factors.map((f) => f.factor)).toEqual(["retrieval_strength", "source_quality", "supporting_sources", "source_agreement", "freshness", "claim_verification"]);
    expect(JSON.stringify(c)).not.toMatch(/\d+%/);
  });
  it("low: unsupported important claims, open conflicts or deprecated-only support", () => {
    const bad = { ...extractClaims("Meals are reimbursed up to $90 per day.")[0]!, status: "UNSUPPORTED" as const, explanation: "", supporting: [], contradicting: [], coverage: 0 };
    expect(assessConfidence({ sources: [src("S1", "x")], claims: [verified("Receipts are required for all expenses.", ["S1"]), bad], openConflicts: 0, topRetrieval: 0.7 }).level).toBe("low");
    expect(assessConfidence({ sources: [src("S1", "x")], claims: [verified("Receipts are required for all expenses.", ["S1"])], openConflicts: 1, topRetrieval: 0.7 }).level).toBe("low");
    expect(assessConfidence({ sources: [src("S1", "x", { authority: "deprecated" })], claims: [verified("Receipts are required for all expenses.", ["S1"])], openConflicts: 0, topRetrieval: 0.7 }).level).toBe("low");
  });
  it("insufficient without sources; medium for stale or single secondary support", () => {
    expect(assessConfidence({ sources: [], claims: [], openConflicts: 0, topRetrieval: 0 }).level).toBe("insufficient");
    expect(assessConfidence({ sources: [src("S1", "x", { freshness: "stale" })], claims: [verified("Receipts are required for all expenses.", ["S1"])], openConflicts: 0, topRetrieval: 0.7 }).level).toBe("medium");
    expect(assessConfidence({ sources: [src("S1", "x", { authority: "secondary" })], claims: [verified("Receipts are required for all expenses.", ["S1"])], openConflicts: 0, topRetrieval: 0.7 }).level).toBe("medium");
  });
});

describe("ranking, freshness and escalation", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  it("expired documents are excluded; stale ones are down-weighted", () => {
    expect(freshnessOf({ expirationDate: new Date("2026-01-01"), reviewDueAt: null, lastModifiedAt: null }, now, 365)).toBe("expired");
    expect(freshnessOf({ expirationDate: null, reviewDueAt: new Date("2026-09-01"), lastModifiedAt: null }, now, 365)).toBe("stale");
    expect(freshnessOf({ expirationDate: null, reviewDueAt: null, lastModifiedAt: new Date("2024-01-01") }, now, 365)).toBe("stale");
    expect(freshnessOf({ expirationDate: new Date("2027-01-01"), reviewDueAt: null, lastModifiedAt: new Date("2026-09-01") }, now, 365)).toBe("fresh");
  });
  it("source authority outranks small relevance differences", () => {
    const r = rank([
      { id: "dep", relevance: 0.9, authority: "deprecated" as const, freshness: "fresh" as const, effectiveDate: null },
      { id: "auth", relevance: 0.7, authority: "authoritative" as const, freshness: "fresh" as const, effectiveDate: null },
      { id: "exp", relevance: 1, authority: "authoritative" as const, freshness: "expired" as const, effectiveDate: null },
    ]);
    expect(r.map((x) => x.id)).toEqual(["auth", "dep"]);
  });
  it("categorizes questions for expert escalation", () => {
    expect(categorize("Can I be fired for refusing unsafe work near a chemical spill?", DEFAULT_CATEGORIES).map((c) => c.key).sort()).toEqual(["hr", "safety"]);
    expect(categorize("Where is the cafeteria?", DEFAULT_CATEGORIES)).toEqual([]);
    expect(categorize("Do warehouse visitors need a hard hat?", DEFAULT_CATEGORIES).map((c) => c.key)).toEqual(["safety"]);
  });
});
