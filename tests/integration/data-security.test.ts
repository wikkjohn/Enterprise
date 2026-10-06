import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditEvents, eq, eventOutbox, sql } from "../../packages/db/src";
import { dataSecurityService, type DataSecurityService } from "../../modules/data-security/src";
import { dataAssets, dataClassifications, dlpEvents, redactionEvents, shadowAiUsage } from "../../modules/data-security/src/schema";
import { addMember, createOrg, createTestPlatform, expectCode, uniq } from "../helpers/platform";

type P = Awaited<ReturnType<typeof createTestPlatform>>;
type Org = Awaited<ReturnType<typeof createOrg>>;

let p: P;
let svc: DataSecurityService;
let A: Org;
let B: Org;
let reviewer: Awaited<ReturnType<typeof addMember>>;
let analyst: Awaited<ReturnType<typeof addMember>>;
const SSN = "123-45-6789";
const AWS = "AKIAIOSFODNN7EXAMPLE";
const CARD = "4111 1111 1111 1111";

const ask = (content: string) => ({ moduleId: "core", useCase: "test.dlp", messages: [{ role: "user" as const, content }], model: "sandbox-echo" });
const rawRows = async (orgId: string) => JSON.stringify(await p.db.withSystem("test", async (tx) => ({
  dlp: await tx.select().from(dlpEvents).where(eq(dlpEvents.organizationId, orgId)),
  red: await tx.select().from(redactionEvents).where(eq(redactionEvents.organizationId, orgId)),
  cls: await tx.select().from(dataClassifications).where(eq(dataClassifications.organizationId, orgId)),
  assets: await tx.select().from(dataAssets).where(eq(dataAssets.organizationId, orgId)),
  audit: await tx.select().from(auditEvents).where(eq(auditEvents.organizationId, orgId)),
  runs: await tx.execute(sql`select request, response, policy_reasons from ai_runs where organization_id = ${orgId}`),
})));

async function drain() {
  for (let i = 0; i < 20; i++) {
    await p.db.withSystem("test.jobs_due", (tx) => tx.execute(sql`update background_jobs_metadata set run_at = now() where status in ('queued','failed') and type like 'data_security.%'`));
    if ((await p.jobs.runOnce("test", { batch: 50 })) === 0) return;
  }
}

beforeAll(async () => {
  p = await createTestPlatform();
  svc = dataSecurityService(p);
  A = await createOrg(p);
  B = await createOrg(p);
  for (const o of [A, B]) await p.modules.enable(o.adminCtx(), "data_security");
  reviewer = await addMember(p, A.org.id, ["security_admin"]);
  analyst = await addMember(p, A.org.id, ["analyst"]);
  await p.organizations.updateRetention(A.adminCtx(), { aiPromptRetention: "full" });
});
afterAll(() => p.close());

describe("Data Security — registration", () => {
  it("registers permissions, events, the ai_dlp policy kind and jobs; unusable until enabled", async () => {
    for (const k of ["data_security.read", "data_security.scan", "data_security.classification.manage", "data_security.policy.manage", "data_security.incident.read", "data_security.incident.manage", "data_security.remediation.manage", "data_security.shadow_ai.read"]) {
      expect(p.rbac.registry.get(k)?.owner).toBe("data_security");
    }
    expect(p.events.registry.get("security.incident.created")?.owner).toBe("data_security");
    expect(p.policies.kinds().find((k) => k.key === "ai_dlp")?.owner).toBe("data_security");
    expect(p.jobs.registeredTypes()).toEqual(expect.arrayContaining(["data_security.scan", "data_security.retention"]));
    const C = await createOrg(p);
    await expectCode(svc.dashboard(C.adminCtx()), "MODULE_NOT_ENABLED");
    // Not enabled → the AI hook is a no-op: sensitive content flows as before.
    const r = await p.ai.execute(C.adminCtx(), ask(`ssn ${SSN}`));
    expect(r.text).toContain(SSN);
  });
});

