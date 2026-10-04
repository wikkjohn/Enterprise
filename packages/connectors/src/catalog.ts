import { z } from "zod";
import { type CapabilityDefinition, type ConnectorDefinition, type CredentialField } from "./types";

const url = z.string().url().max(1000);
const apiKeyCreds: CredentialField[] = [{ key: "apiKey", label: "API key / token", secret: true, required: true }];
const basicCreds: CredentialField[] = [
  { key: "username", label: "Username", secret: false, required: true },
  { key: "password", label: "Password", secret: true, required: true },
];
const oauthClientCreds: CredentialField[] = [
  { key: "clientId", label: "Client ID", secret: false, required: true },
  { key: "clientSecret", label: "Client secret", secret: true, required: true },
];
const serviceAccountCreds: CredentialField[] = [{ key: "serviceAccountJson", label: "Service account key (JSON)", secret: true, required: true }];

const cap = (key: string, description: string, operations: CapabilityDefinition["operations"], risk: CapabilityDefinition["risk"], scopes?: string[]): CapabilityDefinition => ({
  key,
  description,
  operations,
  risk,
  scopes,
});

/** Shared vendor definition helper for connectors whose adapters are not implemented yet. */
function contractOnly(d: Omit<ConnectorDefinition, "availability" | "configSchema" | "configFields" | "rateLimit"> & { configFields?: ConnectorDefinition["configFields"]; configSchema?: z.ZodTypeAny; rateLimit?: number }): ConnectorDefinition {
  return {
    ...d,
    availability: "contract_only",
    configSchema: d.configSchema ?? z.object({}).passthrough(),
    configFields: d.configFields ?? [],
    rateLimit: { requestsPerMinute: d.rateLimit ?? 120 },
  };
}

export const REST_API_DEFINITION: ConnectorDefinition = {
  type: "rest_api",
  name: "REST API",
  vendor: "Generic",
  category: "protocol",
  description: "Any HTTPS JSON API. Supports API key, bearer, basic and OAuth2 client-credentials authentication.",
  availability: "available",
  authTypes: ["api_key", "basic", "oauth2", "none"],
  capabilities: [
    {
      key: "http.request",
      description: "Send an HTTP request to a path under the base URL.",
      operations: ["read", "write", "delete"],
      risk: "medium",
      params: {
        method: { type: "string", required: true, description: "GET, POST, PUT, PATCH or DELETE" },
        path: { type: "string", required: true, description: "Path relative to the base URL, e.g. /v1/items" },
        query: { type: "object" },
        body: { type: "object" },
      },
    },
  ],
  configSchema: z.object({
    baseUrl: url,
    healthPath: z.string().startsWith("/").max(500).default("/"),
    apiKeyHeader: z.string().max(100).default("Authorization"),
    apiKeyPrefix: z.string().max(50).default("Bearer "),
    tokenUrl: url.optional(),
    oauthScope: z.string().max(1000).optional(),
  }),
  configFields: [
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.example.com" },
    { key: "healthPath", label: "Health-check path", type: "text", placeholder: "/health" },
    { key: "apiKeyHeader", label: "API key header", type: "text", placeholder: "Authorization" },
    { key: "apiKeyPrefix", label: "API key prefix", type: "text", placeholder: "Bearer " },
    { key: "tokenUrl", label: "OAuth2 token URL (client credentials)", type: "url" },
    { key: "oauthScope", label: "OAuth2 scope", type: "text" },
  ],
  credentialFields: { api_key: apiKeyCreds, basic: basicCreds, oauth2: oauthClientCreds },
  rateLimit: { requestsPerMinute: 120 },
  urlConfigKeys: ["baseUrl", "tokenUrl"],
};

export const GRAPHQL_DEFINITION: ConnectorDefinition = {
  type: "graphql",
  name: "GraphQL API",
  vendor: "Generic",
  category: "protocol",
  description: "Any GraphQL endpoint over HTTPS.",
  availability: "available",
  authTypes: ["api_key", "none"],
  capabilities: [
    { key: "graphql.query", description: "Run a GraphQL query.", operations: ["read"], risk: "low", params: { query: { type: "string", required: true }, variables: { type: "object" } } },
    { key: "graphql.mutation", description: "Run a GraphQL mutation.", operations: ["write"], risk: "medium", params: { query: { type: "string", required: true }, variables: { type: "object" } } },
  ],
  configSchema: z.object({ endpoint: url, apiKeyHeader: z.string().max(100).default("Authorization"), apiKeyPrefix: z.string().max(50).default("Bearer ") }),
  configFields: [
    { key: "endpoint", label: "Endpoint URL", type: "url", required: true },
    { key: "apiKeyHeader", label: "API key header", type: "text" },
    { key: "apiKeyPrefix", label: "API key prefix", type: "text" },
  ],
  credentialFields: { api_key: apiKeyCreds },
  rateLimit: { requestsPerMinute: 120 },
  urlConfigKeys: ["endpoint"],
};

