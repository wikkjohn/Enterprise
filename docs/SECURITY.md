# Security

**No compliance certification (SOC 2, ISO/IEC 27001, or other) is claimed for this software.** The control mapping below is a conceptual aid for customers and auditors; it describes technical controls implemented in code and does not represent an audited control environment, which also requires organizational policies, operations and evidence.

## Threat model summary

| Asset | Primary threats | Main mitigations |
|---|---|---|
| Tenant data | Cross-tenant access via bugs, IDOR, crafted ids | PostgreSQL RLS (FORCE) under a non-superuser role; context-derived tenant id; services re-authorize; release-blocker test |
| Accounts / sessions | Credential stuffing, session theft, CSRF, login CSRF | scrypt, lockout + per-IP rate limit, opaque hashed sessions, HttpOnly/SameSite cookies, origin + double-submit CSRF, MFA |
| Privileges | Escalation by tenant admins, self-grant, collusion | Anti-escalation, self-change prevention, SoD, last-admin protection, non-delegable API key scopes, `platform.admin` never grantable |
| Secrets (connector creds, API keys, IdP secrets, TOTP seeds) | DB exfiltration, log leakage | Secret store with references only, AES-256-GCM (local), hashes for tokens/keys, redaction in logs/audit/errors |
| Outbound requests | SSRF to metadata/internal services, open redirects | URL guard with DNS resolution, no redirects, HTTPS only, relative-only notification/search URLs |
| AI usage | Sensitive data to unapproved models, uncontrolled spend | Classification-aware routing, `ai_usage` policies, DLP hook point, per-actor AI rate limit, run logging, usage alerts |
| Audit trail | Tampering, deletion | Append-only trigger + privilege revocation; purge only via SECURITY DEFINER function with a 90-day floor |
| Availability | Request floods, runaway jobs | Rate limits, body size limit, job timeouts, dead-letter |

## Controls

| Control | Implementation |
|---|---|
| **Tenant isolation** | RLS policies on every tenant table (`packages/db/migrations/0001_tenant_isolation_and_security.sql`); `withTenant`/`withUser`/`withSystem` with transaction-local GUCs (`packages/db/src/client.ts`); tenant id only from `TenantContext`; `tests/integration/tenant-isolation.test.ts` |
| **Server-side authorization** | `authorizer.require` inside every tenant service method plus `permission` on routes (`packages/rbac/src/authorizer.ts`, `packages/api/src/route.ts`); module entitlement enforced in the authorizer; UI permission lists are hints only (`apps/web/src/lib/viewer.ts`) |
| **Authentication & sessions** | `packages/auth/src/sessions.ts`, `auth-service.ts`: 256-bit opaque tokens, SHA-256 at rest, idle + absolute timeouts, per-request membership re-check, revocation on password change/reset |
| **Password storage** | scrypt N=2^17, r=8, p=1 (`packages/security/src/password.ts`); dummy-hash timing equalization for unknown users |
| **Brute-force protection** | 5 failures → 15-minute lock; `RATE_LIMITS.login` per IP; generic error messages; no account enumeration on reset/switch-org |
| **MFA** | TOTP (`packages/security/src/totp.ts`), org-enforceable |
| **CSRF** | `verifyCsrf` (origin + `x-csrf-token`/`eaop_csrf` double submit) for cookie-authenticated mutations; foreign-`Origin` rejection on public mutations; `SameSite=Lax` cookies |
| **Security headers / CSP** | `securityHeaders()` (`packages/security/src/headers.ts`) applied to all paths via `apps/web/next.config.ts`: `default-src 'self'`, `script-src 'self' 'unsafe-inline'` (+`'unsafe-eval'` outside production), `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src 'self'`; `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geo/payment off), COOP/CORP `same-origin`; HSTS (`max-age=63072000; includeSubDomains; preload`) when `APP_ENV=production`. `poweredByHeader: false` |
| **Input validation** | zod schemas on every route body/query and inside services; JSON-only bodies ≤ 2 MB; UUID checks on tenant scope; policy-definition validation (operator whitelist, regex length) |
| **Output encoding** | JSON envelopes only from the API; React escaping in UI; CSV export neutralizes formula injection (`apps/web/src/app/api/v1/audit/export/route.ts`) |
| **Open-redirect prevention** | Notification `actionUrl` and search hit `url` must be relative (`^\/(?!\/)`) |
| **Rate limiting** | Token bucket per actor/IP (`packages/security/src/rate-limit.ts`): `api` 600/min, `login` 10/5 min, `ai` 60/min, `connector` per instance, plus per-route rules |
| **SSRF** | `assertSafeOutboundUrl` for connectors (every request), webhooks (create + delivery), OIDC discovery/token endpoints, OpenAI-compatible providers, email relay; `redirect: "manual"`; 5 MB response cap for connectors |
| **Secrets management** | `packages/secrets`: references in DB, values encrypted (local) or delegated (future managed providers); tenant-bound references; webhook signing secrets and API keys shown once |
| **Audit logging** | `packages/audit`: who/what/when/where, before/after, denials recorded detached; append-only in the database |
| **Error hygiene** | Unknown errors → `INTERNAL` with no message or stack (`packages/api/src/http.ts`); details reported server-side via `platform.errors.report` with redaction; `AppError` messages are written to be client-safe |
| **Redaction** | `redact()` on log fields, audit `before`/`after`/`metadata`; `redactString()` on error messages, connector errors, job errors (`packages/observability/src/redact.ts`) |
| **Environment isolation** | `APP_ENV`: sandbox connector and sandbox AI provider excluded in production; local secret store refuses production; seed and `db:reset` refuse production; `APP_URL` must be `https://` in production; organization `environment` field (`production/staging/sandbox`) |
| **Webhook integrity** | HMAC-SHA256 signatures with timestamp (`x-eaop-signature`) |
| **Least-privilege DB role** | Runtime role is `NOSUPERUSER NOBYPASSRLS`; audit table has no UPDATE/DELETE/TRUNCATE grants |
| **Supply-chain guardrails** | ESLint forbids provider SDK imports outside `packages/ai/src/providers` and `pg` imports in `modules/**`; `pnpm install --frozen-lockfile` in CI; `onlyBuiltDependencies` allow-list in `pnpm-workspace.yaml` |