describe("AI DLP through the shared AI layer", () => {
  it("benign content is allowed unchanged and logged", async () => {
    const r = await p.ai.execute(A.adminCtx(), ask("Summarise our Q3 roadmap themes."));
    expect(r.text).toContain("Q3 roadmap");
    const ev = await svc.listDlpEvents(A.adminCtx());
    expect(ev[0]).toMatchObject({ decision: "ALLOW", destination: "platform:sandbox", source: "ai_gateway", destinationTrust: "approved" });
  });
  it("SSNs and cards are redacted before reaching the provider; the original never lands in any table", async () => {
    const r = await p.ai.execute(A.adminCtx(), ask(`Customer SSN: ${SSN}, card ${CARD}. Draft a reply.`));
    expect(r.text).toContain("***-**-6789");
    expect(r.text).not.toContain(SSN);
    expect(r.text).not.toContain(CARD);
    const [ev] = await svc.listDlpEvents(A.adminCtx(), { decision: "REDACT" });
    expect(ev).toMatchObject({ decision: "REDACT" });
    expect(ev!.categories).toEqual(expect.arrayContaining(["pii", "financial"]));
    expect(ev!.redactedPreview).toContain("[SSN]");
    const dump = await rawRows(A.org.id);
    expect(dump).not.toContain(SSN);
    expect(dump).not.toContain(CARD);
  });
  it("credentials are blocked (POLICY_DENIED) and open a credential-exposure incident", async () => {
    await expectCode(p.ai.execute(A.adminCtx(), ask(`deploy with ${AWS}`)), "POLICY_DENIED");
    const inc = await svc.listIncidents(A.adminCtx(), { kind: "credential_exposure" });
    expect(inc[0]).toMatchObject({ severity: "high", status: "open" });
    const detail = await svc.getIncident(A.adminCtx(), inc[0]!.id);
    expect(detail.remediation.map((r) => r.action)).toContain("rotate_credential");
    expect(await rawRows(A.org.id)).not.toContain(AWS);
  });
  it("payroll content requires approval; a different person approves; the same content then passes once", async () => {
    const payroll = "employee,department,salary,net pay\nJane,Finance,98000,6120";
    // The requester also holds approval rights — separation of duties must still stop self-approval.
    const requester = await addMember(p, A.org.id, ["analyst", "security_admin"]);
    const actor = requester.ctx();
    await expectCode(p.ai.execute(actor, ask(payroll)), "APPROVAL_REQUIRED");
    const [pending] = await svc.listDlpEvents(A.adminCtx(), { approval: "pending" });
    expect(pending!.categories).toContain("employee");
    await expectCode(svc.decideDlpApproval(analyst.ctx(), pending!.id, { decision: "approve" }), "FORBIDDEN"); // no permission
    await expectCode(svc.decideDlpApproval(requester.ctx(), pending!.id, { decision: "approve" }), "FORBIDDEN"); // own request
    await svc.decideDlpApproval(reviewer.ctx(), pending!.id, { decision: "approve", note: "Finance close" });
    const ok = await p.ai.execute(actor, ask(payroll));
    expect(ok.text).toContain("98000");
    await expectCode(p.ai.execute(actor, ask(payroll)), "APPROVAL_REQUIRED"); // single use
    await expectCode(svc.decideDlpApproval(reviewer.ctx(), pending!.id, { decision: "reject" }), "CONFLICT");
  });
  it("organization ai_dlp policies tighten decisions and violations become incidents", async () => {
    const o = await createOrg(p);
    await p.modules.enable(o.adminCtx(), "data_security");
    await p.policies.create(o.adminCtx(), { key: "dlp.no-contracts", name: "No contracts to AI", kind: "ai_dlp", definition: { defaultEffect: "ALLOW", rules: [{ id: "contracts", effect: "DENY", when: { field: "context.categories", op: "contains", value: "contracts" } }] } });
    await p.policies.activate(o.adminCtx(), "dlp.no-contracts", 1);
    const contract = "This Agreement is entered into by the parties. Governing law: Delaware. Each party shall indemnify the other. In witness whereof.";
    await expectCode(p.ai.execute(o.adminCtx(), ask(contract)), "POLICY_DENIED");
    const [ev] = await svc.listDlpEvents(o.adminCtx());
    expect(ev!.policies.map((x) => x.key)).toContain("dlp.no-contracts");
    expect((await svc.listIncidents(o.adminCtx(), { kind: "policy_violation" })).length).toBe(1);
  });
});

