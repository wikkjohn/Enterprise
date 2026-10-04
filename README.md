# Enterprise AI Operating Platform

A multi-tenant **shared enterprise core** (identity, organizations, RBAC, audit, connectors, AI provider layer, policies, events/jobs, notifications, usage, search, observability) plus **six modular applications** that plug into it through a declarative manifest. The six modules are reserved placeholders today (`installStatus: "not_installed"`); the shared core and its HTTP API are implemented and tested.

This directory is a self-contained pnpm monorepo. It lives under `platform/` inside an unrelated repository (the static "Licensed Business Exchange" site at the repo root) and shares nothing with it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#repository-assessment).

---

## Architecture at a glance

```
                ┌──────────────────────────────────────────────────────────────┐
 Browser ──────▶│ apps/web  (Next.js 15 App Router, one deployable)            │
 API client ───▶│   UI pages (in progress)   +   /api/v1/** route handlers     │
 (Bearer key)   │                               └─ packages/api route() wrapper │
                └───────────────┬──────────────────────────────────────────────┘
                                │ createPlatform(env)  — composition root
                                ▼                       (packages/platform)
 ┌───────────────────────────── shared core services ────────────────────────────┐
 │ auth · organizations · rbac · module-registry · connectors · ai · policies    │
 │ audit · events(+webhooks) · jobs · notifications · usage · search · secrets   │
 │ security · observability · shared-types                                        │
 └───────────────┬───────────────────────────────────────────────┬───────────────┘
                 │ db.withTenant / withUser / withSystem          │ module manifests
                 ▼ (transaction-local RLS GUCs)                   ▼ (modules/*)
        ┌──────────────────────┐                        workflow-intelligence,
        │ PostgreSQL 16        │◀── apps/worker          integration-hub, agent-governance,
        │ RLS on every tenant  │    (jobs, event outbox, data-security, knowledge-verification,
        │ table; append-only   │     health sweep,       ai-operations  (placeholders)
        │ audit; job queue;    │     retention)
        │ event outbox         │
        └──────────────────────┘
 Optional outbound: AI providers (Anthropic, OpenAI-compatible), tenant connectors,
 tenant webhooks, email relay (EMAIL_WEBHOOK_URL). No Redis is required.
```

## Quickstart (local development)

Prerequisites: **Node 22** (`.nvmrc`), **pnpm 10** (`packageManager: pnpm@10.28.0`), **PostgreSQL 16**. Redis is not used.

### 1. Database roles and databases

Run as a PostgreSQL superuser (e.g. `psql -U postgres`):

```sql
-- Owner/migration role (DDL). Superuser is simplest for local dev.
CREATE ROLE eaop LOGIN SUPERUSER PASSWORD 'eaop';
-- Runtime role: MUST NOT be superuser and MUST NOT bypass RLS.
CREATE ROLE eaop_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'eaop_app';
CREATE DATABASE eaop_dev  OWNER eaop;
CREATE DATABASE eaop_test OWNER eaop;
```

### 2. Environment

```bash
cp .env.example .env
# Generate the two secrets and paste them into .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # LOCAL_SECRETS_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # APP_SECRET (>= 32 chars)
```

`APP_SECRET` is **required** by `packages/platform/src/config.ts` but is not listed in `.env.example` — add the line `APP_SECRET=<value>` yourself.

Nothing in the repo loads `.env` automatically (scripts read `process.env`). Export it into your shell before running commands:

```bash
set -a; . ./.env; set +a
```

### 3. Install, migrate, grant, seed, run

```bash
pnpm install
pnpm db:migrate                                   # uses DATABASE_ADMIN_URL; creates role eaop_runtime
psql postgres://eaop:eaop@localhost:5432/eaop_dev -c "GRANT eaop_runtime TO eaop_app;"
pnpm db:seed                                      # platform admin + "Sandbox Organization"
pnpm dev                                          # http://localhost:3000
pnpm worker                                       # second terminal: jobs, outbox, sweeps, retention
```

The seed creates `admin@example.com` / `change-me-on-first-login` (override with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) and refuses to run when `APP_ENV=production`.

### 4. Quality gates

```bash
pnpm typecheck   # tsc over packages/modules/worker/tests/scripts + apps/web
pnpm lint        # eslint (includes architectural import guardrails)
pnpm test        # vitest: unit + integration (integration needs eaop_test, see docs/TESTING.md)
pnpm check       # all three
```

Alternative: `docker compose up --build` (requires `APP_SECRET` and `LOCAL_SECRETS_KEY` in the environment) runs Postgres, migrations, web and worker. It is a local stack, not a production topology — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repository layout

