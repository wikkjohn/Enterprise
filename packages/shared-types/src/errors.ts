/**
 * Platform-wide error model. Every service throws AppError (or a subclass);
 * the API layer maps it to the standard error envelope. Never put secrets or
 * stack traces in `message` or `details` — both may be returned to clients.
 */
export const ErrorCodes = {
  UNAUTHENTICATED: { status: 401, message: "Authentication required." },
  MFA_REQUIRED: { status: 401, message: "Multi-factor authentication required." },
  FORBIDDEN: { status: 403, message: "You do not have permission to perform this action." },
  MODULE_NOT_ENABLED: { status: 403, message: "This module is not enabled for your organization." },
  ORGANIZATION_SUSPENDED: { status: 403, message: "This organization is suspended." },
  CSRF_FAILED: { status: 403, message: "Request origin could not be verified." },
  NOT_FOUND: { status: 404, message: "Resource not found." },
  VALIDATION_FAILED: { status: 422, message: "Request validation failed." },
  CONFLICT: { status: 409, message: "The resource is in a conflicting state." },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "Idempotency key was reused with a different request." },
  RATE_LIMITED: { status: 429, message: "Too many requests." },
  NOT_CONFIGURED: { status: 501, message: "This capability requires configuration that is not present." },
  NOT_IMPLEMENTED: { status: 501, message: "This capability is not implemented yet." },
  UPSTREAM_ERROR: { status: 502, message: "An upstream system returned an error." },
  UPSTREAM_TIMEOUT: { status: 504, message: "An upstream system timed out." },
  POLICY_DENIED: { status: 403, message: "The action was denied by policy." },
  APPROVAL_REQUIRED: { status: 202, message: "The action requires approval." },
  INTERNAL: { status: 500, message: "An internal error occurred." },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export interface ErrorDetails {
  [key: string]: unknown;
}

/**
 * Brand used instead of `instanceof`: bundlers (Next.js + pnpm symlinks) can
 * load this module twice, and `instanceof` fails across copies — which would
 * turn every 403/404 into a 500. Always use isAppError().
 */
const APP_ERROR_BRAND = Symbol.for("eaop.AppError");

export function isAppError(err: unknown, code?: ErrorCode): err is AppError {
  return typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[APP_ERROR_BRAND] === true && (code === undefined || (err as AppError).code === code);
}

export class AppError extends Error {
  readonly [APP_ERROR_BRAND] = true;
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;
  /** Whether a retry of the same operation may succeed. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message?: string, details?: ErrorDetails, options?: { cause?: unknown; retryable?: boolean }) {
    super(message ?? ErrorCodes[code].message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = ErrorCodes[code].status;
    this.details = details;
    this.retryable = options?.retryable ?? false;
  }

  static is(err: unknown, code?: ErrorCode): err is AppError {
    return isAppError(err, code);
  }
}

export const notFound = (resource: string, id?: string) =>
  new AppError("NOT_FOUND", `${resource} not found.`, id ? { resource, id } : { resource });
export const forbidden = (message?: string, details?: ErrorDetails) => new AppError("FORBIDDEN", message, details);
export const conflict = (message: string, details?: ErrorDetails) => new AppError("CONFLICT", message, details);
export const notConfigured = (what: string, details?: ErrorDetails) =>
  new AppError("NOT_CONFIGURED", `${what} is not configured.`, details);