export const WEBHOOK_DEFINITION: ConnectorDefinition = {
  type: "outbound_webhook",
  name: "Outbound Webhook",
  vendor: "Generic",
  category: "protocol",
  description: "POST signed JSON payloads to an HTTPS endpoint.",
  availability: "available",
  authTypes: ["api_key", "none"],
  capabilities: [{ key: "webhook.send", description: "POST a JSON payload.", operations: ["write"], risk: "medium", params: { payload: { type: "object", required: true } } }],
  configSchema: z.object({ url }),
  configFields: [{ key: "url", label: "Endpoint URL", type: "url", required: true }],
  credentialFields: { api_key: [{ key: "apiKey", label: "Signing secret", secret: true, required: true }] },
  rateLimit: { requestsPerMinute: 60 },
  urlConfigKeys: ["url"],
};

export const SANDBOX_DEFINITION: ConnectorDefinition = {
  type: "sandbox",
  name: "Sandbox (simulated)",
  vendor: "Platform",
  category: "custom",
  description: "SIMULATED connector for development and tests. Returns synthetic records. Never connects to a real system.",
  availability: "sandbox",
  authTypes: ["api_key", "none"],
  capabilities: [
    cap("records.list", "List synthetic records.", ["list", "read"], "low"),
    cap("records.write", "Write a synthetic record (in memory).", ["write"], "medium"),
    cap("simulate.failure", "Simulate transient / auth / rate-limit failures.", ["execute"], "low"),
  ],
  configSchema: z.object({ label: z.string().max(100).default("sandbox") }),
  configFields: [{ key: "label", label: "Label", type: "text" }],
  credentialFields: { api_key: apiKeyCreds },
  rateLimit: { requestsPerMinute: 600 },
};