describe("AI DLP evaluation API (external AI destinations)", () => {
  it("unknown destinations are stricter, are added to the shadow AI inventory, and open incidents", async () => {
    const r = await svc.evaluate(A.adminCtx(), { destination: "https://chatgpt.com/c/1", content: `Card ${CARD} for the refund`, userEmail: analyst.user.email });
    expect(r).toMatchObject({ decision: "BLOCK", destination: { name: "ChatGPT", status: "unknown" }, content: null });
    const tools = await svc.listTools(A.adminCtx());
    expect(tools.tools.find((t) => t.name === "ChatGPT")).toMatchObject({ status: "unknown", vendor: "OpenAI" });
    expect((await svc.listIncidents(A.adminCtx(), { kind: "unauthorized_ai" }))[0]).toMatchObject({ status: "open" });
  });
  it("approved destinations get redacted content back; blocked destinations block everything", async () => {
    const t = (await svc.listTools(A.adminCtx())).tools.find((x) => x.name === "ChatGPT")!;
    await svc.setToolStatus(A.adminCtx(), t.id, { status: "approved" });
    const r = await svc.evaluate(A.adminCtx(), { destination: "chatgpt.com", content: `SSN: ${SSN} please summarise` });
    expect(r.decision).toBe("REDACT");
    expect(r.content).toBe("SSN: ***-**-6789 please summarise");
    await svc.setToolStatus(A.adminCtx(), t.id, { status: "blocked" });
    expect((await svc.evaluate(A.adminCtx(), { destination: "chatgpt.com", content: "hello" })).decision).toBe("BLOCK");
  });
  it("custom classifications and tokenization are honoured", async () => {
    await svc.upsertRule(A.adminCtx(), { key: "customer_acct", label: "Customer account", sensitivity: "confidential", patterns: ["ACCT-\\d{6}"], actionApproved: "REDACT", actionUnapproved: "BLOCK", redactionMode: "tokenize" });
    await expectCode(svc.upsertRule(A.adminCtx(), { key: "bad_rule", label: "Bad", patterns: ["(a+)+"] }), "VALIDATION_FAILED");
    const claude = await svc.evaluate(A.adminCtx(), { destination: "claude.ai", content: "x" });
    await svc.setToolStatus(A.adminCtx(), claude.destination.toolId!, { status: "approved" });
    const a = await svc.evaluate(A.adminCtx(), { destination: "claude.ai", content: "Look up ACCT-123456 status" });
    const b = await svc.evaluate(A.adminCtx(), { destination: "claude.ai", content: "And ACCT-123456 again" });
    const tok = a.content!.match(/\[CUSTOMER_ACCOUNT:tok_[\w-]+\]/)![0];
    expect(b.content).toContain(tok);
    expect(a.content).not.toContain("123456");
  });
  it("large exports to non-approved destinations need approval", async () => {
    await svc.updateSettings(A.adminCtx(), { largeExportChars: 2000 });
    const r = await svc.evaluate(A.adminCtx(), { destination: "perplexity.ai", content: "lorem ipsum ".repeat(300) });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
    expect((await svc.listIncidents(A.adminCtx(), { kind: "large_ai_export" })).length).toBe(1);
    await svc.updateSettings(A.adminCtx(), { largeExportChars: 100000 });
  });
  it("repeated blocks from one actor raise an abnormal-activity incident", async () => {
    const o = await createOrg(p);
    await p.modules.enable(o.adminCtx(), "data_security");
    await svc.updateSettings(o.adminCtx(), { abnormalBlockedPerHour: 3 });
    for (let i = 0; i < 3; i++) await svc.evaluate(o.adminCtx(), { destination: "deepseek.com", content: `key ${AWS}` });
    expect((await svc.listIncidents(o.adminCtx(), { kind: "abnormal_ai_activity" })).length).toBe(1);
    // Incidents are deduplicated: three credential events → one incident with three events.
    const [cred] = await svc.listIncidents(o.adminCtx(), { kind: "credential_exposure" });
    expect(cred!.eventCount).toBe(3);
  });
  it("needs data_security.scan", async () => {
    await expectCode(svc.evaluate(analyst.ctx(), { destination: "x.com", content: "x" }), "FORBIDDEN");
    const plain = await addMember(p, A.org.id, ["standard_user"]);
    await expectCode(svc.evaluate(plain.ctx(), { destination: "x.com", content: "x" }), "FORBIDDEN");
  });
});

