/**
 * Security headers applied to every response (Next.js config + API layer).
 * CSP allows only same-origin scripts; inline styles are permitted for the
 * framework's style injection.
 */
export function securityHeaders(opts: { isProduction: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${opts.isProduction ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  };
  if (opts.isProduction) headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  return headers;
}

export const SESSION_COOKIE = "eaop_session";
export const CSRF_COOKIE = "eaop_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function sessionCookieAttributes(opts: { isProduction: boolean; maxAgeSeconds: number }) {
  return {
    httpOnly: true,
    secure: opts.isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: opts.maxAgeSeconds,
  };
}
