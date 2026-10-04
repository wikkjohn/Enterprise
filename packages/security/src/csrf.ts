import { constantTimeEqual } from "./crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests:
 *  1. SameSite=Lax session cookie (blocks most cross-site POSTs), and
 *  2. Origin/Referer must match the app origin, and
 *  3. Double-submit token: header x-csrf-token must equal the eaop_csrf cookie.
 * API-key (Bearer) requests are not cookie-authenticated and skip this check.
 */
export function verifyCsrf(input: {
  method: string;
  origin: string | null;
  referer: string | null;
  allowedOrigins: string[];
  csrfHeader: string | null;
  csrfCookie: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  const source = input.origin ?? (input.referer ? safeOrigin(input.referer) : null);
  if (!source || !input.allowedOrigins.includes(source)) return { ok: false, reason: "origin_mismatch" };
  if (!input.csrfHeader || !input.csrfCookie || !constantTimeEqual(input.csrfHeader, input.csrfCookie)) {
    return { ok: false, reason: "token_mismatch" };
  }
  return { ok: true };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