describe("Discovery, classification and permission analysis", () => {
  it("scans the sandbox connector through the shared connector layer (simulated data)", async () => {
    const c = await p.connectors.create(A.adminCtx(), { type: "sandbox", name: uniq("files"), authType: "none", config: {} });
    const scan = await svc.startScan(A.adminCtx(), { connectorId: c.id });
    await drain();
    const s = (await svc.listScans(A.adminCtx())).find((x) => x.id === scan.id)!;
    expect(s).toMatchObject({ status: "succeeded", assetsSeen: 4, assetsClassified: 4 });
    const assets = await svc.listAssets(A.adminCtx(), { source: "sandbox" });
    const payroll = assets.find((a) => a.name === "Payroll Q3.csv")!;
    expect(payroll).toMatchObject({ classification: "restricted", sharingScope: "organization" });
    expect(payroll.categories).toEqual(expect.arrayContaining(["employee", "pii", "financial"]));
    const deploy = assets.find((a) => a.name === "deploy-notes.md")!;
    expect(deploy).toMatchObject({ classification: "restricted", aiExposureStatus: "potential", worstFinding: "critical" });
    expect(assets.find((a) => a.name === "Product roadmap.pptx")).toMatchObject({ classification: "internal", openFindings: 0 });
    const detail = await svc.getAsset(A.adminCtx(), payroll.id);
    expect(detail.accessFindings.map((f) => f.kind)).toEqual(expect.arrayContaining(["organization_wide", "overly_broad_group", "departed_user", "sensitive_broad_access"]));
    expect(detail.classifications.find((c2) => c2.category === "employee")).toMatchObject({ confidence: "high", method: "heuristic" });
    expect(detail.remediation.every((r) => r.execution === "manual" || r.action === "assign_owner")).toBe(true);
    // Rescan is idempotent: no duplicate assets or findings.
    await svc.startScan(A.adminCtx(), { connectorId: c.id });
    await drain();
    expect((await svc.listAssets(A.adminCtx(), { source: "sandbox" })).length).toBe(4);
    expect((await svc.getAsset(A.adminCtx(), payroll.id)).accessFindings.length).toBe(detail.accessFindings.length);
    expect(await rawRows(A.org.id)).not.toContain("234-56-7890");
  });
  it("contract-only connectors fail clearly and point to the ingestion API", async () => {
    const o = await createOrg(p);
    await p.modules.enable(o.adminCtx(), "data_security");
    const c = await p.connectors.create(o.adminCtx(), { type: "box", name: uniq("box"), authType: "oauth2", config: {} });
    await svc.startScan(o.adminCtx(), { connectorId: c.id });
    await drain();
    const [s] = await svc.listScans(o.adminCtx());
    expect(s).toMatchObject({ status: "failed" });
    expect(s!.errorMessage).toMatch(/ingest/);
  });
  it("ingests asset inventory, closes findings that disappear, and reviews classifications", async () => {
    const base = { externalId: "doc-1", name: "Customer list.xlsx", owner: A.admin.email, permissions: { scope: "public" as const, publicLink: true }, content: `customer id: C-88812 SSN: ${SSN}` };
    const r = await svc.ingestAssets(A.adminCtx(), { sourceSystem: "google_workspace", assets: [base] });
    const id = r.assets[0]!.assetId;
    let d = await svc.getAsset(A.adminCtx(), id);
    expect(d.ownerUserId).toBe(A.admin.id);
    expect(d.accessFindings.filter((f) => f.status === "open").map((f) => f.kind)).toContain("public_link");
    // Sharing fixed at the source → the finding resolves on the next ingest.
    await svc.ingestAssets(A.adminCtx(), { sourceSystem: "google_workspace", assets: [{ ...base, permissions: { scope: "private" as const } }] });
    d = await svc.getAsset(A.adminCtx(), id);
    expect(d.accessFindings.find((f) => f.kind === "public_link")?.status).toBe("resolved");
    expect(d.versions.length).toBeGreaterThanOrEqual(2);
    // Reject the PII classification → asset sensitivity recomputed without it.
    const pii = d.classifications.find((c) => c.category === "pii")!;
    await svc.reviewClassification(A.adminCtx(), pii.id, { status: "rejected" });
    d = await svc.getAsset(A.adminCtx(), id);
    expect(d.categories).not.toContain("pii");
    await svc.setAssetClassification(A.adminCtx(), id, { classification: "restricted", note: "Contains customer list" });
    expect((await svc.getAsset(A.adminCtx(), id)).classificationLocked).toBe(true);
    await expectCode(svc.setAssetClassification(analyst.ctx(), id, { classification: "public" }), "FORBIDDEN");
  });
  it("observed AI exposure is recorded when DLP content references an asset", async () => {
    const [asset] = await svc.listAssets(A.adminCtx(), { q: "Customer list" });
    await svc.evaluate(A.adminCtx(), { destination: "gemini.google.com", content: "summarise this sheet", assetIds: [asset!.id] });
    const d = await svc.getAsset(A.adminCtx(), asset!.id);
    expect(d.aiExposureStatus).toBe("observed");
    expect(d.exposureFindings.find((f) => f.basis === "observed")).toMatchObject({ type: "employee_ai_tool", destination: "Gemini" });
  });
});

