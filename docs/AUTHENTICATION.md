# Authentication

Code: `packages/auth/src` (`sessions.ts`, `auth-service.ts`, `api-keys.ts`, `sso.ts`), `packages/security/src`, route handlers in `apps/web/src/app/api/v1/auth/**`, cookie helpers in `apps/web/src/lib/api.ts`.

## Endpoints

| Method & path | `auth` mode | Purpose |
|---|---|---|
| `POST /api/v1/auth/login` | public (10 req / 300 s per IP) | Password sign-in; returns `{ status: "ok" \| "mfa_required", user }` and sets cookies |
| `POST /api/v1/auth/mfa/verify` | public (10 / 300 s) | Complete a pending MFA session (`{ code }`) |
| `POST /api/v1/auth/logout` | session_any (CSRF-checked) | Revoke the session, clear cookies |
| `GET /api/v1/auth/session` | session_any | Current user, active org, orgs, permissions, navigation |
| `GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:id` | session_any | List / revoke own sessions |
| `POST /api/v1/auth/switch-organization` | session_any | `{ organizationId }` |
| `POST /api/v1/auth/password/change` | session_any | `{ currentPassword, newPassword }` |
| `POST /api/v1/auth/password/forgot` | public (5 / 900 s) | Always 202 |
| `POST /api/v1/auth/password/reset` | public (10 / 900 s) | `{ token, password }` |
| `POST /api/v1/auth/mfa/enroll` / `confirm` / `disable` | session_any | TOTP enrollment |
| `GET/POST /api/v1/auth/invitations/:token` | public | Describe / accept an invitation |
| `POST /api/v1/auth/signup` | public | Self-serve signup (off unless `ALLOW_SELF_SERVE_SIGNUP=true`) |
| `POST /api/v1/auth/sso/discover` | public (20 / 60 s) | Home-realm discovery by email domain |
| `GET /api/v1/auth/sso/start?idp=<id>` | public | Redirect to the IdP |
| `GET /api/v1/auth/sso/oidc/callback` | public | OIDC redirect URI |

## Sessions

- **Opaque token**: `randomToken(32)` (256-bit, base64url) in the `eaop_session` cookie. The DB stores only `sha256(token)` (`sessions.token_hash`).
- **Validation** (`SessionManager.validate`, every request): token hash lookup, not revoked, not expired, user `status = active` (otherwise revoked with `user_inactive`), idle check against the **active organization's** `sessionIdleMinutes` (default 60; revoked with `idle_timeout`). `last_seen_at` is touched at most once per minute.
- **Absolute lifetime**: `expires_at = now + min(org.sessionMaxHours, ABSOLUTE_SESSION_HOURS = 168)` at creation (default 12 h). Organization policy can only shorten.
- **Membership re-check**: `auth.resolve` re-reads the user's active memberships on every request; if the active org is no longer an active membership it falls back to another active org (or none). Suspending/removing a member also clears `active_organization_id` on that user's sessions for the org.
- **Revocation**: logout (`logout`), password change (all *other* sessions, `password_changed`), password reset (all sessions, `password_reset`), user revoke (`user_revoked`).

### Cookies (`sessionCookies` in `apps/web/src/lib/api.ts`)

| Cookie | Attributes | Content |
|---|---|---|
| `eaop_session` | `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`; `Secure` when `APP_ENV=production` | Session token |
| `eaop_csrf` | readable by JS; same SameSite/Secure/Max-Age | Random 24-byte token for double-submit |
| `eaop_sso_state` | `HttpOnly; SameSite=Lax; Path=/api/v1/auth/sso; Max-Age=600` | Signed OIDC state |

The cookie `Max-Age` is a fixed 7 days; the server-side idle/absolute limits are authoritative.

## CSRF

`verifyCsrf` (`packages/security/src/csrf.ts`) runs in `route()` for every cookie-authenticated request with a mutating method:

