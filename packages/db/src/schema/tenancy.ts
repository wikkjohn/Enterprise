import { unique, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_columns";

/** A customer company. The root of tenant ownership. */
export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status", { enum: ["pending", "active", "suspended", "archived"] }).notNull().default("active"),
    environment: text("environment", { enum: ["production", "staging", "sandbox"] }).notNull().default("production"),
    primaryDomain: text("primary_domain"),
    /** Entitlement/subscription readiness — the plan is informational until billing exists. */
    plan: text("plan").notNull().default("enterprise"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)],
);

export interface SecurityPolicySettings {
  mfaRequired: boolean;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  passwordMinLength: number;
  allowedEmailDomains: string[];
  ipAllowlist: string[];
  ssoEnforced: boolean;
}
export interface DataRetentionSettings {
  auditDays: number;
  /** none = never store prompt/response; metadata = hashes + sizes; full = store content */
  aiPromptRetention: "none" | "metadata" | "full";
  aiRunDays: number;
  notificationDays: number;
  usageDays: number;
}
export interface UsageLimitSettings {
  monthlyAiCostUsd?: number;
  monthlyAiTokens?: number;
}

export const organizationSettings = pgTable("organization_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  security: jsonb("security").$type<SecurityPolicySettings>().notNull(),
  dataRetention: jsonb("data_retention").$type<DataRetentionSettings>().notNull(),
  usageLimits: jsonb("usage_limits").$type<UsageLimitSettings>().notNull().default({}),
  locale: text("locale").notNull().default("en-US"),
  timezone: text("timezone").notNull().default("UTC"),
  updatedAt: updatedAt(),
});

export const organizationDomains = pgTable(
  "organization_domains",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    verificationToken: text("verification_token").notNull(),
    verifiedAt: ts("verified_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("organization_domains_domain_uq").on(t.domain), index("organization_domains_org_idx").on(t.organizationId)],
);

/** Catalog of modular applications (platform-level, not tenant-owned). */
export const modules = pgTable("modules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  version: text("version").notNull(),
  installStatus: text("install_status", { enum: ["installed", "not_installed", "deprecated"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizationModules = pgTable(
  "organization_modules",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id),
    enabled: boolean("enabled").notNull().default(false),
    enabledAt: ts("enabled_at"),
    enabledBy: uuid("enabled_by"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.moduleId] })],
);

/** Feature flags. organization_id NULL = platform default; non-null = tenant override. */
export const featureFlags = pgTable(
  "feature_flags",
  {
    id: id(),
    key: text("key").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    moduleId: text("module_id"),
    enabled: boolean("enabled").notNull().default(false),
    /** Percentage rollout 0–100 (by stable hash of organization id). */
    rolloutPercent: integer("rollout_percent").notNull().default(100),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("feature_flags_key_org_uq").on(t.key, t.organizationId).nullsNotDistinct()],
);