describe("Shadow AI telemetry", () => {
  it("records only AI destinations, hashes non-member identities, and aggregates users and departments", async () => {
    const r = await svc.ingestTelemetry(A.adminCtx(), {
      source: "proxy-logs",
      events: [
        { domain: "chatgpt.com", userEmail: A.admin.email, department: "Sales", occurredAt: new Date().toISOString(), count: 4, externalRef: "e1" },
        { url: "https://www.perplexity.ai/search?q=x", userEmail: "contractor@outside.example", department: "Marketing", occurredAt: new Date().toISOString(), externalRef: "e2", dataCategories: ["customer_records"] },
        { domain: "news.example.com", userEmail: "x@example.com", occurredAt: new Date().toISOString(), externalRef: "e3" },
        { domain: "chatgpt.com", userEmail: A.admin.email, occurredAt: new Date().toISOString(), externalRef: "e1" },
      ],
    });
    expect(r).toMatchObject({ recorded: 2, skipped: 2 });
    const usage = await p.db.withSystem("test", (tx) => tx.select().from(shadowAiUsage).where(eq(shadowAiUsage.organizationId, A.org.id)));
    expect(JSON.stringify(usage)).not.toContain("contractor@outside.example");
    const tools = await svc.listTools(A.adminCtx());
    expect(tools.telemetry).toMatchObject({ connected: true, sources: ["proxy-logs"] });
    const perplexity = tools.tools.find((t) => t.name === "Perplexity")!;
    expect(perplexity).toMatchObject({ userCount: 1, departments: ["Marketing"], dataCategories: ["customer_records"] });
    expect((await svc.listIncidents(A.adminCtx(), { kind: "unauthorized_ai" })).some((i) => i.title.includes("Perplexity"))).toBe(true);
  });
  it("is visible only with data_security.shadow_ai.read", async () => {
    await expectCode(svc.listTools(analyst.ctx()), "FORBIDDEN");
    const auditor = await addMember(p, A.org.id, ["auditor"]);
    expect((await svc.listTools(auditor.ctx())).tools.length).toBeGreaterThan(0);
  });
});

