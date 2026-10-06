import { SENSITIVITY_RANK, type Sensitivity } from "./detect";

/**
 * Permission-exposure and AI-exposure analysis — pure. Works on the
 * permission metadata a connector (or the ingestion API) reports; it never
 * calls a source system and never changes permissions.
 */
export const SHARING_SCOPES = ["private", "specific", "group", "organization", "public"] as const;
export type SharingScope = (typeof SHARING_SCOPES)[number];
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface Principal {
  type: "user" | "group" | "link" | "domain";
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  memberCount?: number;
  inherited?: boolean;
  lastActiveAt?: string;
  status?: "active" | "disabled" | "departed" | "guest";
}

export interface AssetPermissions {
  scope: SharingScope;
  publicLink?: boolean;
  principals?: Principal[];
}

export const ACCESS_FINDING_KINDS = ["public_link", "organization_wide", "stale_user", "overly_broad_group", "departed_user", "inherited_access", "sensitive_broad_access", "no_owner"] as const;
export type AccessFindingKind = (typeof ACCESS_FINDING_KINDS)[number];

export interface AccessFinding {
  kind: AccessFindingKind;
  severity: Severity;
  principal: string | null;
  detail: string;
  recommendation: "remove_broad_sharing" | "restrict_group" | "assign_owner" | null;
}

const BROAD_GROUP = /^(everyone|everyone except external users|all ?(users|staff|employees|company)|domain users|authenticated users|company[- ]wide|all[- ]hands)$/i;
const sev = (s: Sensitivity, table: Record<Sensitivity, Severity>) => table[s];
const STALE_DAYS = 90;