/** Enterprise systems: definitions and configuration contracts. Adapters land with the modules that need them. */
export const ENTERPRISE_DEFINITIONS: ConnectorDefinition[] = [
  contractOnly({
    type: "microsoft_graph",
    name: "Microsoft 365 (Graph)",
    vendor: "Microsoft",
    category: "productivity",
    description: "SharePoint, OneDrive, Teams, Outlook and Entra ID through Microsoft Graph.",
    authTypes: ["oauth2", "service_account"],
    capabilities: [
      cap("files.read", "Read SharePoint / OneDrive files and metadata.", ["read", "list", "search"], "medium", ["Files.Read.All", "Sites.Read.All"]),
      cap("files.permissions.read", "Read sharing permissions.", ["read", "list"], "medium", ["Sites.Read.All"]),
      cap("mail.read", "Read Outlook mail.", ["read", "list"], "high", ["Mail.Read"]),
      cap("mail.send", "Send / draft Outlook mail.", ["write"], "high", ["Mail.Send"]),
      cap("teams.messages.read", "Read Teams channel messages.", ["read", "list"], "high", ["ChannelMessage.Read.All"]),
      cap("directory.read", "Read users and groups.", ["read", "list"], "medium", ["Directory.Read.All"]),
    ],
    configSchema: z.object({ tenantId: z.string().min(1).max(100) }),
    configFields: [{ key: "tenantId", label: "Entra tenant ID", type: "text", required: true }],
    credentialFields: { oauth2: oauthClientCreds, service_account: oauthClientCreds },
    oauth: { authorizationUrl: "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token", defaultScopes: ["offline_access", "https://graph.microsoft.com/.default"], usePkce: true },
    docsUrl: "https://learn.microsoft.com/graph/",
  }),
  contractOnly({
    type: "salesforce",
    name: "Salesforce",
    vendor: "Salesforce",
    category: "crm",
    description: "Accounts, leads, opportunities, cases via the Salesforce REST API.",
    authTypes: ["oauth2"],
    capabilities: [
      cap("records.read", "Query and read sObjects (SOQL).", ["read", "list", "search"], "medium", ["api"]),
      cap("records.write", "Create / update sObjects.", ["write"], "high", ["api"]),
    ],
    configSchema: z.object({ instanceUrl: url }),
    configFields: [{ key: "instanceUrl", label: "Instance URL", type: "url", required: true, placeholder: "https://yourorg.my.salesforce.com" }],
    credentialFields: { oauth2: oauthClientCreds },
    oauth: { authorizationUrl: "https://login.salesforce.com/services/oauth2/authorize", tokenUrl: "https://login.salesforce.com/services/oauth2/token", defaultScopes: ["api", "refresh_token"], usePkce: true },
    urlConfigKeys: ["instanceUrl"],
  }),
  contractOnly({
    type: "servicenow",
    name: "ServiceNow",
    vendor: "ServiceNow",
    category: "itsm",
    description: "Incidents, requests, CMDB and workflow data via the Table API.",
    authTypes: ["oauth2", "basic"],
    capabilities: [cap("table.read", "Read table records.", ["read", "list", "search"], "medium"), cap("table.write", "Create / update records (tickets).", ["write"], "high")],
    configSchema: z.object({ instanceUrl: url }),
    configFields: [{ key: "instanceUrl", label: "Instance URL", type: "url", required: true, placeholder: "https://yourinstance.service-now.com" }],
    credentialFields: { oauth2: oauthClientCreds, basic: basicCreds },
    urlConfigKeys: ["instanceUrl"],
  }),
  contractOnly({
    type: "sap",
    name: "SAP S/4HANA",
    vendor: "SAP",
    category: "erp",
    description: "OData services for materials, orders, inventory and finance.",
    authTypes: ["oauth2", "basic"],
    capabilities: [cap("odata.read", "Read OData entities.", ["read", "list"], "medium"), cap("odata.write", "Create / update OData entities.", ["write"], "high")],
    configSchema: z.object({ baseUrl: url, client: z.string().max(10).optional() }),
    configFields: [{ key: "baseUrl", label: "OData base URL", type: "url", required: true }, { key: "client", label: "SAP client", type: "text" }],
    credentialFields: { oauth2: oauthClientCreds, basic: basicCreds },
    urlConfigKeys: ["baseUrl"],
  }),
  contractOnly({
    type: "workday",
    name: "Workday",
    vendor: "Workday",
    category: "hr",
    description: "Workers, organizations and business processes.",
    authTypes: ["oauth2"],
    capabilities: [cap("workers.read", "Read worker records.", ["read", "list"], "high"), cap("business_process.read", "Read business processes.", ["read", "list"], "medium")],
    configSchema: z.object({ tenantUrl: url }),
    configFields: [{ key: "tenantUrl", label: "Tenant REST URL", type: "url", required: true }],
    credentialFields: { oauth2: oauthClientCreds },
    urlConfigKeys: ["tenantUrl"],
  }),
  contractOnly({
    type: "jira",
    name: "Jira",
    vendor: "Atlassian",
    category: "itsm",
    description: "Issues, projects and workflows.",
    authTypes: ["oauth2", "api_key"],
    capabilities: [cap("issues.read", "Search and read issues.", ["read", "list", "search"], "low"), cap("issues.write", "Create / transition issues.", ["write"], "medium")],
    configSchema: z.object({ siteUrl: url }),
    configFields: [{ key: "siteUrl", label: "Site URL", type: "url", required: true, placeholder: "https://yourcompany.atlassian.net" }],
    credentialFields: { oauth2: oauthClientCreds, api_key: [{ key: "email", label: "Account email", secret: false, required: true }, ...apiKeyCreds] },
    urlConfigKeys: ["siteUrl"],
  }),
  contractOnly({
    type: "confluence",
    name: "Confluence",
    vendor: "Atlassian",
    category: "collaboration",
    description: "Spaces and pages.",
    authTypes: ["oauth2", "api_key"],
    capabilities: [cap("pages.read", "Read spaces and pages.", ["read", "list", "search"], "medium")],
    configSchema: z.object({ siteUrl: url }),
    configFields: [{ key: "siteUrl", label: "Site URL", type: "url", required: true }],
    credentialFields: { oauth2: oauthClientCreds, api_key: apiKeyCreds },
    urlConfigKeys: ["siteUrl"],
  }),
  contractOnly({
    type: "slack",
    name: "Slack",
    vendor: "Salesforce",
    category: "collaboration",
    description: "Channels, messages and users.",
    authTypes: ["oauth2"],
    capabilities: [cap("messages.read", "Read channel history.", ["read", "list"], "high", ["channels:history"]), cap("messages.write", "Post messages.", ["write"], "medium", ["chat:write"])],
    credentialFields: { oauth2: oauthClientCreds },
    oauth: { authorizationUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", defaultScopes: ["channels:read"] },
  }),
  contractOnly({
    type: "google_workspace",
    name: "Google Workspace",
    vendor: "Google",
    category: "productivity",
    description: "Google Drive, Gmail and Directory.",
    authTypes: ["oauth2", "service_account"],
    capabilities: [cap("drive.read", "Read Drive files and permissions.", ["read", "list", "search"], "medium"), cap("gmail.send", "Send Gmail.", ["write"], "high"), cap("directory.read", "Read users and groups.", ["read", "list"], "medium")],
    credentialFields: { oauth2: oauthClientCreds, service_account: serviceAccountCreds },
    oauth: { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", defaultScopes: ["https://www.googleapis.com/auth/drive.readonly"], usePkce: true },
  }),
  contractOnly({
    type: "box",
    name: "Box",
    vendor: "Box",
    category: "storage",
    description: "Files, folders and collaborations.",
    authTypes: ["oauth2"],
    capabilities: [cap("files.read", "Read files and collaborations.", ["read", "list", "search"], "medium")],
    credentialFields: { oauth2: oauthClientCreds },
  }),
  contractOnly({
    type: "dropbox",
    name: "Dropbox",
    vendor: "Dropbox",
    category: "storage",
    description: "Files and sharing.",
    authTypes: ["oauth2"],
    capabilities: [cap("files.read", "Read files and sharing.", ["read", "list", "search"], "medium")],
    credentialFields: { oauth2: oauthClientCreds },
  }),
  contractOnly({
    type: "notion",
    name: "Notion",
    vendor: "Notion",
    category: "collaboration",
    description: "Pages and databases.",
    authTypes: ["oauth2", "api_key"],
    capabilities: [cap("pages.read", "Read pages and databases.", ["read", "list", "search"], "medium")],
    credentialFields: { oauth2: oauthClientCreds, api_key: apiKeyCreds },
  }),
  contractOnly({
    type: "oracle",
    name: "Oracle Fusion / E-Business",
    vendor: "Oracle",
    category: "erp",
    description: "ERP, HCM and SCM REST resources.",
    authTypes: ["oauth2", "basic"],
    capabilities: [cap("resources.read", "Read REST resources.", ["read", "list"], "medium"), cap("resources.write", "Create / update REST resources.", ["write"], "high")],
    configSchema: z.object({ baseUrl: url }),
    configFields: [{ key: "baseUrl", label: "Base URL", type: "url", required: true }],
    credentialFields: { oauth2: oauthClientCreds, basic: basicCreds },
    urlConfigKeys: ["baseUrl"],
  }),
  contractOnly({
    type: "sql_database",
    name: "SQL Database",
    vendor: "Generic",
    category: "database",
    description: "PostgreSQL, SQL Server, MySQL, Oracle DB via a read-only service account.",
    authTypes: ["basic"],
    capabilities: [cap("sql.query", "Run parameterised read-only queries.", ["read"], "high")],
    configSchema: z.object({ engine: z.enum(["postgres", "sqlserver", "mysql", "oracle"]), host: z.string().max(253), port: z.number().int().min(1).max(65535), database: z.string().max(128) }),
    configFields: [
      { key: "engine", label: "Engine", type: "select", required: true, options: ["postgres", "sqlserver", "mysql", "oracle"] },
      { key: "host", label: "Host", type: "text", required: true },
      { key: "port", label: "Port", type: "number", required: true },
      { key: "database", label: "Database", type: "text", required: true },
    ],
    credentialFields: { basic: basicCreds },
  }),
  contractOnly({
    type: "sftp",
    name: "SFTP",
    vendor: "Generic",
    category: "protocol",
    description: "File exchange with legacy systems over SFTP.",
    authTypes: ["basic", "service_account"],
    capabilities: [cap("files.read", "List and download files.", ["read", "list"], "medium"), cap("files.write", "Upload files.", ["write"], "high")],
    configSchema: z.object({ host: z.string().max(253), port: z.number().int().default(22), basePath: z.string().max(500).default("/") }),
    configFields: [
      { key: "host", label: "Host", type: "text", required: true },
      { key: "port", label: "Port", type: "number" },
      { key: "basePath", label: "Base path", type: "text" },
    ],
    credentialFields: { basic: basicCreds, service_account: [{ key: "privateKey", label: "SSH private key", secret: true, required: true }] },
  }),
];

export class ConnectorCatalog {
  private defs = new Map<string, ConnectorDefinition>();
  constructor(defs: ConnectorDefinition[] = []) {
    defs.forEach((d) => this.register(d));
  }
  register(def: ConnectorDefinition) {
    if (this.defs.has(def.type)) throw new Error(`Connector type "${def.type}" already registered`);
    this.defs.set(def.type, def);
  }
  get(type: string) {
    return this.defs.get(type);
  }
  list() {
    return [...this.defs.values()];
  }
}

export function defaultConnectorDefinitions(opts: { includeSandbox: boolean }): ConnectorDefinition[] {
  return [REST_API_DEFINITION, GRAPHQL_DEFINITION, WEBHOOK_DEFINITION, ...(opts.includeSandbox ? [SANDBOX_DEFINITION] : []), ...ENTERPRISE_DEFINITIONS];
}