describe("Incidents and remediation", () => {
  it("incident lifecycle with timeline, owner and required resolution", async () => {
    const { id } = await svc.createIncident(A.adminCtx(), { severity: "medium", title: "Manual review of HR share", description: "Reported by HR" });
    await svc.updateIncident(A.adminCtx(), id, { status: "investigating", ownerUserId: reviewer.user.id, note: "Looking" });
    await expectCode(svc.updateIncident(A.adminCtx(), id, { status: "resolved" }), "VALIDATION_FAILED");
    await svc.updateIncident(A.adminCtx(), id, { status: "resolved", rootCause: "Mis-shared folder", resolution: "Sharing removed" });
    const d = await svc.getIncident(A.adminCtx(), id);
    expect(d).toMatchObject({ status: "resolved", ownerUserId: reviewer.user.id, rootCause: "Mis-shared folder" });
    expect(d.timeline.map((t) => t.kind)).toEqual(expect.arrayContaining(["created", "status_change", "assignment", "note"]));
    await expectCode(svc.updateIncident(analyst.ctx(), id, { note: "x" }), "FORBIDDEN");
  });
  it("platform-internal remediations apply; source-system ones need an attestation and are never automated", async () => {
    const list = await svc.listRemediation(A.adminCtx(), { status: "recommended" });
    const manual = list.find((r) => r.action === "remove_broad_sharing")!;
    await expectCode(svc.completeRemediation(A.adminCtx(), manual.id, {}), "VALIDATION_FAILED");
    const done = await svc.completeRemediation(A.adminCtx(), manual.id, { note: "Removed the org-wide link in SharePoint" });
    expect(done).toMatchObject({ status: "completed", execution: "manual" });
    expect(done.result).toMatch(/Attested/);
    const block = list.find((r) => r.action === "block_ai_destination")!;
    await svc.completeRemediation(A.adminCtx(), block.id, {});
    const tool = (await svc.listTools(A.adminCtx())).tools.find((t) => t.id === block.toolId)!;
    expect(tool.status).toBe("blocked");
    const owner = list.find((r) => r.action === "assign_owner");
    if (owner) {
      await svc.completeRemediation(A.adminCtx(), owner.id, { ownerUserId: reviewer.user.id });
      expect((await svc.getAsset(A.adminCtx(), owner.assetId!)).ownerUserId).toBe(reviewer.user.id);
    }
    const dash = await svc.dashboard(A.adminCtx());
    expect(dash.remediation.completed).toBeGreaterThanOrEqual(2);
    expect(dash.sensitiveAssets).toBeGreaterThan(0);
    expect(dash.blockedTransmissions30d).toBeGreaterThan(0);
    expect(dash.redactedTransmissions30d).toBeGreaterThan(0);
    expect(dash.telemetryConnected).toBe(true);
  });
});

