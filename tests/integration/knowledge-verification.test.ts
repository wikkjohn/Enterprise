import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AIProvider } from "../../packages/ai/src";
import { and, auditEvents, eq, eventOutbox, memberships, notifications, sql } from "../../packages/db/src";
import { type TenantContext } from "../../packages/shared-types/src";
import { knowledgeService, postgresFtsProvider, type KnowledgeService } from "../../modules/knowledge-verification/src";
import { knowledgeChunks, knowledgeIndexes, knowledgeQueries } from "../../modules/knowledge-verification/src/schema";
import { addMember, createOrg, createTestPlatform, expectCode, systemCtx, uniq } from "../helpers/platform";
import { docx, pdf } from "../helpers/office";

type P = Awaited<ReturnType<typeof createTestPlatform>>;
type Org = Awaited<ReturnType<typeof createOrg>>;
type Member = Awaited<ReturnType<typeof addMember>>;

/** Every prompt that reaches "the model" is captured here — the leakage tests inspect it. */
const prompts: string[] = [];
let reply: string | null = null;
const spyModel: AIProvider = {
  kind: "sandbox",
  async generate(req) {
    const content = `${req.system ?? ""}\n${req.messages.map((m) => m.content).join("\n")}`;
    prompts.push(content);
    const text = reply ?? `[SIMULATED] ${content.slice(-200)}`;
    return { text, servedModel: req.model, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10 } };
  },
};

let p: P;
let svc: KnowledgeService;
let A: Org;
let B: Org;
let hr: Member;
let eng: Member;
let lead: Member;
let viewer: Member;
let policies: { id: string };
let hrSource: { id: string };
let wiki: { id: string };

const setDept = (m: Member, d: string) => p.db.withSystem("test", (tx) => tx.update(memberships).set({ department: d }).where(eq(memberships.id, m.membership.id)));
const ingest = (ctx: TenantContext, sourceId: string, title: string, text: string, extra: Record<string, unknown> = {}) =>
  svc.ingestDocument(ctx, { sourceId, title, text, ...extra });
const outbox = (orgId: string, type: string) => p.db.withSystem("test", (tx) => tx.select().from(eventOutbox).where(and(eq(eventOutbox.organizationId, orgId), eq(eventOutbox.type, type))));
const notes = (userId: string, type: string) => p.db.withSystem("test", (tx) => tx.select().from(notifications).where(and(eq(notifications.recipientUserId, userId), eq(notifications.type, type))));

async function drain() {
  for (let i = 0; i < 20; i++) {
    await p.db.withSystem("test.jobs_due", (tx) => tx.execute(sql`update background_jobs_metadata set run_at = now() where status in ('queued','failed') and type like 'knowledge_verification.%'`));
    if ((await p.jobs.runOnce("test", { batch: 50 })) === 0) return;
  }
}

beforeAll(async () => {
  p = await createTestPlatform({ extraAIProviders: [spyModel] });
  svc = knowledgeService(p);
  A = await createOrg(p);
  B = await createOrg(p);
  for (const o of [A, B]) await p.modules.enable(o.adminCtx(), "knowledge_verification");
  await p.organizations.updateRetention(A.adminCtx(), { aiPromptRetention: "full" });
  hr = await addMember(p, A.org.id, ["standard_user"]);
  eng = await addMember(p, A.org.id, ["standard_user"]);
  lead = await addMember(p, A.org.id, ["department_leader"]);
  viewer = await addMember(p, A.org.id, ["read_only"]);
  await setDept(hr, "HR");
  await setDept(eng, "Engineering");
  policies = await svc.createSource(A.adminCtx(), { name: "Company policies", authority: "authoritative", ownerUserId: A.admin.id });
  hrSource = await svc.createSource(A.adminCtx(), { name: "HR handbook", authority: "preferred", defaultPrincipals: ["dept:hr"], ownerUserId: A.admin.id });
  wiki = await svc.createSource(A.adminCtx(), { name: "Team wiki", authority: "secondary" });
});
afterAll(() => p.close());

