import { z } from "zod";
import { and, eq, ilike, or } from "@eaop/db";
import { type ModuleManifest } from "@eaop/module-registry";
import { type ModuleDefinition, type Platform } from "@eaop/platform";
import { textScore } from "@eaop/search";
import { dataAssets, securityIncidents } from "./schema";
import { createDataSecurityService, MODULE_ID, RETENTION_JOB, SCAN_JOB, type DataSecurityService } from "./service";

export * from "./service";
export * from "./detect";
export * from "./redact";
export * from "./dlp";
export * from "./analysis";
export * from "./shadow";
export { INCIDENT_KINDS, REMEDIATION_ACTIONS, type IncidentKind, type RemediationAction } from "./schema";

const id = z.string().uuid();
const ev = <S extends z.ZodTypeAny>(type: string, description: string, schema: S) => ({ type, owner: MODULE_ID, version: 1, description, schema });

export const DATA_SECURITY_EVENTS = [
  ev("security.incident.created", "A data-security incident was opened.", z.object({ incidentId: id, kind: z.string(), severity: z.string(), source: z.string() })),
  ev("data_security.asset.classified", "An asset was classified confidential or restricted (new or changed).", z.object({ assetId: id, classification: z.string(), categories: z.array(z.string()) })),
  ev("data_security.dlp.blocked", "AI-bound content was blocked by DLP.", z.object({ dlpEventId: id, destination: z.string(), categories: z.array(z.string()) })),
  ev("data_security.dlp.redacted", "AI-bound content was redacted before it was sent.", z.object({ dlpEventId: id, destination: z.string(), categories: z.array(z.string()), redactedCount: z.number() })),
  ev("data_security.dlp.approval_required", "AI-bound content is waiting for a reviewer.", z.object({ dlpEventId: id, destination: z.string(), categories: z.array(z.string()) })),
  ev("data_security.shadow_ai.discovered", "A new AI tool was seen in telemetry or DLP traffic.", z.object({ toolId: id, vendor: z.string(), name: z.string(), status: z.string() })),
];

export const manifest: ModuleManifest = {
  id: MODULE_ID,
  name: "AI Data Security",
  shortName: "Data Security",
  description: "Discover, classify and protect enterprise data used with AI: exposure, shadow AI, AI DLP and incidents.",
  version: "1.0.0",
  installStatus: "installed",
  icon: "Lock",
  basePath: "/m/data-security",
  entryPermission: "data_security.read",
  permissions: [
    { key: "data_security.read", description: "View the data inventory, classifications, permission and AI-exposure findings, remediation and the dashboard.", risk: "medium" },
    { key: "data_security.scan", description: "Run discovery scans, push asset inventory and AI telemetry, and call the DLP evaluation API.", risk: "medium" },
    { key: "data_security.classification.manage", description: "Create custom classifications, review classifications and change an asset's classification.", risk: "high" },
    { key: "data_security.policy.manage", description: "Set DLP actions, AI tool status and module settings; approve or reject AI data transfers.", risk: "high" },
    { key: "data_security.incident.read", description: "View security incidents and DLP events.", risk: "medium" },
    { key: "data_security.incident.manage", description: "Open, assign, investigate and resolve security incidents.", risk: "high" },
    { key: "data_security.remediation.manage", description: "Complete or dismiss remediation actions and resolve findings.", risk: "high" },
    { key: "data_security.shadow_ai.read", description: "View the shadow AI inventory and usage.", risk: "low" },
  ],
  roleGrants: {
    security_admin: ["data_security.read", "data_security.scan", "data_security.classification.manage", "data_security.policy.manage", "data_security.incident.read", "data_security.incident.manage", "data_security.remediation.manage", "data_security.shadow_ai.read"],
    ai_admin: ["data_security.read", "data_security.scan", "data_security.incident.read", "data_security.shadow_ai.read"],
    auditor: ["data_security.read", "data_security.incident.read", "data_security.shadow_ai.read"],
    department_leader: ["data_security.read", "data_security.shadow_ai.read"],
  },
  events: DATA_SECURITY_EVENTS,
  notificationTypes: [
    { key: "data_security.incident", description: "A data-security incident was opened or assigned to you.", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "data_security.dlp_approval", description: "An AI data transfer needs approval (or your request was decided).", defaultPriority: "high", channels: ["in_app", "email"] },
    { key: "data_security.shadow_ai_discovered", description: "A new AI tool was seen.", defaultPriority: "normal", channels: ["in_app"] },
  ],
  policyKinds: [
    {
      key: "ai_dlp",
      description: "Organization rules for content sent to AI. Evaluated after per-category DLP actions; can only make the decision stricter (DENY → block, REQUIRE_APPROVAL/ESCALATE → approval). Applies to the platform AI layer and to the DLP evaluation API.",
      attributes: {
        "subject.type": "user | api_key | agent | system",
        "subject.id": "caller id",
        "resource.id": "destination name, e.g. ChatGPT or platform:anthropic",
        "resource.attributes.trust": "approved | experimental | unknown | restricted | blocked",
        "resource.attributes.category": "platform | chat_assistant | coding_assistant | enterprise_copilot | model_api | …",
        "context.categories": "detected categories (array): pii, financial, customer_records, employee, credentials, source_code, contracts, trade_secrets, health, regulated, or custom keys",
        "context.counts": "matches per category, e.g. { pii: 3 }",
        "context.sensitivity": "public | internal | confidential | restricted (highest detected)",
        "context.chars": "content length",
        "context.moduleId": "calling module (AI layer)",
        "context.source": "ai_gateway | api",
      },
      template: {
        combining: "deny-overrides",
        defaultEffect: "ALLOW",
        rules: [
          { id: "no-source-code-to-unapproved", description: "Source code only goes to approved AI.", effect: "DENY", when: { all: [{ field: "context.categories", op: "contains", value: "source_code" }, { field: "resource.attributes.trust", op: "neq", value: "approved" }] } },
          { id: "restricted-needs-approval", description: "Restricted data to any non-platform AI needs approval.", effect: "REQUIRE_APPROVAL", when: { all: [{ field: "context.sensitivity", op: "eq", value: "restricted" }, { field: "resource.attributes.category", op: "neq", value: "platform" }] } },
        ],
      },
    },
  ],
  navigation: [
    { label: "Dashboard", href: "/", permission: "data_security.read" },
    { label: "Data assets", href: "/assets", permission: "data_security.read" },
    { label: "Findings", href: "/findings", permission: "data_security.read" },
    { label: "AI DLP", href: "/dlp", permission: "data_security.incident.read" },
    { label: "Shadow AI", href: "/shadow-ai", permission: "data_security.shadow_ai.read" },
    { label: "Incidents", href: "/incidents", permission: "data_security.incident.read" },
    { label: "Remediation", href: "/remediation", permission: "data_security.read" },
    { label: "Classifications", href: "/classifications", permission: "data_security.read" },
  ],
};

