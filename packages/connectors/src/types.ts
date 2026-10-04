import { type z } from "zod";
import { AppError } from "@eaop/shared-types";
import { type RiskLevel } from "@eaop/shared-types";

export type ConnectorAuthType = "oauth2" | "api_key" | "service_account" | "basic" | "none";
export type CapabilityOperation = "read" | "list" | "search" | "write" | "delete" | "execute" | "subscribe";
export type ConnectorCategory = "productivity" | "crm" | "erp" | "hr" | "itsm" | "collaboration" | "storage" | "database" | "protocol" | "custom";

/**
 * available     – a working adapter ships with the platform
 * contract_only – definition + configuration UI exist; the adapter is not yet
 *                 implemented (testing/execution fail with NOT_IMPLEMENTED)
 * sandbox       – simulated adapter for development/testing; never real data
 */
export type ConnectorAvailability = "available" | "contract_only" | "sandbox";

export interface CapabilityDefinition {
  key: string;
  description: string;
  operations: CapabilityOperation[];
  /** Provider scopes typically required. Informational for admins. */
  scopes?: string[];
  risk: RiskLevel;
  /** JSON-schema-like hint of params, for UIs / AI tool generation. */
  params?: Record<string, { type: string; required?: boolean; description?: string }>;
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "number" | "select" | "textarea";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
}

export interface CredentialField {
  key: string;
  label: string;
  /** Rendered as a password input, never echoed back. */
  secret: boolean;
  required?: boolean;
}

export interface ConnectorDefinition {
  type: string;
  name: string;
  vendor: string;
  category: ConnectorCategory;
  description: string;
  availability: ConnectorAvailability;
  authTypes: ConnectorAuthType[];
  capabilities: CapabilityDefinition[];
  configSchema: z.ZodTypeAny;
  configFields: ConfigField[];
  credentialFields: Partial<Record<ConnectorAuthType, CredentialField[]>>;
  rateLimit: { requestsPerMinute: number };
  oauth?: { authorizationUrl: string; tokenUrl: string; defaultScopes: string[]; usePkce?: boolean };
  /** Config keys holding URLs that must pass the SSRF guard. */
  urlConfigKeys?: string[];
  docsUrl?: string;
}

export interface AdapterContext {
  connectorId: string;
  organizationId: string;
  config: Record<string, unknown>;
  authType: ConnectorAuthType;
  credentials: Record<string, string> | null;
  fetch: GuardedFetch;
  signal: AbortSignal;
}

export type GuardedFetch = (url: string, init?: RequestInit) => Promise<{ status: number; headers: Headers; text: string; json<T = unknown>(): T }>;

export interface ConnectorAdapter {
  type: string;
  testConnection(ctx: AdapterContext): Promise<{ ok: boolean; message: string; latencyMs?: number; details?: Record<string, unknown> }>;
  execute(ctx: AdapterContext, request: { capability: string; operation: CapabilityOperation; params: Record<string, unknown> }): Promise<unknown>;
  /** Optional: obtain fresh credentials (OAuth refresh / client-credentials). */
  refreshCredentials?(ctx: AdapterContext): Promise<{ values: Record<string, string>; expiresAt?: Date }>;
}

export type ConnectorErrorClass = "auth" | "rate_limited" | "transient" | "permanent" | "configuration" | "not_implemented";

/** Normalised connector error. `retryAfterSeconds` honours upstream Retry-After. */
export class ConnectorError extends AppError {
  constructor(readonly errorClass: ConnectorErrorClass, message: string, readonly retryAfterSeconds?: number, readonly upstreamStatus?: number) {
    super(
      errorClass === "not_implemented" ? "NOT_IMPLEMENTED" : errorClass === "configuration" ? "VALIDATION_FAILED" : errorClass === "rate_limited" ? "RATE_LIMITED" : "UPSTREAM_ERROR",
      message,
      { errorClass, upstreamStatus },
      { retryable: errorClass === "transient" || errorClass === "rate_limited" },
    );
  }
}

export function classifyStatus(status: number, retryAfter?: string | null): ConnectorError | null {
  if (status >= 200 && status < 400) return null;
  if (status === 401 || status === 403) return new ConnectorError("auth", `Upstream rejected credentials (${status}).`, undefined, status);
  if (status === 429) return new ConnectorError("rate_limited", "Upstream rate limit reached.", parseRetryAfter(retryAfter), status);
  if (status >= 500 || status === 408) return new ConnectorError("transient", `Upstream error (${status}).`, undefined, status);
  return new ConnectorError("permanent", `Upstream returned ${status}.`, undefined, status);
}

/** Retry-After as seconds (delta-seconds or HTTP date); defaults to 30, capped at 300. */
export function parseRetryAfter(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === "") return 30;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 300);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 30 : Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), 300);
}