describe("Knowledge — registration and entitlement", () => {
  it("registers permissions, events, notification types, jobs and search in the shared registries", async () => {
    for (const k of ["knowledge.read", "knowledge.search", "knowledge.ingest", "knowledge.manage", "knowledge.source.manage", "knowledge.conflict.review", "knowledge.verification.read", "knowledge.admin"]) {
      expect(p.rbac.registry.get(k)?.owner).toBe("knowledge_verification");
    }
    for (const t of ["knowledge.document.ingested", "knowledge.document.updated", "knowledge.conflict.detected", "knowledge.review.required", "knowledge.answer.generated", "knowledge.verification.failed"]) {
      expect(p.events.registry.get(t)?.owner).toBe("knowledge_verification");
    }
    expect(p.notificationTypes.get("knowledge.escalation")).toBeTruthy();
    expect(p.jobs.registeredTypes()).toEqual(expect.arrayContaining(["knowledge_verification.sync", "knowledge_verification.freshness", "knowledge_verification.retention"]));
    const C = await createOrg(p);
    await expectCode(svc.listSources(C.adminCtx()), "MODULE_NOT_ENABLED");
    await expectCode(svc.ask(C.adminCtx(), { question: "What is the travel policy?" }), "MODULE_NOT_ENABLED");
  });
  it("enforces permissions server-side", async () => {
    await expectCode(ingest(eng.ctx(), policies.id, "x", "y"), "FORBIDDEN");
    await expectCode(svc.ask(viewer.ctx(), { question: "What is the travel policy?" }), "FORBIDDEN");
    await expectCode(svc.createSource(lead.ctx(), { name: uniq("s") }), "FORBIDDEN");
    await expectCode(svc.updateSettings(lead.ctx(), { staleDays: 30 }), "FORBIDDEN");
  });
});

describe("Ingestion, formats and versioning", () => {
  it("ingests text, chunks and indexes it, publishes an event and audits", async () => {
    const r = await ingest(A.adminCtx(), policies.id, "Travel policy", "Meals are reimbursed up to $50 per day when travelling. Receipts are required for all expenses. Hotel stays are reimbursed up to $250 per night in major cities.", { owner: A.admin.email });
    expect(r).toMatchObject({ created: true, failed: false });
    expect(r.document).toMatchObject({ version: 1, ingestionStatus: "indexed", status: "active", format: "txt" });
    expect(r.document.chunkCount).toBeGreaterThan(0);
    expect((await outbox(A.org.id, "knowledge.document.ingested")).some((e) => (e.payload as { documentId: string }).documentId === r.document.id)).toBe(true);
    const audits = await p.db.withSystem("test", (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.organizationId, A.org.id), eq(auditEvents.action, "knowledge.document_ingested"))));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("re-ingesting identical content is a no-op; changed content creates a new version and old chunks stop being used", async () => {
    const t1 = "The zorblat parking allowance is $120 per month for all staff.";
    const a = await ingest(A.adminCtx(), policies.id, "Zorblat parking", t1);
    expect((await ingest(A.adminCtx(), policies.id, "Zorblat parking", t1)).unchanged).toBe(true);
    const b = await ingest(A.adminCtx(), policies.id, "Zorblat parking", "The zorblat parking allowance is $180 per month for all staff.");
    expect(b).toMatchObject({ created: false, unchanged: false });
    expect(b.document.id).toBe(a.document.id);
    expect(b.document.version).toBe(2);
    const d = await svc.getDocument(A.adminCtx(), a.document.id);
    expect(d.versions.map((v) => v.version)).toEqual([2, 1]);
    expect((await outbox(A.org.id, "knowledge.document.updated")).some((e) => (e.payload as { documentId: string; version: number }).documentId === a.document.id)).toBe(true);
    const r = await svc.retrieve(A.adminCtx(), { question: "zorblat parking allowance" });
    expect(r.passages.map((x) => x.text).join(" ")).toContain("$180");
    expect(r.passages.map((x) => x.text).join(" ")).not.toContain("$120");
    const old = await p.db.withSystem("test", (tx) => tx.select().from(knowledgeChunks).where(and(eq(knowledgeChunks.documentId, a.document.id), eq(knowledgeChunks.version, 1))));
    expect(old).toHaveLength(0);
  });

  it("extracts DOCX and PDF uploads; rejects unknown formats; records failed extraction", async () => {
    const w = await svc.ingestDocument(A.adminCtx(), { sourceId: policies.id, title: "Glimmerwick onboarding", filename: "onboarding.docx", contentBase64: docx([{ heading: "Glimmerwick laptops" }, "Every glimmerwick hire receives a laptop on day one."]).toString("base64") });
    expect(w.document).toMatchObject({ format: "docx", ingestionStatus: "indexed" });
    const f = await svc.ingestDocument(A.adminCtx(), { sourceId: policies.id, title: "Brindlecove safety", filename: "safety.pdf", contentBase64: pdf(["Brindlecove visitors must wear a hard hat at all times."]).toString("base64") });
    expect(f.document).toMatchObject({ format: "pdf", ingestionStatus: "indexed" });
    expect((await svc.retrieve(A.adminCtx(), { question: "glimmerwick laptop" })).passages[0]?.text).toContain("laptop on day one");
    expect((await svc.retrieve(A.adminCtx(), { question: "brindlecove hard hat" })).passages[0]?.text).toContain("hard hat");
    const titled = await svc.ingestDocument(A.adminCtx(), { sourceId: policies.id, filename: "handbook.docx", contentBase64: docx(["Plumtree desks are assigned weekly."], "Plumtree desk booking").toString("base64") });
    expect(titled.document.title).toBe("Plumtree desk booking");
    await expectCode(svc.ingestDocument(A.adminCtx(), { sourceId: policies.id, text: "No title or filename" }), "VALIDATION_FAILED");
    await expectCode(svc.ingestDocument(A.adminCtx(), { sourceId: policies.id, title: "Mystery", filename: "a.xyz", contentBase64: "AAAA" }), "VALIDATION_FAILED");
    const bad = await svc.ingestDocument(A.adminCtx(), { sourceId: policies.id, title: "Broken", filename: "broken.docx", contentBase64: Buffer.from("not a zip").toString("base64") });
    expect(bad).toMatchObject({ failed: true });
    expect(bad.document.ingestionStatus).toBe("failed");
  });
});