export function analyzeAccess(
  asset: { sensitivity: Sensitivity; permissions: AssetPermissions; hasOwner: boolean },
  ctx: { now: Date; inactiveEmails: Set<string>; broadGroupSize?: number },
): AccessFinding[] {
  const out: AccessFinding[] = [];
  const s = asset.sensitivity;
  const p = asset.permissions;
  const principals = p.principals ?? [];
  const broadSize = ctx.broadGroupSize ?? 500;
  const label = (x: Principal) => x.email ?? x.name ?? x.id ?? x.type;

  if (p.scope === "public" || p.publicLink || principals.some((x) => x.type === "link")) {
    out.push({ kind: "public_link", severity: sev(s, { public: "low", internal: "medium", confidential: "high", restricted: "critical" }), principal: null, detail: "Anyone with the link (or anyone on the internet) can open this asset.", recommendation: "remove_broad_sharing" });
  }
  if (p.scope === "organization" || principals.some((x) => x.type === "domain")) {
    out.push({ kind: "organization_wide", severity: sev(s, { public: "low", internal: "low", confidential: "medium", restricted: "high" }), principal: null, detail: "Shared with the whole organization.", recommendation: "remove_broad_sharing" });
  }
  for (const x of principals) {
    if (x.type === "group" && ((x.memberCount ?? 0) >= broadSize || BROAD_GROUP.test((x.name ?? "").trim()))) {
      out.push({ kind: "overly_broad_group", severity: sev(s, { public: "low", internal: "low", confidential: "medium", restricted: "high" }), principal: label(x), detail: `Group "${label(x)}"${x.memberCount ? ` (${x.memberCount} members)` : ""} grants access far beyond need-to-know.`, recommendation: "restrict_group" });
    }
    if (x.type === "user") {
      const email = (x.email ?? "").toLowerCase();
      if (x.status === "departed" || x.status === "disabled" || (email && ctx.inactiveEmails.has(email))) {
        out.push({ kind: "departed_user", severity: sev(s, { public: "low", internal: "medium", confidential: "high", restricted: "critical" }), principal: label(x), detail: `${label(x)} has left or is disabled but still has ${x.role ?? "access"}.`, recommendation: "restrict_group" });
      } else if (x.lastActiveAt && ctx.now.getTime() - Date.parse(x.lastActiveAt) > STALE_DAYS * 86400_000) {
        out.push({ kind: "stale_user", severity: sev(s, { public: "low", internal: "low", confidential: "medium", restricted: "medium" }), principal: label(x), detail: `${label(x)} has not been active for over ${STALE_DAYS} days.`, recommendation: "restrict_group" });
      }
    }
    if (x.inherited && SENSITIVITY_RANK[s] >= SENSITIVITY_RANK.confidential && (x.type === "group" || x.type === "domain")) {
      out.push({ kind: "inherited_access", severity: s === "restricted" ? "medium" : "low", principal: label(x), detail: `Access for ${label(x)} is inherited from a parent folder or site, so it changes when the parent does.`, recommendation: "restrict_group" });
    }
  }
  const broad = out.some((f) => f.kind === "public_link" || f.kind === "organization_wide" || f.kind === "overly_broad_group");
  if (broad && SENSITIVITY_RANK[s] >= SENSITIVITY_RANK.confidential) {
    out.push({ kind: "sensitive_broad_access", severity: s === "restricted" ? "critical" : "high", principal: null, detail: `${s === "restricted" ? "Restricted" : "Confidential"} content is broadly accessible.`, recommendation: "remove_broad_sharing" });
  }
  if (!asset.hasOwner && SENSITIVITY_RANK[s] >= SENSITIVITY_RANK.confidential) {
    out.push({ kind: "no_owner", severity: "medium", principal: null, detail: "Sensitive asset with no accountable owner.", recommendation: "assign_owner" });
  }
  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export const EXPOSURE_TYPES = ["approved_ai", "unapproved_ai", "enterprise_copilot", "agent", "external_model_api", "employee_ai_tool"] as const;
export type ExposureType = (typeof EXPOSURE_TYPES)[number];

export interface ExposureFinding {
  type: ExposureType;
  severity: Severity;
  basis: "inferred" | "observed";
  detail: string;
}

/** Source systems whose content enterprise copilots answer from (respecting the user's own permissions). */
const COPILOT_SOURCES = new Set(["microsoft_graph", "sharepoint", "onedrive", "teams", "google_workspace", "google_drive", "slack", "box", "confluence", "notion"]);

/** Exposure inferred from sharing alone (no observed AI traffic). */
export function inferExposure(asset: { sensitivity: Sensitivity; sourceSystem: string; permissions: AssetPermissions }): ExposureFinding[] {
  const s = asset.sensitivity;
  if (SENSITIVITY_RANK[s] < SENSITIVITY_RANK.confidential) return [];
  const out: ExposureFinding[] = [];
  const pub = asset.permissions.scope === "public" || asset.permissions.publicLink;
  if (pub) {
    out.push({ type: "external_model_api", severity: s === "restricted" ? "critical" : "high", basis: "inferred", detail: "Publicly reachable: any external AI service, crawler or model API can read it without signing in." });
    out.push({ type: "unapproved_ai", severity: s === "restricted" ? "critical" : "high", basis: "inferred", detail: "Anyone can paste or upload it into unapproved AI tools without access controls." });
  }
  if ((pub || asset.permissions.scope === "organization") && COPILOT_SOURCES.has(asset.sourceSystem.toLowerCase())) {
    out.push({ type: "enterprise_copilot", severity: s === "restricted" ? "high" : "medium", basis: "inferred", detail: "Enterprise copilots answer from everything a user can open; with organization-wide sharing every employee's assistant can surface this content." });
  }
  return out;
}

/** Exposure observed from a DLP event that referenced this asset. */
export function observedExposure(dest: { trust: string; category: string; actorType: string }, decision: string, s: Sensitivity): ExposureFinding {
  const sent = decision === "ALLOW" || decision === "REDACT";
  const type: ExposureType =
    dest.actorType === "agent" ? "agent"
    : dest.category === "enterprise_copilot" ? "enterprise_copilot"
    : dest.category === "model_api" ? "external_model_api"
    : dest.trust === "approved" ? "approved_ai"
    : dest.category === "platform" ? "approved_ai"
    : dest.trust === "unknown" || dest.trust === "experimental" ? "employee_ai_tool"
    : "unapproved_ai";
  const base: Severity = dest.trust === "approved" ? "low" : SENSITIVITY_RANK[s] >= SENSITIVITY_RANK.restricted ? "high" : "medium";
  return { type, severity: sent ? base : "low", basis: "observed", detail: `Content from this asset was ${sent ? (decision === "REDACT" ? "sent (redacted)" : "sent") : `stopped (${decision.toLowerCase().replace("_", " ")})`} to a ${dest.trust} AI destination.` };
}