1. `Origin` (or the origin of `Referer`) must equal the origin of `APP_URL` → else `CSRF_FAILED` (`origin_mismatch`).
2. Header `x-csrf-token` must equal cookie `eaop_csrf` (constant-time) → else `CSRF_FAILED` (`token_mismatch`).

Safe methods (`GET`, `HEAD`, `OPTIONS`) are exempt. Bearer API-key requests are not cookie-authenticated and skip the check. Public mutating routes (login, signup, invitation acceptance, …) reject requests whose `Origin` header is present and foreign (login-CSRF); clients that send no `Origin` are unaffected. Logout is `session_any` so a third-party site cannot force a logout. The client helper `apiFetch` (`apps/web/src/lib/client.ts`) sends `x-csrf-token` automatically.

## Password sign-in and lockout

`auth.login` (`packages/auth/src/auth-service.ts`):

1. Unknown email or SSO-only user (no `password_hash`): verify against a dummy hash (timing equalization), record `auth.login_failed` as a platform event, return the generic `UNAUTHENTICATED` "Invalid email or password."
2. `locked_until` in the future: audited (`denied`, reason `locked`), `UNAUTHENTICATED`.
3. Wrong password or user not `active`: increment `failed_login_count`; at **5** failures set `locked_until = now + 15 min`; audited; generic error.
4. Resolve the user's default organization (first active membership by name). If its policy has `ssoEnforced` and the user is not a platform admin → `FORBIDDEN` "Your organization requires single sign-on." If `ipAllowlist` does not match the client IP → `FORBIDDEN` (audited).
5. Create the session. If the user has MFA enabled the session is `mfa_pending` and the response status is `mfa_required`; otherwise `auth.login` is audited.

Per-IP throttling (`RATE_LIMITS.login`, 10 per 300 s) applies in addition to per-account lockout.

## Password policy (NIST 800-63B style)

`checkPasswordPolicy` (`packages/security/src/password.ts`): length ≥ the org's `passwordMinLength` (default and minimum 12, max setting 128), ≤ 256 characters, not in a small common-password list, and must not contain the email local part (when ≥ 4 characters). No composition rules. Hashing: scrypt (N=2^17, r=8, p=1, 64-byte key, 16-byte salt), NFKC-normalized. When the user has no org the default minimum (12) applies.

## Password reset

`POST /auth/password/forgot` always returns 202 (no account enumeration). For an active user with a password it stores `sha256(token)` in `auth_tokens` (purpose `password_reset`, 30-minute expiry), audits `auth.password_reset_requested`, and — **only if `EMAIL_WEBHOOK_URL` is configured** — emails `${APP_URL}/reset-password?token=<token>`. Without an email relay it logs `auth.password_reset_email_not_configured` and the user cannot complete a reset. `POST /auth/password/reset` validates the token (single use, unexpired), applies the password policy, clears lockout, revokes all sessions and audits `auth.password_changed` with `{ via: "reset" }`.

## MFA (TOTP)

- `POST /auth/mfa/enroll` → `{ secret, otpauthUri }` (RFC 6238, SHA-1, 6 digits, 30 s, issuer = `PLATFORM_NAME`). The seed is stored in the secret store as a platform secret; `users.mfa_secret_ref` holds the reference.
- `POST /auth/mfa/confirm { code }` → `mfa_enabled = true`, audited `auth.mfa_enrolled`.
- At login, password sessions of MFA users start `mfa_pending`; `auth.resolve` treats pending sessions as unauthenticated. `POST /auth/mfa/verify { code }` (±1 step) completes it; failures are audited.
- `POST /auth/mfa/disable { code }` is refused if any of the user's organizations has `mfaRequired`; on success the seed is destroyed, `auth.mfa_disabled` audited, and a mandatory `core.security_alert` notification is sent.
- **Org requirement**: when `security.mfaRequired` is true and the user has not enrolled, every route returns `MFA_REQUIRED` (`details.enrollment = true`) except those flagged `allowDuringMfaEnrollment` (session info, session list/revoke, password change, MFA enroll/confirm, logout).
- **Not implemented**: recovery codes, WebAuthn. SSO (OIDC) sessions never require the platform TOTP step.

