import { ConnectorError, type ConnectorAdapter } from "../types";

/**
 * SIMULATED adapter for development and automated tests. It never contacts
 * an external system, and everything it returns is synthetic and labelled
 * `simulated: true`. It is excluded from the catalog in production.
 */
const store = new Map<string, Array<Record<string, unknown>>>();

/**
 * Synthetic file inventory for data-discovery demos and tests. Every value is
 * fake: the SSN, card and keys are well-known test values that pass format
 * checks (e.g. Luhn-valid test card numbers), never real data.
 */
const day = 86400_000;
const SIMULATED_FILES = () => [
  {
    id: "sim-file-payroll", name: "Payroll Q3.csv", type: "spreadsheet", location: "/sites/HR/Shared Documents/Payroll", department: "HR", owner: "hr.lead@example.com",
    lastModifiedAt: new Date(Date.now() - 5 * day).toISOString(), lastAccessedAt: new Date(Date.now() - day).toISOString(), retentionCategory: "hr-7y",
    permissions: { scope: "organization", principals: [{ type: "group", name: "Everyone", memberCount: 2400, inherited: true }, { type: "user", email: "former.analyst@example.com", status: "departed" }] },
    content: "employee,department,salary,ssn,bank routing,net pay\nJane Doe,Finance,98000,123-45-6789,routing 011000015,6120.33\nJohn Roe,Sales,87000,234-56-7890,routing 011000015,5480.10",
  },
  {
    id: "sim-file-deploy", name: "deploy-notes.md", type: "document", location: "/drive/engineering", department: "Engineering", owner: "dev.lead@example.com",
    lastModifiedAt: new Date(Date.now() - 2 * day).toISOString(), lastAccessedAt: new Date(Date.now() - 2 * day).toISOString(), retentionCategory: "standard",
    permissions: { scope: "public", publicLink: true, principals: [{ type: "link", name: "Anyone with the link" }] },
    content: "Deploy steps for staging.\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nThen run the migration.",
  },
  {
    id: "sim-file-msa", name: "Acme MSA 2026.pdf", type: "document", location: "/sites/Legal/Contracts", department: "Legal", owner: null,
    lastModifiedAt: new Date(Date.now() - 40 * day).toISOString(), lastAccessedAt: new Date(Date.now() - 200 * day).toISOString(), retentionCategory: "legal-10y",
    permissions: { scope: "group", principals: [{ type: "group", name: "Legal", memberCount: 12 }, { type: "user", email: "contractor@example.com", lastActiveAt: new Date(Date.now() - 180 * day).toISOString() }] },
    content: "MASTER SERVICES AGREEMENT. This Agreement is entered into as of the Effective Date (hereinafter the Agreement) by the parties. Governing law: Delaware. Limitation of liability applies. Customer will indemnify Provider. Payment card on file 4111 1111 1111 1111.",
  },
  {
    id: "sim-file-roadmap", name: "Product roadmap.pptx", type: "presentation", location: "/sites/Product", department: "Product", owner: "pm@example.com",
    lastModifiedAt: new Date(Date.now() - 10 * day).toISOString(), lastAccessedAt: new Date(Date.now() - 3 * day).toISOString(), retentionCategory: "standard",
    permissions: { scope: "specific", principals: [{ type: "user", email: "pm@example.com", role: "owner" }] },
    content: "Roadmap themes for next year: onboarding, reporting, mobile. Milestones and owners listed per quarter.",
  },
];

export const sandboxAdapter: ConnectorAdapter = {
  type: "sandbox",
  async testConnection(ctx) {
    if (ctx.authType === "api_key" && ctx.credentials?.apiKey === "invalid") return { ok: false, message: "Simulated authentication failure." };
    return { ok: true, message: "Sandbox connector (simulated) is healthy.", latencyMs: 1 };
  },
  async execute(ctx, req) {
    const key = `${ctx.organizationId}:${ctx.connectorId}`;
    const records = store.get(key) ?? [];
    switch (req.capability) {
      case "records.list":
        return { simulated: true, records: [{ id: "sim-1", name: "Simulated record A" }, { id: "sim-2", name: "Simulated record B" }, ...records] };
      case "files.list":
        return { simulated: true, files: SIMULATED_FILES() };
      case "records.write": {
        const rec = { id: `sim-${records.length + 3}`, ...(req.params.record as object) };
        store.set(key, [...records, rec]);
        return { simulated: true, record: rec };
      }
      case "simulate.failure": {
        const kind = String(req.params.kind ?? "transient");
        if (kind === "auth") throw new ConnectorError("auth", "Simulated auth failure.", undefined, 401);
        if (kind === "rate_limited") throw new ConnectorError("rate_limited", "Simulated rate limit.", 0, 429);
        if (kind === "permanent") throw new ConnectorError("permanent", "Simulated permanent failure.", undefined, 400);
        throw new ConnectorError("transient", "Simulated transient failure.", undefined, 503);
      }
      default:
        throw new ConnectorError("permanent", `Unsupported capability ${req.capability}`);
    }
  },
};