## Control mapping (conceptual)

Aligned by category with SOC 2 Trust Services Criteria, ISO/IEC 27001:2022 Annex A and NIST CSF 2.0. Indicative only — **not an attestation**.

| Platform control | SOC 2 (TSC) | ISO 27001 Annex A | NIST CSF 2.0 |
|---|---|---|---|
| Tenant isolation (RLS) | CC6.1 | 8.3 Information access restriction | PR.AA, PR.DS |
| RBAC, least privilege, SoD | CC6.1, CC6.3 | 5.15 Access control, 5.3 Segregation of duties, 8.2 Privileged access | PR.AA |
| Authentication, MFA, sessions | CC6.1, CC6.2 | 5.17 Authentication information, 8.5 Secure authentication | PR.AA |
| User lifecycle (invite, suspend, remove, revoke sessions) | CC6.2, CC6.3 | 5.16 Identity management, 5.18 Access rights | PR.AA |
| Audit logging, append-only, export | CC7.2, CC4.1 | 8.15 Logging, 8.16 Monitoring activities | DE.CM, DE.AE |
| Secrets management, encryption | CC6.1, CC6.7 | 8.24 Use of cryptography, 5.33 Protection of records | PR.DS |
| Input validation, CSRF, headers, SSRF guard | CC6.6, CC6.8 | 8.26 Application security requirements, 8.28 Secure coding | PR.PS |
| Rate limiting, timeouts, job dead-lettering | A1.1, CC7.1 | 8.6 Capacity management | PR.IR |
| Health checks, metrics, error reporting | CC7.1, CC7.2 | 8.16 Monitoring activities | DE.CM |
| Data retention settings and purge | C1.2, P4.2 | 8.10 Information deletion | PR.DS |
| Change control for policies (versioned, audited) | CC8.1 | 8.32 Change management | PR.PS |
| Tenant-isolation release-blocker test, CI gates | CC8.1 | 8.29 Security testing in development and acceptance | ID.IM |
| AI usage policies, classification routing, run logs | CC6.1, CC7.2 | 5.12 Classification of information, 5.14 Information transfer | PR.DS, GV.OC |

## Known gaps

| Gap | Notes |
|---|---|
| Managed secret manager adapters (AWS/Azure/Vault/GCP) | Stubs only; production needs one (or the explicit local override) |
| Shared rate limiter | In-memory per instance; `REDIS_URL` unused |
| SAML sign-in, SCIM, MFA recovery codes, WebAuthn | Not implemented |
| OIDC | Implemented but not yet validated against a real IdP |
| CSP allows `'unsafe-inline'` scripts | Needed by the framework today; nonces/hashes not implemented |
| `ssoEnforced` checked only for the user's default org at password login | See [AUTHENTICATION.md](AUTHENTICATION.md#security-policy-controls) |
| Last-admin protection covers role revocation, not member suspension/removal | See [RBAC.md](RBAC.md#safeguards) |
| Webhook create/delete not audited | `AuditActions.WEBHOOK_CREATED/DELETED` defined but unused |
| `aiPromptRetention: "none"` still stores prompt hash and sizes | Same as `metadata` |
| `ai.execute` accepts any `moduleId` string | Attribution only; not checked against entitlements |
| Usage limits alert but do not block | No hard spend cap |
| No approval workflow for `REQUIRE_APPROVAL` / `ESCALATE` | Runs are recorded as `pending_approval` only |
| Client IP = last `x-forwarded-for` entry | Correct only behind a proxy that appends the client address; direct exposure lets clients set the header |
| OIDC JWKS fetch bypasses the URL guard | `jwks_uri` from the (guarded) discovery document is fetched by `jose.createRemoteJWKSet` without `assertSafeOutboundUrl` |
| Tracing spans not emitted; no external error sink configured | Extension points exist |
| Encryption at rest of the database, backups, TLS termination | Deployment responsibility ([DEPLOYMENT.md](DEPLOYMENT.md)) |

Report suspected vulnerabilities to the repository owners privately; do not open public issues.