describe("Permission-aware retrieval — unauthorized content never reaches the model", () => {
  const SECRET = "The quillfeather salary band for level 5 is $187,000 per year.";
  let hrDoc: string;
  let privateDoc: string;
  beforeAll(async () => {
    hrDoc = (await ingest(A.adminCtx(), hrSource.id, "Quillfeather salary bands", SECRET)).document.id;
    privateDoc = (await ingest(A.adminCtx(), wiki.id, "Quillfeather bonus memo", "The quillfeather bonus pool is $2,000,000 this year.", { permissions: { scope: "specific", principals: [{ type: "user", email: hr.user.email }] } })).document.id;
  });

  it("a user outside HR gets no passage, no citation and nothing in the prompt", async () => {
    prompts.length = 0;
    const r = await svc.ask(eng.ctx(), { question: "What is the quillfeather salary band and bonus pool?" });
    const all = JSON.stringify(r) + prompts.join("\n");
    expect(all).not.toContain("187,000");
    expect(all).not.toContain("2,000,000");
    expect(r.citations.map((c) => c.documentId)).not.toContain(hrDoc);
    expect(r.citations.map((c) => c.documentId)).not.toContain(privateDoc);
    expect((await svc.retrieve(eng.ctx(), { question: "quillfeather salary band" })).passages.filter((x) => x.documentId === hrDoc)).toHaveLength(0);
    expect((await svc.listDocuments(eng.ctx())).map((d) => d.id)).not.toContain(hrDoc);
    await expectCode(svc.getDocument(eng.ctx(), hrDoc), "NOT_FOUND");
    expect((await svc.searchTitles(eng.ctx(), "Quillfeather", 10)).map((d) => d.id)).not.toContain(hrDoc);
  });

  it("an HR member sees the HR document; only the named user sees the private one", async () => {
    prompts.length = 0;
    reply = "The quillfeather salary band for level 5 is $187,000 per year [S1].";
    const r = await svc.ask(hr.ctx(), { question: "What is the quillfeather salary band for level 5?" });
    reply = null;
    expect(prompts.join("\n")).toContain("187,000");
    expect(r.citations.find((c) => c.documentId === hrDoc)).toBeTruthy();
    expect(r.claims[0]?.status).toBe("VERIFIED");
    expect((await svc.retrieve(hr.ctx(), { question: "quillfeather bonus pool" })).passages.map((x) => x.documentId)).toContain(privateDoc);
    expect((await svc.retrieve(lead.ctx(), { question: "quillfeather bonus pool" })).passages.map((x) => x.documentId)).not.toContain(privateDoc);
  });

  it("someone else's stored answer is hidden from reviewers who cannot access its documents", async () => {
    const [q] = await p.db.withSystem("test", (tx) => tx.select().from(knowledgeQueries).where(and(eq(knowledgeQueries.organizationId, A.org.id), eq(knowledgeQueries.userId, hr.user.id))).orderBy(sql`created_at desc`).limit(1));
    const seen = await svc.getAnswer(lead.ctx(), q!.id);
    expect(seen.response).toBeNull();
    expect(seen.hiddenReason).toMatch(/cannot access/);
    expect(JSON.stringify(seen)).not.toContain("187,000");
    expect(JSON.stringify(seen)).not.toContain("Quillfeather salary bands");
    expect((await svc.getAnswer(hr.ctx(), q!.id)).response).toContain("187,000");
  });

  it("explicit permission changes take effect immediately", async () => {
    await svc.setDocumentPermissions(A.adminCtx(), hrDoc, { mode: "explicit", principals: [`user:${eng.user.id}`] });
    expect((await svc.retrieve(eng.ctx(), { question: "quillfeather salary band" })).passages.map((x) => x.documentId)).toContain(hrDoc);
    expect((await svc.retrieve(hr.ctx(), { question: "quillfeather salary band" })).passages.map((x) => x.documentId)).not.toContain(hrDoc);
    await svc.setDocumentPermissions(A.adminCtx(), hrDoc, { mode: "source_default" });
    expect((await svc.retrieve(eng.ctx(), { question: "quillfeather salary band" })).passages.map((x) => x.documentId)).not.toContain(hrDoc);
  });

  it("source ACL entries that cannot be mapped grant nothing (fail closed)", async () => {
    const d = await ingest(A.adminCtx(), wiki.id, "Pemberline legal memo", "The pemberline settlement amount is confidential.", { permissions: { scope: "group", principals: [{ type: "group", name: "Outside Counsel" }, { type: "user", email: "stranger@elsewhere.test" }] } });
    const full = await svc.getDocument(A.adminCtx(), d.document.id);
    expect(full.permissions?.principals).toEqual([]);
    expect(full.permissions?.unmapped).toHaveLength(2);
    expect((await svc.retrieve(eng.ctx(), { question: "pemberline settlement" })).passages).toHaveLength(0);
    // Even an admin's retrieval is permission-based, not role-based.
    expect((await svc.retrieve(A.adminCtx(), { question: "pemberline settlement" })).passages).toHaveLength(0);
  });

  it("a misbehaving index provider cannot leak: the service re-checks the database ACL", async () => {
    const leaky = { ...postgresFtsProvider, key: uniq("leaky"), description: "returns everything", async search(tx: Parameters<typeof postgresFtsProvider.search>[0], req: { organizationId: string }) {
      const rows = await tx.select({ id: knowledgeChunks.id }).from(knowledgeChunks).where(eq(knowledgeChunks.organizationId, req.organizationId));
      return rows.map((r) => ({ chunkId: r.id, relevance: 0.5 }));
    } };
    svc.registerIndexProvider(leaky);
    await p.db.withSystem("test", (tx) => tx.update(knowledgeIndexes).set({ provider: leaky.key }).where(and(eq(knowledgeIndexes.organizationId, A.org.id), eq(knowledgeIndexes.isDefault, true))));
    try {
      prompts.length = 0;
      const r = await svc.ask(eng.ctx(), { question: "quillfeather salary band" });
      expect(JSON.stringify(r) + prompts.join("\n")).not.toContain("187,000");
      expect(r.citations.map((c) => c.title)).not.toContain("Quillfeather salary bands");
    } finally {
      await p.db.withSystem("test", (tx) => tx.update(knowledgeIndexes).set({ provider: "postgres_fts" }).where(and(eq(knowledgeIndexes.organizationId, A.org.id), eq(knowledgeIndexes.isDefault, true))));
    }
  });
});

