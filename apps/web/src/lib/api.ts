import { createRouteFactory, serializeCookie } from "@eaop/api";
import { CSRF_COOKIE, randomToken, SESSION_COOKIE } from "@eaop/security";
import { getPlatform } from "./platform";

/** The single route factory every /api/v1 handler uses. API conventions: docs/DEVELOPER-GUIDE.md. */
export const route = createRouteFactory(getPlatform);

const isProd = () => process.env.APP_ENV === "production";

/** Session cookie (HttpOnly) + CSRF double-submit cookie (readable by the SPA). */
export function sessionCookies(token: string, maxAgeSeconds: number): string[] {
  return [
    serializeCookie(SESSION_COOKIE, token, { httpOnly: true, secure: isProd(), sameSite: "lax", maxAge: maxAgeSeconds }),
    serializeCookie(CSRF_COOKIE, randomToken(24), { httpOnly: false, secure: isProd(), sameSite: "lax", maxAge: maxAgeSeconds }),
  ];
}

export function clearSessionCookies(): string[] {
  return [
    serializeCookie(SESSION_COOKIE, "", { httpOnly: true, secure: isProd(), sameSite: "lax", maxAge: 0 }),
    serializeCookie(CSRF_COOKIE, "", { httpOnly: false, secure: isProd(), sameSite: "lax", maxAge: 0 }),
  ];
}

export const SESSION_MAX_AGE = 7 * 24 * 3600;
