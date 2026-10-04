export type Uuid = string;
export type IsoDateString = string;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Priority = "low" | "normal" | "high" | "critical";
export type HealthState = "healthy" | "degraded" | "unhealthy" | "unknown" | "not_configured";

export interface HealthStatus {
  state: HealthState;
  message?: string;
  checkedAt: IsoDateString;
  details?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is Uuid {
  return typeof value === "string" && UUID_RE.test(value);
}