describe("Cited answers, verification and confidence", () => {
  it("answers with citations; supported claims are VERIFIED and persisted", async () => {
    reply = "Meals are reimbursed up to $50 per day when travelling [S1].";
    const r = await svc.ask(eng.ctx(), { question: "How much are meals reimbursed per day when travelling?" });
    reply = null;
    expect(r.mode).toBe("generative");
    expect(r.citations[0]).toMatchObject({ marker: "S1", title: "Travel policy", authority: "authoritative", cited: true });
    expect(r.citations[0]!.documentDate).toBeTruthy();
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ status: "VERIFIED", supporting: ["S1"] });
    expect(["high", "medium"]).toContain(r.confidence.level);
    expect(r.confidence.factors.length).toBe(6);
    expect(JSON.stringify(r.confidence)).not.toMatch(/\d+(\.\d+)?%/);
    const again = await svc.getAnswer(eng.ctx(), r.queryId);
    expect(again.claims[0]?.status).toBe("VERIFIED");
    expect(again.citations[0]?.excerpt).toContain("Meals are reimbursed");
    expect((await outbox(A.org.id, "knowledge.answer.generated")).length).toBeGreaterThan(0);
  });

  it("unsupported and contradicted claims are flagged, lower confidence and emit verification.failed", async () => {
    reply = "Meals are reimbursed up to $75 per day when travelling [S1]. Employees receive a company car after two years [S1].";
    const r = await svc.ask(eng.ctx(), { question: "How much are meals reimbursed per day when travelling?" });
    reply = null;
    expect(r.claims.map((c) => c.status)).toEqual(["CONTRADICTED", "UNSUPPORTED"]);
    expect(r.claims[0]!.explanation).toMatch(/\$50/);
    expect(r.verificationFailed).toBe(true);
    expect(["low", "insufficient"]).toContain(r.confidence.level);
    expect(r.uncertainty).toMatch(/unsupported/i);
    expect((await outbox(A.org.id, "knowledge.verification.failed")).some((e) => (e.payload as { answerId: string }).answerId === r.answerId)).toBe(true);
  });

  it("falls back to a labelled extractive answer when the AI provider is simulated", async () => {
    const r = await svc.ask(eng.ctx(), { question: "Are receipts required for expenses?" });
    expect(r.mode).toBe("extractive");
    expect(r.modeNote).toMatch(/simulated/);
    expect(r.response).toMatch(/Receipts are required for all expenses\. \[S\d\]/);
    expect(r.claims.every((c) => c.status === "VERIFIED")).toBe(true);
  });

  it("says plainly when nothing accessible answers the question", async () => {
    prompts.length = 0;
    const r = await svc.ask(eng.ctx(), { question: "xylophrax zeppelin quokka?" });
    expect(r).toMatchObject({ mode: "none", citations: [], claims: [] });
    expect(r.response).toMatch(/No approved information/);
    expect(r.confidence.level).toBe("insufficient");
    expect(prompts).toHaveLength(0);
  });

  it("ranks authoritative sources above secondary and deprecated ones", async () => {
    const text = "Vantablix monitors are replaced every four years by IT.";
    const wikiDoc = await ingest(A.adminCtx(), wiki.id, "Vantablix (wiki)", text);
    const dep = await ingest(A.adminCtx(), policies.id, "Vantablix (old)", text, { authority: "deprecated", externalId: "vantablix-old" });
    const auth = await ingest(A.adminCtx(), policies.id, "Vantablix", text);
    const r = await svc.retrieve(eng.ctx(), { question: "vantablix monitors replaced" });
    const order = r.passages.map((x) => x.documentId);
    expect(order[0]).toBe(auth.document.id);
    expect(order.indexOf(wikiDoc.document.id)).toBeLessThan(order.indexOf(dep.document.id));
    expect(r.passages.find((x) => x.documentId === dep.document.id)?.authority).toBe("deprecated");
  });
});