## Invitations

`POST /api/v1/invitations` (`user.invite`) → `organizations.invite`: checks `allowedEmailDomains`, verifies each role exists and that the inviter holds every permission of every role (anti-escalation), revokes older pending invitations for the same email, stores `sha256(token)` with a 7-day expiry, audits `user.invited`, publishes `user.invited`. The response contains `acceptUrl = ${APP_URL}/invite/<token>` **once**; no invitation email is sent by the platform.

Acceptance (`POST /auth/invitations/:token { name, password }`): an existing account must prove its current password; a new account is created after the password policy check. The membership is upserted (`source = invitation`), the invited roles are granted, `user.invitation_accepted` is audited, `user.joined` is published, the inviter receives `core.invitation_accepted`, and a session is started in that organization.

## Organization switching

`POST /auth/switch-organization { organizationId }` succeeds only for an organization where the user has an active membership and the org is active; otherwise `NOT_FOUND` (same response for non-existent and foreign orgs). Audited as `auth.organization_switched` in the target org. Each request still re-validates membership.

## API keys

| Aspect | Behaviour (`packages/auth/src/api-keys.ts`) |
|---|---|
| Format | `eaop_<prefix>_<secret>`: prefix = 12 alphanumerics (public, unique), secret = `randomToken(32)` |
| Storage | `api_keys_metadata.key_hash = sha256(full key)`; raw key returned once by `POST /api/v1/api-keys` |
| Create | Requires `apikey.manage`; every scope must be a registered permission, held org-wide by the creator, and not in `NON_DELEGABLE` = `platform.admin`, `apikey.manage`, `role.manage`. Optional `expiresInDays` 1–730 |
| Use | `Authorization: Bearer eaop_...` on routes declared `auth: "any"`. Session-only routes reject keys |
| Authenticate | Prefix lookup, constant-time hash compare; rejected if revoked, expired or the org is not `active`; `last_used_at` touched at most once per minute |
| Permissions | Actor type `api_key` with `scopes`; authorizer grants exactly the registered scopes; module-owned scopes still require the module to be enabled |
| Metering | Each request records `api.requests` usage with a normalized `endpoint` |
| Events/audit | `api_key.created` / `api_key.revoked` (not delivered to webhooks); audit `api_key.created` / `api_key.revoked` |

Scopes are fixed at creation; they do not shrink if the creator later loses a role. Revoke keys when people change roles.

## SSO — OIDC (implemented, not yet tested against a real IdP)

Configuration (`POST /api/v1/organization/identity-providers`, `org.security.manage`):

```json
{ "protocol": "oidc", "name": "Okta", "issuer": "https://example.okta.com",
  "clientId": "...", "clientSecret": "...", "scopes": ["openid","email","profile"],
  "domains": ["example.com"], "jitProvisioning": true, "defaultRoleKey": "standard_user" }
```

`configureOidc` fetches `<issuer>/.well-known/openid-configuration` through the SSRF guard (the advertised `authorization_endpoint`, `token_endpoint` and `jwks_uri` are each checked by the guard too), requires `authorization_endpoint`, `token_endpoint`, `jwks_uri` and an exactly matching `issuer`, stores the client secret in the secret store (`client_secret_ref`), and saves the IdP as `draft`. Activate with `PATCH /api/v1/organization/identity-providers/:id { "status": "active" }`. Changes are audited as `sso.identity_provider_changed`.

Flow:

