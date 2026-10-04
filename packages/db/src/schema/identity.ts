import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations } from "./tenancy";

/** Global user identity. A user may belong to several organizations via memberships. */
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    status: text("status", { enum: ["pending", "active", "suspended", "deactivated"] }).notNull().default("pending"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    /** Secret-store reference for the TOTP seed — never the seed itself. */
    mfaSecretRef: text("mfa_secret_ref"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    lastLoginAt: ts("last_login_at"),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque session token. The raw token only exists in the cookie. */
    tokenHash: text("token_hash").notNull(),
    activeOrganizationId: uuid("active_organization_id").references(() => organizations.id, { onDelete: "set null" }),
    authMethod: text("auth_method", { enum: ["password", "oidc", "saml"] }).notNull().default("password"),
    mfaVerifiedAt: ts("mfa_verified_at"),
    /** True while the session awaits a second factor; such sessions cannot access tenant data. */
    mfaPending: boolean("mfa_pending").notNull().default(false),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/** One-time tokens: password reset, email verification. Only hashes are stored. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["password_reset", "email_verification"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["invited", "active", "suspended", "removed"] }).notNull().default("active"),
    title: text("title"),
    department: text("department"),
    /** How the membership was provisioned. */
    source: text("source", { enum: ["manual", "invitation", "sso_jit", "scim"] }).notNull().default("manual"),
    joinedAt: ts("joined_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.organizationId, t.userId), index("memberships_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleKeys: text("role_keys").array().notNull().default(sql`'{}'::text[]`),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invitations_token_hash_uq").on(t.tokenHash), index("invitations_org_idx").on(t.organizationId)],
);

/** Per-organization SSO configuration (OIDC / SAML). Client secrets are secret references. */
export const identityProviders = pgTable(
  "identity_providers",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    protocol: text("protocol", { enum: ["oidc", "saml"] }).notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "active", "disabled"] }).notNull().default("draft"),
    /** OIDC: issuer, clientId, scopes. SAML: entityId, ssoUrl, certificate fingerprint. Never secrets. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    clientSecretRef: text("client_secret_ref"),
    domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
    jitProvisioning: boolean("jit_provisioning").notNull().default(false),
    defaultRoleKey: text("default_role_key").notNull().default("standard_user"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("identity_providers_org_idx").on(t.organizationId)],
);