describe("Freshness: stale and expired documents", () => {
  it("expired documents are never used and land in the review queue", async () => {
    const d = await ingest(A.adminCtx(), policies.id, "Quorvane bonus 2024", "The quorvane holiday bonus is $500 for every employee.", { expirationDate: new Date(Date.now() - 86400_000).toISOString(), owner: A.admin.email });
    expect((await svc.retrieve(A.adminCtx(), { question: "quorvane holiday bonus" })).passages).toHaveLength(0);
    const reviews = await svc.listReviews(A.adminCtx(), { kind: "expired" });
    expect(reviews.find((r) => r.documentId === d.document.id)).toBeTruthy();
  });

  it("stale documents are still usable but flagged, down-weighted and queued; marking reviewed clears it", async () => {
    const d = await ingest(A.adminCtx(), wiki.id, "Thrennic VPN", "The thrennic VPN must be used on public wifi networks.", { lastModifiedAt: new Date(Date.now() - 800 * 86400_000).toISOString() });
    const r = await svc.ask(eng.ctx(), { question: "When must the thrennic VPN be used?" });
    expect(r.citations[0]).toMatchObject({ documentId: d.document.id, freshness: "stale" });
    expect(r.uncertainty).toMatch(/past their review date/);
    expect(r.confidence.level).not.toBe("high");
    expect((await svc.listReviews(A.adminCtx(), { kind: "stale" })).some((x) => x.documentId === d.document.id)).toBe(true);
    expect((await svc.listReviews(A.adminCtx(), { kind: "no_owner" })).some((x) => x.documentId === d.document.id)).toBe(true);
    await svc.markReviewed(A.adminCtx(), d.document.id, { note: "Still correct." });
    expect((await svc.listReviews(A.adminCtx(), { kind: "stale" })).some((x) => x.documentId === d.document.id)).toBe(false);
    expect((await svc.retrieve(eng.ctx(), { question: "thrennic VPN" })).passages[0]?.freshness).toBe("fresh");
  });
});

