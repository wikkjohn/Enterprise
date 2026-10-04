import { type EventContract } from "@eaop/events";
import { type NotificationTypeDefinition } from "@eaop/notifications";
import { type PolicyKind } from "@eaop/policies";
import { type PermissionDefinition, type SystemRoleKey } from "@eaop/rbac";
import { type SearchProvider } from "@eaop/search";
import { type HealthStatus, type ModuleId, type TenantContext } from "@eaop/shared-types";

export interface ModuleNavItem {
  label: string;
  /** Relative path under the module's basePath, e.g. "/dashboard". */
  href: string;
  /** Hidden unless the user holds this permission. */
  permission?: string;
}

export interface ModuleFeatureFlag {
  key: string;
  description: string;
  defaultEnabled: boolean;
}

/**
 * The contract every module implements to plug into the shared core.
 * Registration is declarative: the platform wires permissions, events,
 * notification types, search providers and policy kinds into the SHARED
 * registries — modules never create their own.
 */
export interface ModuleManifest {
  id: ModuleId;
  name: string;
  shortName: string;
  description: string;
  version: string;
  /** "not_installed" = placeholder: visible in the catalog, cannot be enabled. */
  installStatus: "installed" | "not_installed";
  /** lucide-react icon name used by the shell. */
  icon: string;
  /** Route prefix in the web app, e.g. "/m/workflow-intelligence". */
  basePath: string;
  dependsOn?: ModuleId[];
  permissions: PermissionDefinition[];
  /** Extra permission patterns granted to SYSTEM roles when this module registers. */
  roleGrants?: Partial<Record<SystemRoleKey, string[]>>;
  events?: EventContract[];
  notificationTypes?: Array<Omit<NotificationTypeDefinition, "owner">>;
  searchProviders?: Array<Omit<SearchProvider, "owner">>;
  policyKinds?: Array<Omit<PolicyKind, "owner">>;
  featureFlags?: ModuleFeatureFlag[];
  navigation: ModuleNavItem[];
  /** Permission required to see the module in navigation at all. */
  entryPermission?: string;
  healthCheck?: () => Promise<HealthStatus>;
  onEnable?: (ctx: TenantContext) => Promise<void>;
  onDisable?: (ctx: TenantContext) => Promise<void>;
}

export class ModuleRegistry {
  private modules = new Map<ModuleId, ModuleManifest>();
  add(m: ModuleManifest) {
    if (this.modules.has(m.id)) throw new Error(`Module "${m.id}" already registered`);
    if (!m.basePath.startsWith("/m/")) throw new Error(`Module basePath must start with /m/ (got ${m.basePath})`);
    for (const p of m.permissions) {
      const ns = p.key.split(".")[0];
      if (ns === "platform" || ns === "org" || ns === "role") throw new Error(`Module "${m.id}" may not register core namespace permission "${p.key}"`);
    }
    this.modules.set(m.id, m);
  }
  get(id: ModuleId) {
    return this.modules.get(id);
  }
  list() {
    return [...this.modules.values()];
  }
}
