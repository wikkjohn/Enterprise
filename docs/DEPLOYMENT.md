# Deployment

## Topology

```
            HTTPS (TLS terminated at proxy / LB — must APPEND client IP to X-Forwarded-For)
                 │
        ┌────────▼─────────┐   N replicas    ┌──────────────────┐   M replicas
        │ web (Next.js     │                 │ worker            │
        │ standalone)      │                 │ (pnpm worker)     │
        │ UI + /api/v1     │                 │ jobs, outbox,     │
        └────────┬─────────┘                 │ sweeps, retention │
                 │ DATABASE_URL (runtime)    └────────┬─────────┘
                 └──────────────┬─────────────────────┘
                         ┌──────▼──────┐   DATABASE_ADMIN_URL (migrations only)
                         │ PostgreSQL  │◀───────────────────────── migrate job
                         │ 16          │
                         └─────────────┘
 Outbound (optional): AI providers, tenant connectors/webhooks, OIDC IdPs,
 email relay (EMAIL_WEBHOOK_URL), secret manager (once implemented).
```

Required: web, worker, PostgreSQL 16. No Redis, no message broker. The worker is required for webhook delivery, email, event redelivery, connector health sweeps, credential-expiry alerts, usage alerts and retention.

## Environment variables

Validated by `envSchema` in `packages/platform/src/config.ts` (the process fails to start with `Invalid platform configuration — ...` on errors). Nothing loads `.env` files automatically except Next.js reading `.env*` from `apps/web`; inject variables through the environment.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_ENV` | no | `development` | `development` / `test` / `staging` / `production`. Production: `APP_URL` must be `https://`; sandbox connector/provider excluded; HSTS + `Secure` cookies; local secrets refused |
| `APP_URL` | no | `http://localhost:3000` | Public origin. Used for CSRF origin checks, OIDC/OAuth redirect URIs, invitation and reset links |
| `APP_SECRET` | **yes** | — | ≥ 32 characters. HMAC key for SSO state and connector OAuth state |
| `DATABASE_URL` | **yes** | — | Runtime role (non-superuser, no BYPASSRLS, member of `eaop_runtime`) |
| `SECRETS_PROVIDER` | no | `local` | `local` / `aws` / `azure` / `vault` / `gcp`; only `local` is implemented |
| `LOCAL_SECRETS_KEY` | with `local` | — | base64 of exactly 32 bytes |
| `ALLOW_LOCAL_SECRETS_IN_PRODUCTION` | no | — | `true` lets the local store run with `APP_ENV=production` (single-node/evaluation only) |
| `ALLOW_SELF_SERVE_SIGNUP` | no | `false` | Enables `POST /api/v1/auth/signup` |
| `ALLOW_PRIVATE_NETWORK_EGRESS` | no | `false` | Lets connectors/webhooks/IdPs/AI endpoints reach private addresses (and `http:` outside production). A warning is printed in production |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |
| `ANTHROPIC_API_KEY` | no | — | Enables the platform `anthropic` provider at bootstrap |
| `OPENAI_API_KEY` | no | — | Enables the platform `openai` provider (no models pre-seeded) |
| `EMAIL_WEBHOOK_URL` | no | — | Email relay; empty = email disabled (password reset and email notifications are not sent) |
| `PLATFORM_NAME` | no | `Enterprise AI Operating Platform` | TOTP issuer name |

Used outside `envSchema`:

| Variable | Used by |
|---|---|
| `DATABASE_ADMIN_URL` | `pnpm db:migrate`, `pnpm db:reset`, `packages/db/drizzle.config.ts` |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ADMIN_NAME` | `pnpm platform:admin` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | `pnpm db:seed` (development only) |
| `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL`, `TEST_DATABASE_APP_ROLE` | Integration tests (`tests/helpers/env.ts`) |
| `PORT`, `HOSTNAME`, `NODE_ENV` | Next.js standalone server (set in the `Dockerfile`) |

`REDIS_URL` is not read by the platform; it appears only as a commented, reserved entry in `.env.example`. `pnpm db:seed` runs through `createPlatform`, i.e. with `DATABASE_URL`.

### Email relay contract

`WebhookEmailSender` POSTs `{"to","subject","text"}` as JSON to `EMAIL_WEBHOOK_URL` (10 s timeout) and treats any non-2xx as a retryable failure. Operate a small function that forwards to SES/SendGrid/etc. In production the URL must pass the SSRF guard (HTTPS, public address).

## Database setup in production

Use a managed PostgreSQL 16 with encryption at rest, TLS, automated backups and point-in-time recovery.

```sql
-- Owner role used ONLY by migrations; needs CREATEROLE because migration 0001 creates eaop_runtime.
CREATE ROLE eaop_owner LOGIN CREATEROLE PASSWORD '<strong>';
CREATE DATABASE eaop OWNER eaop_owner;
-- Runtime role used by web and worker.
CREATE ROLE eaop_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<strong>';
```

```bash
DATABASE_ADMIN_URL=postgres://eaop_owner:...@host:5432/eaop pnpm db:migrate
psql "$DATABASE_ADMIN_URL" -c "GRANT eaop_runtime TO eaop_app;"
```

Never give the runtime role ownership of tables, `SUPERUSER` or `BYPASSRLS`. Run migrations as a one-off job before rolling out new web/worker versions; the runner holds `pg_advisory_lock(727274)`, so concurrent migrate jobs serialize.

## Bootstrap

```bash
PLATFORM_ADMIN_EMAIL=ops@example.com PLATFORM_ADMIN_PASSWORD='<12+ chars>' pnpm platform:admin
```

Creates the first platform administrator (fails if one exists). Then sign in and provision tenants via `POST /api/v1/platform/organizations { name, slug, environment?, primaryDomain?, adminUserId? }`. Do not run `pnpm db:seed` in production (it refuses when `APP_ENV=production`). `bootstrap()` (permission/role/module/AI catalog sync) runs automatically when web and worker start.

## Build and run

| Artifact | How |
|---|---|
| Web | `pnpm build` → Next.js `output: "standalone"` with `outputFileTracingRoot` at the monorepo root. Run `node apps/web/server.js` from `apps/web/.next/standalone`, with `apps/web/.next/static` copied to the same relative path. CI builds with dummy `APP_SECRET`, `DATABASE_URL`, `LOCAL_SECRETS_KEY` |
| Worker | `pnpm worker` (`tsx apps/worker/src/index.ts`) — needs the full source tree and dependencies |
| Container | `Dockerfile` targets: `web` (standalone server, non-root uid 10001, `EXPOSE 3000`, `HEALTHCHECK` on `/api/v1/health`) and `worker` (full source, `CMD pnpm worker`; also usable for `pnpm db:migrate`) |
| Local stack | `docker-compose.yml`: `postgres:16` (with `deploy/init-db.sql` creating `eaop_app`), `migrate` (runs `pnpm db:migrate` then `GRANT eaop_runtime TO eaop_app`), `web` (port 3000), `worker`. Requires `APP_SECRET` and `LOCAL_SECRETS_KEY` in the shell; runs with `APP_ENV=development`. Not a production topology |

Worker loop (`apps/worker/src/index.ts`): bootstrap, then repeatedly enqueue due schedules (`connectors.health_sweep` every 15 min; `maintenance.retention` every 24 h, first after 60 s) with a time-bucket idempotency key so only one replica enqueues each run, `events.bus.dispatchPending(200)`, `jobs.runOnce(workerId, { batch: 20 })`, sleeping 1 s when idle and 5 s after an error (reported to `platform_errors`). `SIGTERM`/`SIGINT` stop the loop after the current iteration and close the pool.

## Health checks

| Probe | Endpoint |
|---|---|
| Liveness/readiness (web) | `GET /api/v1/health` → 200 `{"status":"ok"}` / 503 |
| Operator dashboard | `GET /api/v1/admin/health` (session + `observability.read`) |
| Metrics | `GET /api/v1/metrics` (platform admin session) |

The worker has no HTTP endpoint; monitor it through queue age/dead jobs in the admin health report and process supervision.

## Scaling notes

- **Web**: stateless apart from the per-process platform instance; scale horizontally. The **rate limiter is in-memory per instance** — effective limits multiply by the replica count and are not shared, until a shared `RateLimiter` (e.g. Redis-backed) is implemented and passed via `PlatformOverrides.rateLimiter`.
- **Worker**: safe to run several replicas — jobs and outbox rows are claimed with `FOR UPDATE SKIP LOCKED` / conditional status updates; jobs locked for > 15 min are recovered; schedules are deduplicated by idempotency key.
- **Database pool**: `createDatabase` uses `max: 10` connections per process by default; size PostgreSQL `max_connections` for (web + worker replicas) × 10 plus admin headroom.
- **Metrics** are per process; scrape each web instance.
- **AI calls** may run up to 10 minutes; configure proxy/LB timeouts for `POST /api/v1/ai/execute` accordingly.

## Backups and recovery

Rely on the managed database's automated backups and PITR; the platform keeps all state in PostgreSQL (with the `local` secret provider, secrets are in `dev_secret_values` and **only decryptable with the same `LOCAL_SECRETS_KEY`** — back that key up separately). Test restores regularly. The audit log is append-only in the database but backups are your responsibility.

## Secret manager requirement

Production (`APP_ENV=production`) refuses the local secret store unless `ALLOW_LOCAL_SECRETS_IN_PRODUCTION=true`, and the `aws`/`azure`/`vault`/`gcp` providers are stubs. A production deployment therefore needs either an implemented `SecretStore` for your secret manager ([CONNECTORS.md](CONNECTORS.md#secret-managers)) or an explicit, documented acceptance of the local store with `LOCAL_SECRETS_KEY` held in your platform's secret injection.

## Security headers and TLS

Headers come from `securityHeaders()` via `apps/web/next.config.ts` (CSP, `X-Frame-Options: DENY`, `nosniff`, referrer policy, permissions policy, COOP/CORP). With `APP_ENV=production`: HSTS `max-age=63072000; includeSubDomains; preload` and `Secure` cookies. Terminate TLS at the proxy, redirect HTTP to HTTPS, and make the proxy **append** the real client address to `X-Forwarded-For` (the platform uses the last entry for IP allowlists and per-IP rate limits).

## Production checklist

- [ ] `APP_ENV=production`, `APP_URL=https://…` (exact public origin)
- [ ] `APP_SECRET` ≥ 32 random characters, stored in your secret injection, unique per environment
- [ ] Secret store decided: implemented managed provider, or local store with `ALLOW_LOCAL_SECRETS_IN_PRODUCTION=true` and a backed-up `LOCAL_SECRETS_KEY`
- [ ] Runtime DB role `NOSUPERUSER NOBYPASSRLS`, granted `eaop_runtime`, not table owner; migration role separate
- [ ] `pnpm db:migrate` run as a pre-deploy job; `pnpm test` (incl. `tenant-isolation.test.ts`) green in CI for the release
- [ ] First platform admin created with `pnpm platform:admin`; seed never run
- [ ] Worker deployed and supervised (≥ 1 replica)
- [ ] TLS at the edge; proxy appends client IP to `X-Forwarded-For`; LB health check on `/api/v1/health`
- [ ] Rate limiting: accept per-instance limits or add a shared limiter / edge rate limiting
- [ ] `ALLOW_PRIVATE_NETWORK_EGRESS` unset (unless on-prem by design)
- [ ] `ALLOW_SELF_SERVE_SIGNUP` unset unless intended
- [ ] Email relay configured (`EMAIL_WEBHOOK_URL`) if password reset / email notifications are needed
- [ ] AI provider keys configured (or tenants informed to bring their own); model prices reviewed against contracts
- [ ] Database backups/PITR enabled and restore tested
- [ ] Log shipping from stdout/stderr; metrics scraped from each web instance (platform-admin session required)
- [ ] Organization security defaults reviewed (MFA requirement, session timeouts, IP allowlists, retention)