describe("Duplicates and conflicts — surfaced, never silently resolved", () => {
  const policy = "Employees may work remotely up to 3 days per week with manager approval. Equipment is provided by IT. Expenses for home internet are reimbursed up to $40 per month. Security training is mandatory every year for all staff.";
  let a: string;
  let b: string;
  it("detects a contradiction between two current documents and notifies reviewers; both stay active", async () => {
    a = (await ingest(A.adminCtx(), wiki.id, "Remote work policy", policy, { effectiveDate: "2025-01-01" })).document.id;
    b = (await ingest(A.adminCtx(), policies.id, "Remote work policy 2026", policy.replace("up to 3 days", "up to 2 days"), { effectiveDate: "2026-01-01" })).document.id;
    const c = (await svc.listConflicts(lead.ctx(), { status: "open" })).find((x) => [x.documentA.id, x.documentB.id].sort().join() === [a, b].sort().join());
    expect(c?.kind).toBe("contradiction");
    expect(c!.detail).toMatch(/does not decide/);
    expect((await outbox(A.org.id, "knowledge.conflict.detected")).some((e) => (e.payload as { conflictId: string }).conflictId === c!.id)).toBe(true);
    expect((await notes(lead.user.id, "knowledge.conflict")).length).toBeGreaterThan(0);
    expect((await svc.getDocument(A.adminCtx(), a)).status).toBe("active");
    const r = await svc.ask(eng.ctx(), { question: "How many days per week may employees work remotely?" });
    expect(r.citations.map((x) => x.documentId)).toEqual(expect.arrayContaining([a, b]));
    expect(r.confidence.level).not.toBe("high");
    expect(r.uncertainty).toMatch(/unresolved conflicts/);
  });

  it("only a person resolves it; keep_b supersedes the other document", async () => {
    const c = (await svc.listConflicts(lead.ctx(), { status: "open" })).find((x) => [x.documentA.id, x.documentB.id].includes(a) && x.kind === "contradiction")!;
    await expectCode(svc.resolveConflict(systemCtx(A.org.id), c.id, { resolution: "keep_a" }), "FORBIDDEN");
    const rv = (await svc.listReviews(lead.ctx(), { kind: "conflict" })).find((x) => x.conflictId === c.id)!;
    await expectCode(svc.updateReview(lead.ctx(), rv.id, { status: "resolved" }), "VALIDATION_FAILED");
    const keep = c.documentA.id === b ? "keep_a" : "keep_b";
    await svc.resolveConflict(lead.ctx(), c.id, { resolution: keep, note: "2026 policy replaces the old one." });
    await expectCode(svc.resolveConflict(lead.ctx(), c.id, { resolution: keep }), "CONFLICT");
    expect((await svc.getDocument(A.adminCtx(), a))).toMatchObject({ status: "superseded", supersededBy: { id: b } });
    const r = await svc.retrieve(eng.ctx(), { question: "work remotely days per week" });
    expect(r.passages.map((x) => x.documentId)).not.toContain(a);
    expect(r.passages.map((x) => x.documentId)).toContain(b);
  });

  it("detects exact duplicates across sources", async () => {
    const t = "Grallowmere badges must be worn visibly inside the office at all times by everyone.";
    const x = await ingest(A.adminCtx(), wiki.id, "Grallowmere badges", t);
    const y = await ingest(A.adminCtx(), policies.id, "Grallowmere badge rule", t);
    const c = (await svc.listConflicts(A.adminCtx())).find((k) => [k.documentA.id, k.documentB.id].sort().join() === [x.document.id, y.document.id].sort().join());
    expect(c?.kind).toBe("duplicate");
  });
});

