/** System role keys. Shared by every tenant; their permission sets are code-defined. */
export const SYSTEM_ROLE_KEYS = [
  "platform_admin",
  "org_admin",
  "security_admin",
  "ai_admin",
  "auditor",
  "executive",
  "department_leader",
  "analyst",
  "standard_user",
  "read_only",
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** Permission patterns ("*", "ns.*", exact, "!exclusion"). */
  permissions: string[];
  /** Platform-level roles cannot be granted inside a tenant. */
  platformOnly?: boolean;
}

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: "platform_admin",
    name: "Platform Administrator",
    description: "Operates the platform itself. Does NOT grant access to tenant data.",
    permissions: ["platform.admin"],
    platformOnly: true,
  },
  {
    key: "org_admin",
    name: "Organization Administrator",
    description: "Full administrative control of one organization.",
    permissions: ["*", "!platform.admin"],
  },
  {
    key: "security_admin",
    name: "Security Administrator",
    description: "Security policy, SSO, credentials, API keys and audit.",
    permissions: [
      "org.read", "org.security.*", "user.read", "user.manage", "role.read", "module.read",
      "connector.read", "connector.credential.manage", "policy.*", "audit.*", "apikey.*",
      "observability.read", "notification.manage", "ai.run.read", "ai.provider.read", "usage.read", "search.use",
    ],
  },
  {
    key: "ai_admin",
    name: "AI Administrator",
    description: "AI providers, models, routing and AI usage.",
    permissions: [
      "org.read", "module.read", "ai.*", "connector.read", "connector.use", "policy.read",
      "usage.read", "observability.read", "search.use",
    ],
  },
  {
    key: "auditor",
    name: "Auditor",
    description: "Read-only access to configuration and the audit log. Cannot change anything.",
    permissions: [
      "org.read", "org.security.read", "user.read", "role.read", "module.read", "connector.read",
      "ai.run.read", "ai.provider.read", "policy.read", "audit.read", "audit.export", "usage.read", "apikey.read", "search.use",
    ],
  },
  {
    key: "executive",
    name: "Executive",
    description: "Dashboards and reporting across enabled modules.",
    permissions: ["org.read", "module.read", "usage.read", "search.use"],
  },
  {
    key: "department_leader",
    name: "Department Leader",
    description: "Leads a department: views members, usage and uses AI.",
    permissions: ["org.read", "user.read", "module.read", "usage.read", "ai.use", "search.use"],
  },
  {
    key: "analyst",
    name: "Analyst",
    description: "Works with data and AI inside enabled modules.",
    permissions: ["org.read", "module.read", "ai.use", "connector.read", "connector.use", "usage.read", "search.use"],
  },
  {
    key: "standard_user",
    name: "Standard User",
    description: "Everyday use of enabled modules.",
    permissions: ["org.read", "module.read", "ai.use", "search.use"],
  },
  {
    key: "read_only",
    name: "Read Only",
    description: "View-only access.",
    permissions: ["org.read", "module.read", "search.use"],
  },
];

/**
 * Separation-of-duties constraints: a single member may not hold both roles.
 * Auditors must be independent of the administrators they audit.
 */
export const SOD_CONSTRAINTS: Array<{ a: string; b: string; reason: string }> = [
  { a: "auditor", b: "org_admin", reason: "Auditors must be independent of organization administrators." },
  { a: "auditor", b: "security_admin", reason: "Auditors must be independent of security administrators." },
];