1. **Discovery** — `POST /auth/sso/discover { email }` finds an active IdP whose `domains` contains the email's domain.
2. **Start** — `GET /auth/sso/start?idp=<id>`: builds `state = base64url(JSON{ idp, org, nonce, verifier, exp: +10 min }).HMAC-SHA256(APP_SECRET)`, sets it as the `eaop_sso_state` cookie, and redirects to the authorization endpoint with `response_type=code`, `client_id`, `redirect_uri = ${APP_URL}/api/v1/auth/sso/oidc/callback`, `scope`, `state = sha256(cookie value)`, `nonce`, `code_challenge` (S256 of a 48-byte verifier).
3. **Callback** — verifies the cookie's HMAC and expiry and that `sha256(cookie) == state`; exchanges the code (with `code_verifier` and, if configured, `client_secret`) at the token endpoint (SSRF-guarded); verifies the `id_token` with `jose` against the IdP JWKS (`jwks_uri` re-checked by the SSRF guard) (`issuer`, `audience = clientId`); checks `nonce`; requires an `email` claim and `email_verified !== false`; enforces the IdP `domains` list.
4. **Account** — existing active member → session. Otherwise, if `jitProvisioning` is on and the user is not a member (or only `invited`): create the user if needed (no password), upsert an active membership with `source = sso_jit`, grant `defaultRoleKey`, publish `user.joined`. Otherwise `FORBIDDEN` (audited `auth.login_failed`, reason `sso_not_member`).
5. A session with `auth_method = oidc` is created in the IdP's organization; the response is a 302 to `/` with session cookies.

Needed from the customer: an OIDC application registered with the redirect URI above, issuer URL, client id, client secret (confidential client) and the email domains to route.

## SSO — SAML (configuration only)

`POST /api/v1/organization/identity-providers { "protocol": "saml", name, entityId, ssoUrl, certificateFingerprint, domains }` stores the configuration (draft). `startLogin` for a SAML IdP throws `NOT_IMPLEMENTED` ("SAML sign-in is not implemented yet."). Implementing it requires: an XML-signature validation library, an assertion consumer service endpoint, SP entity id/metadata, full IdP metadata or signing certificate (not just a fingerprint), replay protection and clock-skew handling, plus attribute mapping for email/name.

## SCIM (not implemented)

There is no SCIM endpoint. The schema reserves `memberships.source = 'scim'`. The intended contract, for whoever builds it:

| Item | Intended design |
|---|---|
| Endpoints | SCIM 2.0 `/scim/v2/Users`, `/scim/v2/Groups`, `ServiceProviderConfig`, `Schemas`, `ResourceTypes` |
| Auth | Per-organization bearer token (store hashed like API keys) bound to one organization |
| Users | Create/patch/deactivate map to `users` + `memberships` (`source = scim`); deactivate = membership `suspended`; never hard-delete (audit FKs) |
| Groups | Map to role assignments (group → role key), subject to the same anti-escalation/SoD rules |
| Audit | Every change via `audit.record` with actor type `system` / label `scim` |
| Isolation | All writes through `withTenant` for the token's organization |

## Security policy controls

| Control | Enforcement point |
|---|---|
| `ipAllowlist` | At login (user's default org) and on every authenticated request (active org) via `ipAllowed(meta.ip, ...)`. IPv4 CIDR and exact IPv6. Client IP is the last `x-forwarded-for` entry — deploy behind a proxy that appends it |
| `ssoEnforced` | At password login (user's default org) **and** on every request in `auth.resolve` for the **active** org: a session with `auth_method = password` gets `FORBIDDEN` "This organization requires single sign-on…" (platform admins exempt) |
| `mfaRequired` | Per request via `mfaEnrollmentRequired`; blocks MFA disable |
| `allowedEmailDomains` | At invitation |
| `sessionIdleMinutes` / `sessionMaxHours` | Session validation / creation |


## Bootstrap

`pnpm platform:admin` (`scripts/create-platform-admin.ts`, needs `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, optional `PLATFORM_ADMIN_NAME`) creates the first platform administrator and fails if one exists. Platform administrators can provision organizations through `POST /api/v1/platform/organizations` but get no tenant data access from that flag (see [RBAC.md](RBAC.md#platform-admin-vs-tenant-data)).
