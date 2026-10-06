import { type ActionOperation, type Risk } from "./schema";
import { type JsonSchema } from "./validation";

/**
 * Action templates: business-level actions built on SHARED connector
 * capabilities. Installing a template binds it to one of the organization's
 * configured connectors (same type) and creates an integration_actions row.
 * Templates never carry credentials — the connector does.
 *
 * Whether a template can run live depends on the connector adapter: for
 * contract-only connectors (adapter not shipped yet) live runs fail with
 * NOT_IMPLEMENTED, and test-mode runs validate and dry-run instead.
 */
export interface ActionTemplate {
  key: string;
  connectorType: string;
  name: string;
  description: string;
  capability: string;
  operation: ActionOperation;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  requestTemplate: Record<string, unknown>;
  risk: Risk;
  requiresApproval: boolean;
  idempotency: "none" | "auto" | "key_required";
  /** Field shown to approvers as "affected data". */
  affectedDataFields?: string[];
}

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "string", description, maxLength: 1000, ...extra });
const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

export const ACTION_TEMPLATES: ActionTemplate[] = [
  // ── Salesforce ────────────────────────────────────────────────────────────
  {
    key: "salesforce.get_account",
    connectorType: "salesforce",
    name: "Get Account",
    description: "Read a Salesforce Account by id.",
    capability: "records.read",
    operation: "read",
    inputSchema: obj({ accountId: str("Salesforce Account id (15 or 18 chars).", { pattern: "^[A-Za-z0-9]{15,18}$" }) }, ["accountId"]),
    requestTemplate: { sobject: "Account", id: "{{input.accountId}}" },
    risk: "low",
    requiresApproval: false,
    idempotency: "none",
  },
  {
    key: "salesforce.create_lead",
    connectorType: "salesforce",
    name: "Create Lead",
    description: "Create a Lead in Salesforce.",
    capability: "records.write",
    operation: "write",
    inputSchema: obj(
      { lastName: str("Last name", { minLength: 1, maxLength: 80 }), company: str("Company", { minLength: 1, maxLength: 255 }), email: str("Email", { format: "email" }), phone: str("Phone", { maxLength: 40 }) },
      ["lastName", "company"],
    ),
    requestTemplate: { sobject: "Lead", operation: "create", fields: { LastName: "{{input.lastName}}", Company: "{{input.company}}", Email: "{{input.email}}", Phone: "{{input.phone}}" } },
    risk: "medium",
    requiresApproval: false,
    idempotency: "auto",
    affectedDataFields: ["company", "email"],
  },
  {
    key: "salesforce.update_opportunity",
    connectorType: "salesforce",
    name: "Update Opportunity",
    description: "Change an Opportunity's stage, amount or close date.",
    capability: "records.write",
    operation: "write",
    inputSchema: obj(
      {
        opportunityId: str("Opportunity id", { pattern: "^[A-Za-z0-9]{15,18}$" }),
        stage: str("Stage name", { maxLength: 80 }),
        amount: { type: "number", minimum: 0, description: "Amount" },
        closeDate: str("Close date (YYYY-MM-DD)", { format: "date" }),
      },
      ["opportunityId"],
    ),
    requestTemplate: { sobject: "Opportunity", operation: "update", id: "{{input.opportunityId}}", fields: { StageName: "{{input.stage}}", Amount: "{{input.amount}}", CloseDate: "{{input.closeDate}}" } },
    risk: "high",
    requiresApproval: true,
    idempotency: "auto",
    affectedDataFields: ["opportunityId", "amount", "stage"],
  },
  // ── ServiceNow ────────────────────────────────────────────────────────────
  {
    key: "servicenow.create_ticket",
    connectorType: "servicenow",
    name: "Create Ticket",
    description: "Open an incident in ServiceNow.",
    capability: "table.write",
    operation: "write",
    inputSchema: obj(
      { shortDescription: str("Short description", { minLength: 3, maxLength: 160 }), description: str("Details", { maxLength: 4000 }), urgency: { type: "string", enum: ["1", "2", "3"], default: "3" }, callerEmail: str("Caller email", { format: "email" }) },
      ["shortDescription"],
    ),
    requestTemplate: { table: "incident", operation: "create", record: { short_description: "{{input.shortDescription}}", description: "{{input.description}}", urgency: "{{input.urgency}}", caller_id: "{{input.callerEmail}}" } },
    risk: "medium",
    requiresApproval: false,
    idempotency: "auto",
  },
  {
    key: "servicenow.update_ticket",
    connectorType: "servicenow",
    name: "Update Ticket",
    description: "Update the state or work notes of an incident.",
    capability: "table.write",
    operation: "write",
    inputSchema: obj({ sysId: str("Incident sys_id", { pattern: "^[0-9a-f]{32}$" }), state: { type: "string", enum: ["1", "2", "3", "6", "7"] }, workNotes: str("Work notes", { maxLength: 4000 }) }, ["sysId"]),
    requestTemplate: { table: "incident", operation: "update", sysId: "{{input.sysId}}", record: { state: "{{input.state}}", work_notes: "{{input.workNotes}}" } },
    risk: "medium",
    requiresApproval: false,
    idempotency: "auto",
  },
  // ── Microsoft 365 ─────────────────────────────────────────────────────────
  {
    key: "microsoft.read_file",
    connectorType: "microsoft_graph",
    name: "Read File",
    description: "Read a SharePoint / OneDrive file's content and metadata.",
    capability: "files.read",
    operation: "read",
    inputSchema: obj({ driveId: str("Drive id"), itemId: str("Item id") }, ["driveId", "itemId"]),
    requestTemplate: { driveId: "{{input.driveId}}", itemId: "{{input.itemId}}", includeContent: true },
    risk: "medium",
    requiresApproval: false,
    idempotency: "none",
  },
  {
    key: "microsoft.create_draft",
    connectorType: "microsoft_graph",
    name: "Create Draft",
    description: "Create an Outlook draft for a person to review and send.",
    capability: "mail.send",
    operation: "write",
    inputSchema: obj({ to: { type: "array", items: str("Recipient", { format: "email" }), minItems: 1, maxItems: 50 }, subject: str("Subject", { maxLength: 255 }), body: str("Body (text)", { maxLength: 50000 }) }, ["to", "subject", "body"]),
    requestTemplate: { action: "createDraft", message: { to: "{{input.to}}", subject: "{{input.subject}}", body: "{{input.body}}" } },
    risk: "medium",
    requiresApproval: false,
    idempotency: "auto",
  },
  {
    key: "microsoft.send_email",
    connectorType: "microsoft_graph",
    name: "Send Email",
    description: "Send an Outlook email on behalf of the connector's mailbox.",
    capability: "mail.send",
    operation: "write",
    inputSchema: obj({ to: { type: "array", items: str("Recipient", { format: "email" }), minItems: 1, maxItems: 50 }, subject: str("Subject", { maxLength: 255 }), body: str("Body (text)", { maxLength: 50000 }) }, ["to", "subject", "body"]),
    requestTemplate: { action: "send", message: { to: "{{input.to}}", subject: "{{input.subject}}", body: "{{input.body}}" } },
    risk: "high",
    requiresApproval: true,
    idempotency: "auto",
    affectedDataFields: ["to", "subject"],
  },
  // ── SAP ───────────────────────────────────────────────────────────────────
  {
    key: "sap.check_inventory",
    connectorType: "sap",
    name: "Check Inventory",
    description: "Read stock for a material at a plant.",
    capability: "odata.read",
    operation: "read",
    inputSchema: obj({ materialId: str("Material number", { maxLength: 40 }), plant: str("Plant", { maxLength: 4 }) }, ["materialId", "plant"]),
    requestTemplate: { entitySet: "A_MatlStkInAcctMod", filter: "Material eq '{{input.materialId}}' and Plant eq '{{input.plant}}'" },
    risk: "low",
    requiresApproval: false,
    idempotency: "none",
  },
  // ── Jira / Slack ──────────────────────────────────────────────────────────
  {
    key: "jira.create_issue",
    connectorType: "jira",
    name: "Create Issue",
    description: "Create a Jira issue.",
    capability: "issues.write",
    operation: "write",
    inputSchema: obj({ projectKey: str("Project key", { pattern: "^[A-Z][A-Z0-9]{1,9}$" }), summary: str("Summary", { minLength: 3, maxLength: 255 }), description: str("Description", { maxLength: 30000 }), issueType: { type: "string", enum: ["Task", "Bug", "Story"], default: "Task" } }, ["projectKey", "summary"]),
    requestTemplate: { operation: "create", fields: { project: { key: "{{input.projectKey}}" }, summary: "{{input.summary}}", description: "{{input.description}}", issuetype: { name: "{{input.issueType}}" } } },
    risk: "low",
    requiresApproval: false,
    idempotency: "auto",
  },
  {
    key: "slack.post_message",
    connectorType: "slack",
    name: "Post Message",
    description: "Post a message to a Slack channel.",
    capability: "messages.write",
    operation: "write",
    inputSchema: obj({ channel: str("Channel id", { pattern: "^[CGD][A-Z0-9]{6,}$" }), text: str("Message", { minLength: 1, maxLength: 4000 }) }, ["channel", "text"]),
    requestTemplate: { channel: "{{input.channel}}", text: "{{input.text}}" },
    risk: "medium",
    requiresApproval: false,
    idempotency: "auto",
  },
  // ── Sandbox (SIMULATED) ───────────────────────────────────────────────────
  {
    key: "sandbox.list_records",
    connectorType: "sandbox",
    name: "List records (simulated)",
    description: "Return synthetic records from the sandbox connector.",
    capability: "records.list",
    operation: "list",
    inputSchema: obj({ query: str("Optional filter text", { maxLength: 200 }) }, []),
    requestTemplate: { query: "{{input.query}}" },
    risk: "low",
    requiresApproval: false,
    idempotency: "none",
  },
  {
    key: "sandbox.create_record",
    connectorType: "sandbox",
    name: "Create record (simulated)",
    description: "Write a synthetic record to the sandbox connector.",
    capability: "records.write",
    operation: "write",
    inputSchema: obj({ name: str("Record name", { minLength: 1, maxLength: 200 }), amount: { type: "number", minimum: 0 }, note: str("Note", { maxLength: 2000 }) }, ["name"]),
    requestTemplate: { record: { name: "{{input.name}}", amount: "{{input.amount}}", note: "{{input.note}}" } },
    risk: "medium",
    requiresApproval: false,
    idempotency: "auto",
    affectedDataFields: ["name", "amount"],
  },
  {
    key: "sandbox.simulate_failure",
    connectorType: "sandbox",
    name: "Simulate failure (simulated)",
    description: "Raise a transient, rate-limit, auth or permanent failure — for testing reliability settings.",
    capability: "simulate.failure",
    operation: "execute",
    inputSchema: obj({ kind: { type: "string", enum: ["transient", "rate_limited", "auth", "permanent"], default: "transient" } }, []),
    requestTemplate: { kind: "{{input.kind}}" },
    risk: "low",
    requiresApproval: false,
    idempotency: "none",
  },
];

export const templateByKey = (key: string) => ACTION_TEMPLATES.find((t) => t.key === key);
