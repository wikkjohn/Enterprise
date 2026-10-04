import { type OwnerId, type RiskLevel } from "@eaop/shared-types";

export interface PermissionDefinition {
  key: string;
  description: string;
  risk?: RiskLevel;
}

export interface RegisteredPermission extends Required<PermissionDefinition> {
  owner: OwnerId;
}

/** Format: <namespace>[.<sub>].<verb>, lowercase with underscores. */
export const PERMISSION_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Central permission registry. The core and every module register their
 * permissions here at boot; nothing else may invent permission keys.
 */
export class PermissionRegistry {
  private perms = new Map<string, RegisteredPermission>();

  register(owner: OwnerId, defs: PermissionDefinition[]) {
    for (const def of defs) {
      if (!PERMISSION_KEY_RE.test(def.key)) throw new Error(`Invalid permission key "${def.key}"`);
      const existing = this.perms.get(def.key);
      if (existing && existing.owner !== owner) throw new Error(`Permission "${def.key}" already registered by "${existing.owner}"`);
      this.perms.set(def.key, { key: def.key, description: def.description, risk: def.risk ?? "low", owner });
    }
  }

  has(key: string) {
    return this.perms.has(key);
  }

  get(key: string) {
    return this.perms.get(key);
  }

  list(): RegisteredPermission[] {
    return [...this.perms.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Expand patterns: "*" (all), "workflow.*" (prefix), or an exact key. Unknown exact keys throw. */
  expand(patterns: string[]): string[] {
    const out = new Set<string>();
    for (const p of patterns) {
      if (p === "*") this.perms.forEach((_, k) => out.add(k));
      else if (p.endsWith(".*")) {
        const prefix = p.slice(0, -1);
        this.perms.forEach((_, k) => k.startsWith(prefix) && out.add(k));
      } else if (p.startsWith("!")) continue;
      else if (this.perms.has(p)) out.add(p);
      else throw new Error(`Unknown permission "${p}"`);
    }
    // Exclusions: "!platform.admin"
    for (const p of patterns.filter((x) => x.startsWith("!"))) {
      const ex = p.slice(1);
      for (const k of [...out]) if (k === ex || (ex.endsWith(".*") && k.startsWith(ex.slice(0, -1)))) out.delete(k);
    }
    return [...out].sort();
  }
}

/** Shared-core permissions. Modules register their own (e.g. workflow.read) via their manifest. */
export const CORE_PERMISSIONS: PermissionDefinition[] = [
  { key: "platform.admin", description: "Administer the platform: provision organizations, manage the module catalog.", risk: "critical" },
  { key: "org.read", description: "View organization profile.", risk: "low" },
  { key: "org.manage", description: "Change organization profile, domains and settings.", risk: "high" },
  { key: "org.security.read", description: "View security settings and SSO configuration.", risk: "medium" },
  { key: "org.security.manage", description: "Change security policy, SSO and MFA requirements.", risk: "critical" },
  { key: "user.read", description: "View organization members.", risk: "low" },
  { key: "user.invite", description: "Invite users to the organization.", risk: "medium" },
  { key: "user.manage", description: "Suspend, reactivate and remove members.", risk: "high" },
  { key: "role.read", description: "View roles and assignments.", risk: "low" },
  { key: "role.manage", description: "Create custom roles and assign/revoke roles.", risk: "critical" },
  { key: "module.read", description: "View enabled modules.", risk: "low" },
  { key: "module.manage", description: "Enable/disable modules and feature flags.", risk: "high" },
  { key: "connector.read", description: "View connectors and their health.", risk: "low" },
  { key: "connector.use", description: "Execute connector capabilities.", risk: "medium" },
  { key: "connector.manage", description: "Create, update and delete connectors.", risk: "high" },
  { key: "connector.credential.manage", description: "Set, rotate and revoke connector credentials.", risk: "critical" },
  { key: "ai.use", description: "Run AI requests through the shared AI layer.", risk: "medium" },
  { key: "ai.run.read", description: "View AI run logs.", risk: "medium" },
  { key: "ai.provider.read", description: "View AI providers and models.", risk: "low" },
  { key: "ai.provider.manage", description: "Configure AI providers, models and routing.", risk: "high" },
  { key: "policy.read", description: "View policies.", risk: "low" },
  { key: "policy.manage", description: "Create, version and activate policies.", risk: "high" },
  { key: "audit.read", description: "Query the audit log.", risk: "medium" },
  { key: "audit.export", description: "Export the audit log.", risk: "high" },
  { key: "notification.manage", description: "Manage organization notification settings and webhooks.", risk: "medium" },
  { key: "usage.read", description: "View usage metering.", risk: "low" },
  { key: "observability.read", description: "View the operational health dashboard.", risk: "medium" },
  { key: "apikey.read", description: "View API keys (metadata only).", risk: "low" },
  { key: "apikey.manage", description: "Create and revoke API keys.", risk: "critical" },
  { key: "search.use", description: "Use global search.", risk: "low" },
];