describe("Human escalation", () => {
  it("routes safety questions to configured experts and tells the asker when answered", async () => {
    await expectCode(svc.updateSettings(A.adminCtx(), { escalationCategories: [{ key: "safety", label: "Safety", keywords: ["hard hat"], escalateWhen: "always", expertUserIds: [B.admin.id] }] }), "VALIDATION_FAILED");
    await svc.updateSettings(A.adminCtx(), { escalationCategories: [{ key: "safety", label: "Safety", keywords: ["hard hat", "injury"], escalateWhen: "always", expertUserIds: [lead.user.id] }] });
    const r = await svc.ask(eng.ctx(), { question: "Do brindlecove visitors need a hard hat?" });
    expect(r.escalation?.categories).toEqual(["Safety"]);
    expect((await notes(lead.user.id, "knowledge.escalation")).length).toBeGreaterThan(0);
    const rv = (await svc.listReviews(lead.ctx(), { kind: "escalation" })).find((x) => x.id === r.escalation!.reviewId)!;
    expect(rv.assigneeUserId).toBe(lead.user.id);
    await expectCode(svc.updateReview(lead.ctx(), rv.id, { status: "resolved" }), "VALIDATION_FAILED");
    await svc.updateReview(lead.ctx(), rv.id, { status: "resolved", resolution: "Yes — everyone on site wears a hard hat." });
    expect((await notes(eng.user.id, "knowledge.escalation")).some((n) => n.title.includes("expert answered"))).toBe(true);
    await svc.updateSettings(A.adminCtx(), { escalationCategories: null });
  });
});

describe("Shared platform API for other modules", () => {
  it("system callers query on behalf of a user and get that user's view only", async () => {
    const sys = systemCtx(A.org.id);
    const forEng = await svc.retrieve(sys, { question: "quillfeather salary band", onBehalfOfUserId: eng.user.id, sourceModule: "agent_governance" });
    expect(JSON.stringify(forEng)).not.toContain("187,000");
    const forHr = await svc.retrieve(sys, { question: "quillfeather salary band", onBehalfOfUserId: hr.user.id });
    expect(JSON.stringify(forHr)).toContain("187,000");
    // Without onBehalfOf, a system caller sees only organization-wide documents.
    expect(JSON.stringify(await svc.retrieve(sys, { question: "quillfeather salary band" }))).not.toContain("187,000");
    // A non-member user id grants nothing.
    expect((await svc.retrieve(sys, { question: "meals reimbursed", onBehalfOfUserId: B.admin.id })).passages).toHaveLength(0);
    // Only system contexts may impersonate.
    await expectCode(svc.retrieve(eng.ctx(), { question: "quillfeather salary band", onBehalfOfUserId: hr.user.id }), "FORBIDDEN");
    const ans = await svc.ask(sys, { question: "How much are meals reimbursed per day when travelling?", onBehalfOfUserId: eng.user.id, sourceModule: "workflow_intelligence" });
    expect(ans.citations.length).toBeGreaterThan(0);
    const travel = (await svc.listDocuments(A.adminCtx(), { q: "Travel policy" }))[0]!;
    expect(await svc.documentMetadata(sys, travel.id)).toMatchObject({ title: "Travel policy", authority: "authoritative", classification: "internal" });
  });
});

