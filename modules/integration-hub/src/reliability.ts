import { isConnectorError } from "@eaop/connectors";
import { redactString } from "@eaop/observability";
import { isAppError } from "@eaop/shared-types";

/**
 * Execution reliability primitives — pure and unit-tested: error
 * classification, retry decisions with backoff, and the per-connector
 * circuit breaker.
 */

export const ERROR_CLASSES = [
  "auth", "rate_limited", "transient", "timeout", "circuit_open", "permanent", "configuration", "not_implemented",
  "validation", "forbidden", "policy_denied", "approval_rejected", "internal",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Classes where waiting and trying again can succeed. */
export const RETRYABLE: ReadonlySet<ErrorClass> = new Set(["rate_limited", "transient", "timeout", "circuit_open"]);
/** Classes that count against a connector's circuit breaker. */
export const BREAKER_CLASSES: ReadonlySet<ErrorClass> = new Set(["transient", "timeout", "rate_limited"]);

export interface ClassifiedError {
  errorClass: ErrorClass;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  upstreamStatus?: number;
}

export class IntegrationError extends Error {
  constructor(readonly errorClass: ErrorClass, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "IntegrationError";
  }
}

const APP_CODE_CLASS: Record<string, ErrorClass> = {
  RATE_LIMITED: "rate_limited",
  UPSTREAM_TIMEOUT: "timeout",
  UPSTREAM_ERROR: "transient",
  VALIDATION_FAILED: "validation",
  FORBIDDEN: "forbidden",
  MODULE_NOT_ENABLED: "forbidden",
  ORGANIZATION_SUSPENDED: "forbidden",
  POLICY_DENIED: "policy_denied",
  NOT_IMPLEMENTED: "not_implemented",
  NOT_CONFIGURED: "configuration",
  CONFLICT: "configuration",
  NOT_FOUND: "configuration",
};

/** Map any thrown value to a stable, redacted classification. Never leaks stacks or secrets. */
export function classifyError(err: unknown): ClassifiedError {
  let errorClass: ErrorClass = "internal";
  let retryAfterSeconds: number | undefined;
  let upstreamStatus: number | undefined;
  if (err instanceof IntegrationError) {
    errorClass = err.errorClass;
    retryAfterSeconds = err.retryAfterSeconds;
  } else if (isConnectorError(err)) {
    errorClass = err.errorClass as ErrorClass;
    retryAfterSeconds = err.retryAfterSeconds;
    upstreamStatus = err.upstreamStatus;
  } else if (isAppError(err)) {
    errorClass = APP_CODE_CLASS[err.code] ?? "internal";
    const ra = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    if (typeof ra === "number") retryAfterSeconds = ra;
  }
  const raw = err instanceof Error ? err.message : "Unknown error";
  const message = errorClass === "internal" ? "An internal error occurred while running this step." : redactString(raw).slice(0, 500);
  return { errorClass, message, retryable: RETRYABLE.has(errorClass), retryAfterSeconds, upstreamStatus };
}

export interface RetryDecision {
  retry: boolean;
  delaySeconds: number;
  reason: string;
}

/**
 * Retry if the error is retryable and attempts remain. Delay is exponential
 * (backoff × 2^(attempt−1)), never shorter than an upstream Retry-After,
 * capped at one hour.
 */
export function decideRetry(e: ClassifiedError, attempt: number, policy: { maxAttempts: number; backoffSeconds: number }): RetryDecision {
  if (!e.retryable) return { retry: false, delaySeconds: 0, reason: `${e.errorClass} is not retryable` };
  if (attempt >= policy.maxAttempts) return { retry: false, delaySeconds: 0, reason: `exhausted ${policy.maxAttempts} attempt(s)` };
  const exp = policy.backoffSeconds * 2 ** (attempt - 1);
  const delaySeconds = Math.min(3600, Math.max(exp, e.retryAfterSeconds ?? 0));
  return { retry: true, delaySeconds, reason: `attempt ${attempt} of ${policy.maxAttempts} failed (${e.errorClass}); retrying in ${delaySeconds}s` };
}

export interface BreakerConfig {
  threshold: number;
  windowSeconds: number;
  cooldownSeconds: number;
}
export const DEFAULT_BREAKER: BreakerConfig = { threshold: 5, windowSeconds: 300, cooldownSeconds: 60 };

export interface BreakerState {
  state: "closed" | "open" | "half_open";
  recentFailures: number;
  retryAfterSeconds: number;
}

/**
 * Circuit breaker from recent failure timestamps (shared across instances via
 * the integration_errors table). Open: ≥ threshold failures in the window and
 * the last one within the cooldown → fail fast. Half-open: threshold reached
 * but cooled down → let a probe through. Closed otherwise.
 */
export function breakerState(failures: Date[], now: Date, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerState {
  const windowStart = now.getTime() - cfg.windowSeconds * 1000;
  const recent = failures.filter((d) => d.getTime() >= windowStart);
  if (recent.length < cfg.threshold) return { state: "closed", recentFailures: recent.length, retryAfterSeconds: 0 };
  const last = Math.max(...recent.map((d) => d.getTime()));
  const sinceLast = (now.getTime() - last) / 1000;
  if (sinceLast < cfg.cooldownSeconds) return { state: "open", recentFailures: recent.length, retryAfterSeconds: Math.ceil(cfg.cooldownSeconds - sinceLast) };
  return { state: "half_open", recentFailures: recent.length, retryAfterSeconds: 0 };
}

/** Run with a deadline; rejects with a timeout IntegrationError. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new IntegrationError("timeout", `Timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fields that never land in execution logs unless an action opts into payload capture. */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|ssn|card|cvv|iban|account[_-]?number/i;

/** Redact secrets/PII-looking keys and long strings for history storage. */
export function summarizePayload(value: unknown, capture: boolean, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return capture ? redactString(value).slice(0, 5000) : redactString(value).slice(0, 300);
  if (typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, capture ? 200 : 20).map((v) => summarizePayload(v, capture, depth + 1));
    return value.length > items.length ? [...items, `[+${value.length - items.length} more]`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : summarizePayload(v, capture, depth + 1);
  return out;
}