| Path | Contents |
|---|---|
| `apps/web` | Next.js 15 app: `/api/v1/**` route handlers (`src/app/api/v1`), server helpers (`src/lib/*.ts`), UI (being built) |
| `apps/worker` | Background worker loop (`src/index.ts`) |
| `packages/shared-types` | Error model, contexts/actors, pagination, module ids, policy effects |
| `packages/observability` | JSON logger, correlation ids, metrics, span helper, redaction |
| `packages/db` | Drizzle schema, RLS-scoped client, migration runner, SQL migrations |
| `packages/security` | Password hashing, TOTP, CSRF, headers/CSP, rate limiter, SSRF guard, CIDR |
| `packages/secrets` | Secret store (local AES-256-GCM; fail-closed stubs for AWS/Azure/Vault/GCP) |
| `packages/audit` | Append-only audit service |
| `packages/jobs` | PostgreSQL job queue (`FOR UPDATE SKIP LOCKED`) |
| `packages/events` | Event contracts, transactional-outbox bus, outbound webhooks |
| `packages/rbac` | Permission registry, system roles, authorizer, role service |
| `packages/organizations` | Tenants, settings, domains, members, invitations |
| `packages/auth` | Sessions, password/MFA auth, API keys, SSO (OIDC) |
| `packages/module-registry` | Module manifest contract, entitlements, navigation, feature flags |
| `packages/connectors` | Connector framework, catalog, adapters |
| `packages/ai` | AI provider layer, model routing, run logging |
| `packages/policies` | Policy engine + versioned policy service |
| `packages/notifications` | In-app/email notifications, types, preferences |
| `packages/usage` | Usage metering and summaries |
| `packages/search` | Federated search over registered providers |
| `packages/platform` | `createPlatform()` composition root, env config, health, error reporter, retention |
| `packages/api` | Framework-agnostic HTTP kit: `createRouteFactory()` / envelopes |
| `packages/design-system` | Tailwind v4 tokens + accessible React components (being built) |
| `modules/*` | Six placeholder module manifests |
| `tests/` | `unit/`, `integration/`, `helpers/` |
| `scripts/` | `seed.ts`, `create-platform-admin.ts` |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | Container build and local compose stack |

## Implementation status

| Area | Status | Notes |
|---|---|---|
| Multi-tenancy (RLS on all tenant tables) | Implemented | Release-blocker test: `tests/integration/tenant-isolation.test.ts` |
| Password auth, sessions, lockout, CSRF | Implemented | |
| MFA (TOTP) | Implemented | No recovery codes yet |
| Invitations, org switching, API keys | Implemented | Invitation email is not sent; the API returns `acceptUrl` |
| Password reset | Implemented | Email is only sent when `EMAIL_WEBHOOK_URL` is configured |
| SSO — OIDC | Implemented, **untested against a real IdP** | Auth code + PKCE, JWKS, JIT |
| SSO — SAML | Configuration stored only | Sign-in returns `NOT_IMPLEMENTED` |
| SCIM | Not implemented | Intended contract in [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md#scim-not-implemented) |
| RBAC, scoped grants, SoD, anti-escalation | Implemented | |
| Audit log (append-only, export) | Implemented | |
| Event bus, webhooks, job queue | Implemented | |
| Connectors: `rest_api`, `graphql`, `outbound_webhook` | Implemented | `sandbox` simulated, non-production only |
| Connectors: Microsoft 365, Salesforce, ServiceNow, SAP, Workday, Jira, Confluence, Slack, Google Workspace, Box, Dropbox, Notion, Oracle, SQL, SFTP | `contract_only` | Configurable; test/execute return `NOT_IMPLEMENTED` |
| AI: Anthropic (official SDK) | Implemented | Requires `ANTHROPIC_API_KEY` or tenant BYO key |
| AI: OpenAI / OpenAI-compatible / Azure OpenAI / local | Implemented (Chat Completions) | No OpenAI models pre-seeded |
| AI: Google, Bedrock | Configuration only | Never routed |
| Secret managers AWS / Azure / Vault / GCP | Fail-closed stubs | Only `local` works; production needs an implementation |
| Redis-backed rate limiter | Not implemented | In-memory limiter is per instance; `REDIS_URL` is parsed but unused |
| Email | Requires credentials | Webhook relay you operate (`EMAIL_WEBHOOK_URL`) |
| Web UI pages | In progress | Being built concurrently (uncommitted at time of writing): `(auth)` routes (`/login`, `/mfa`, `/mfa/enroll`, `/invite/[token]`, `/forgot-password`, `/reset-password`) and `(app)` routes (`/`, `/m/[module]`, `/settings/profile`, `/notifications`, `/help`, `/admin/*`, `/platform`) |
| Six modules | Placeholders | Catalog shows "not installed"; cannot be enabled |

No compliance certification is claimed. See [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| Doc | Topic |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Layers, composition root, request lifecycle, technology choices, repo assessment |
| [SHARED-CORE](docs/SHARED-CORE.md) | Every package: purpose, exports, extension points |
| [MODULE-SYSTEM](docs/MODULE-SYSTEM.md) | Manifest contract, Module Development Contract, adding Workflow Intelligence |
| [DATABASE](docs/DATABASE.md) | Tables, tenancy classes, RLS, migrations, retention |
| [AUTHENTICATION](docs/AUTHENTICATION.md) | Sessions, CSRF, MFA, API keys, SSO, SAML/SCIM status |
| [RBAC](docs/RBAC.md) | Permissions, roles, scoped grants, safeguards |
| [CONNECTORS](docs/CONNECTORS.md) | Connector framework, catalog, OAuth, secret managers |
| [AI-PROVIDERS](docs/AI-PROVIDERS.md) | Provider layer, routing, execute pipeline, Anthropic notes |
| [SECURITY](docs/SECURITY.md) | Threat model, controls, control mapping, known gaps |
| [AUDIT](docs/AUDIT.md) | Audit schema, immutability, actions, export |
| [OBSERVABILITY](docs/OBSERVABILITY.md) | Logs, correlation, metrics, health, usage |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Topology, env reference, production checklist |
| [TESTING](docs/TESTING.md) | Suites, setup, release blocker, module tests |
| [DEVELOPER-GUIDE](docs/DEVELOPER-GUIDE.md) | Conventions, API conventions, recipes, pitfalls |