describe("Tenant boundaries", () => {
  it("organization B sees nothing of A and cannot act on A's records", async () => {
    const [asset] = await svc.listAssets(A.adminCtx());
    const [inc] = await svc.listIncidents(A.adminCtx());
    const [ev] = await svc.listDlpEvents(A.adminCtx());
    const tool = (await svc.listTools(A.adminCtx())).tools[0]!;
    const [rem] = await svc.listRemediation(A.adminCtx());
    await expectCode(svc.getAsset(B.adminCtx(), asset!.id), "NOT_FOUND");
    await expectCode(svc.getIncident(B.adminCtx(), inc!.id), "NOT_FOUND");
    await expectCode(svc.updateIncident(B.adminCtx(), inc!.id, { note: "x" }), "NOT_FOUND");
    await expectCode(svc.decideDlpApproval(B.adminCtx(), ev!.id, { decision: "approve" }), "NOT_FOUND");
    await expectCode(svc.setToolStatus(B.adminCtx(), tool.id, { status: "approved" }), "NOT_FOUND");
    await expectCode(svc.completeRemediation(B.adminCtx(), rem!.id, { note: "hack attempt" }), "NOT_FOUND");
    await expectCode(svc.setAssetClassification(B.adminCtx(), asset!.id, { classification: "public" }), "NOT_FOUND");
    expect((await svc.listAssets(B.adminCtx())).length).toBe(0);
    expect((await svc.dashboard(B.adminCtx())).totalAssets).toBe(0);
    // A's tool status never affects B: chatgpt is blocked in A, unknown in B.
    const r = await svc.evaluate(B.adminCtx(), { destination: "chatgpt.com", content: "hello" });
    expect(r).toMatchObject({ decision: "ALLOW", destination: { status: "unknown" } });
    // DLP references to another org's assets are ignored.
    const x = await svc.evaluate(B.adminCtx(), { destination: "chatgpt.com", content: "hi", assetIds: [asset!.id] });
    const [bev] = await svc.listDlpEvents(B.adminCtx());
    expect(bev!.id).toBe(x.eventId);
    expect(bev!.assetIds).toEqual([]);
    // Each org has its own tokenization key: the same value tokenizes differently.
    await svc.upsertRule(B.adminCtx(), { key: "customer_acct", label: "Customer account", patterns: ["ACCT-\\d{6}"], actionApproved: "REDACT", actionUnapproved: "REDACT", redactionMode: "tokenize" });
    const tb = await svc.evaluate(B.adminCtx(), { destination: "claude.ai", content: "ACCT-123456" });
    const ta = await svc.testDetection(A.adminCtx(), { content: "ACCT-123456", mode: "tokenize" });
    expect(tb.content).toMatch(/tok_/);
    expect(ta.redacted).not.toBe(tb.content);
  });
  it("cannot scan another organization's connector", async () => {
    const c = await p.connectors.create(A.adminCtx(), { type: "sandbox", name: uniq("a-only"), authType: "none", config: {} });
    await expectCode(svc.startScan(B.adminCtx(), { connectorId: c.id }), "NOT_FOUND");
  });
});

describe("Audit and events", () => {
  it("records security-relevant actions in the shared audit log and emits events", async () => {
    const actions = new Set((await p.db.withSystem("test", (tx) => tx.select({ a: auditEvents.action }).from(auditEvents).where(and(eq(auditEvents.organizationId, A.org.id))))).map((r) => r.a));
    for (const a of ["data_security.dlp_redact", "data_security.dlp_block", "data_security.dlp_require_approval", "data_security.dlp_approval_granted", "data_security.incident_created", "data_security.scan_completed", "data_security.assets_ingested", "data_security.classification_rejected", "data_security.classification_changed", "data_security.ai_tool_status_changed", "data_security.remediation_completed", "data_security.telemetry_ingested", "data_security.incident_updated"]) {
      expect(actions, a).toContain(a);
    }
    const types = (await p.db.withSystem("test", (tx) => tx.select({ t: eventOutbox.type }).from(eventOutbox).where(eq(eventOutbox.organizationId, A.org.id)))).map((r) => r.t);
    expect(types).toEqual(expect.arrayContaining(["security.incident.created", "data_security.dlp.blocked", "data_security.dlp.redacted", "data_security.dlp.approval_required", "data_security.shadow_ai.discovered", "data_security.asset.classified"]));
  });
});