describe("Connector sources (shared connector layer)", () => {
  it("syncs documents from the sandbox connector with mapped ACLs (simulated data)", async () => {
    const c = await p.connectors.create(A.adminCtx(), { type: "sandbox", name: uniq("files"), authType: "none", config: {} });
    const s = await svc.createSource(A.adminCtx(), { name: "SharePoint (sandbox)", kind: "connector", connectorId: c.id, authority: "secondary" });
    await expectCode(svc.syncSource(A.adminCtx(), wiki.id), "VALIDATION_FAILED");
    await svc.syncSource(A.adminCtx(), s.id);
    await drain();
    const src = (await svc.listSources(A.adminCtx())).find((x) => x.id === s.id)!;
    expect(src.lastSyncStatus).toBe("succeeded");
    expect(src.documents).toBe(4);
    // "Everyone" → organization-wide; the Legal-group contract maps to nothing here, so it is not retrievable.
    expect((await svc.retrieve(eng.ctx(), { question: "deploy steps staging migration" })).passages.length).toBeGreaterThan(0);
    expect((await svc.retrieve(eng.ctx(), { question: "master services agreement governing law Delaware" })).passages).toHaveLength(0);
  });
});

describe("Tenant isolation and retention", () => {
  it("organization B can never see organization A's knowledge", async () => {
    const travel = (await svc.listDocuments(A.adminCtx(), { q: "Travel policy" }))[0]!;
    prompts.length = 0;
    const r = await svc.ask(B.adminCtx(), { question: "How much are meals reimbursed per day when travelling?" });
    expect(r.citations).toHaveLength(0);
    expect(prompts.join("")).not.toContain("Meals are reimbursed");
    await expectCode(svc.getDocument(B.adminCtx(), travel.id), "NOT_FOUND");
    await expectCode(svc.documentMetadata(systemCtx(B.org.id), travel.id), "NOT_FOUND");
    expect(await svc.listDocuments(B.adminCtx())).toHaveLength(0);
    expect((await svc.listSources(B.adminCtx())).length).toBe(0);
    const aQuery = (await svc.listQueries(A.adminCtx()))[0]!;
    await expectCode(svc.getAnswer(B.adminCtx(), aQuery.id), "NOT_FOUND");
  });

  it("question text is not stored when prompt retention is off", async () => {
    const src = await svc.createSource(B.adminCtx(), { name: "B policies" });
    await ingest(B.adminCtx(), src.id, "B travel", "Taxis are reimbursed up to $30 per trip.");
    await p.organizations.updateRetention(B.adminCtx(), { aiPromptRetention: "none" });
    const r = await svc.ask(B.adminCtx(), { question: "How much are taxis reimbursed per trip?" });
    const [q] = await p.db.withSystem("test", (tx) => tx.select().from(knowledgeQueries).where(eq(knowledgeQueries.id, r.queryId)));
    expect(q!.question).toBeNull();
    expect((await svc.getAnswer(B.adminCtx(), r.queryId)).response).toBeNull();
  });

  it("analytics summarise questions, confidence, gaps and freshness", async () => {
    const a = await svc.analytics(A.adminCtx());
    expect(a.totals.questions30d).toBeGreaterThan(5);
    expect(a.totals.expired).toBeGreaterThan(0);
    expect(a.frequentlyCited.length).toBeGreaterThan(0);
    expect(a.confidence.reduce((n, c) => n + c.value, 0)).toBe(a.totals.questions30d);
    expect(a.unanswered.length).toBeGreaterThan(0);
    await expectCode(svc.analytics(eng.ctx()), "FORBIDDEN");
  });
});