/** Installed module: service + AI-layer DLP hook, scan/retention jobs and search on the SHARED core. */
export const dataSecurity: ModuleDefinition = {
  manifest,
  install(platform: Platform) {
    const service = createDataSecurityService({
      db: platform.db, authorizer: platform.rbac.authorizer, audit: platform.audit, bus: platform.events.bus, notifications: platform.notifications, policies: platform.policies,
      connectors: platform.connectors, secrets: platform.secrets, jobs: platform.jobs, organizations: platform.organizations, usage: platform.usage, modules: platform.modules, logger: platform.logger,
    });
    platform.moduleServices.set(MODULE_ID, service);

    // Every platform AI request passes through DLP before it reaches a provider (no-op where the module is not enabled).
    platform.ai.registerPolicyHook(MODULE_ID, (input) => service.aiHook(input));

    platform.jobs.register({
      type: SCAN_JOB,
      maxAttempts: 1,
      timeoutMs: 30 * 60_000,
      async handle(job) {
        const { scanId } = job.payload as { scanId: string };
        if (job.organizationId && (await platform.modules.isEnabled(job.organizationId, MODULE_ID))) await service.runScan(job.organizationId, scanId);
      },
    });
    platform.jobs.register({ type: RETENTION_JOB, maxAttempts: 3, timeoutMs: 30 * 60_000, handle: () => service.applyRetention() });

    const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    platform.search.register({
      resourceType: "data_asset",
      owner: MODULE_ID,
      label: "Data assets",
      permission: "data_security.read",
      async search(ctx, q, limit) {
        const rows = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
          tx.select().from(dataAssets).where(and(eq(dataAssets.organizationId, ctx.organizationId), or(ilike(dataAssets.name, like(q)), ilike(dataAssets.location, like(q))))).limit(limit),
        );
        return rows.map((a) => ({ resourceType: "data_asset", id: a.id, title: a.name, subtitle: `${a.sourceSystem} · ${a.classification}`, url: `/m/data-security/assets/${a.id}`, score: textScore(q, a.name, a.location) }));
      },
    });
    platform.search.register({
      resourceType: "security_incident",
      owner: MODULE_ID,
      label: "Security incidents",
      permission: "data_security.incident.read",
      async search(ctx, q, limit) {
        const rows = await platform.db.withTenant({ organizationId: ctx.organizationId }, (tx) =>
          tx.select().from(securityIncidents).where(and(eq(securityIncidents.organizationId, ctx.organizationId), ilike(securityIncidents.title, like(q)))).limit(limit),
        );
        return rows.map((i) => ({ resourceType: "security_incident", id: i.id, title: i.title, subtitle: `Incident · ${i.severity} · ${i.status}`, url: `/m/data-security/incidents/${i.id}`, score: textScore(q, i.title, i.description) }));
      },
    });
  },
};

/** Typed accessor for apps — throws if the module is not installed. */
export function dataSecurityService(platform: Pick<Platform, "moduleServices">): DataSecurityService {
  const s = platform.moduleServices.get(MODULE_ID) as DataSecurityService | undefined;
  if (!s) throw new Error("AI Data Security module is not installed");
  return s;
}

export default manifest;
