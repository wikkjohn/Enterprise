import { unique, boolean, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_columns";
import { memberships } from "./identity";
import { organizations } from "./tenancy";

/** Permission catalog (platform-level). Synced from code registrations at boot. */
export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  owner: text("owner").notNull(), // "core" or a module id
  description: text("description").notNull(),
  risk: text("risk", { enum: ["low", "medium", "high", "critical"] }).notNull().default("low"),
  createdAt: createdAt(),
});

/** Roles. organization_id NULL = system role (shared, code-defined); otherwise a custom tenant role. */
export const roles = pgTable(
  "roles",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("roles_org_key_uq").on(t.organizationId, t.key).nullsNotDistinct()],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

/**
 * Role assignment to a membership. scope_type/scope_id narrow a grant:
 *   null/null          → organization-wide
 *   'module'/<moduleId> → only for that module's permissions
 *   'resource'/<type:id> → only for that specific resource
 */
export const memberRoles = pgTable(
  "member_roles",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    scopeType: text("scope_type", { enum: ["module", "resource"] }),
    scopeId: text("scope_id"),
    grantedBy: uuid("granted_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("member_roles_uq").on(t.membershipId, t.roleId, t.scopeType, t.scopeId).nullsNotDistinct(),
    index("member_roles_org_idx").on(t.organizationId),
  ],
);
