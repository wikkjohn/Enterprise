# Enterprise AI Operating Platform

A multi-tenant **shared enterprise core** (identity, organizations, RBAC, audit, connectors, AI provider layer, policies, events/jobs, notifications, usage, search, observability) plus **six modular applications** that plug into it through a declarative manifest. **AI Workflow Intelligence** ([docs/modules/WORKFLOW-INTELLIGENCE.md](docs/modules/WORKFLOW-INTELLIGENCE.md)), **Enterprise AI Integration** ([docs/modules/INTEGRATION.md](docs/modules/INTEGRATION.md)) **AI Agent Governance** ([docs/modules/AGENT-GOVERNANCE.md](docs/modules/AGENT-GOVERNANCE.md)) and **AI Data Security** ([docs/modules/DATA-SECURITY.md](docs/modules/DATA-SECURITY.md)) are installed; the other two modules are reserved placeholders (`installStatus: "not_installed"`). The shared core and its HTTP API are implemented and tested.

This repository is a self-contained pnpm monorepo. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#repository-assessment) for its origin and current status.

---

## Architecture at a glance

```
                ┌──────────────────────────────────────────────────────────────┐
 Browser ──────▶│ apps/web  (Next.js 15 App Router, one deployable)            │
 API client ───▶│   UI pages (App Router)    +   /api/v1/** route handlers     │
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
        │ table; append-only   │     health sweep,       ai-operations  (4 modules installed)
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
# Generate the two secrets and paste them into .env (APP_SECRET=, LOCAL_SECRETS_KEY=)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # APP_SECRET (required, >= 32 chars)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # LOCAL_SECRETS_KEY (32 bytes)
```

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

## Web UI

Next.js App Router pages in `apps/web/src/app`:

| Group | Routes |
|---|---|
| `(auth)` | `/login` (with SSO discovery), `/mfa`, `/mfa/enroll`, `/invite/[token]`, `/forgot-password`, `/reset-password` |
| `(app)` | `/` (overview), `/m/[module]/[[...rest]]` (module pages: "not yet installed" / "not enabled" with an enable action), `/m/workflow-intelligence/…` (dashboard, inventory, workflow detail + process-model editor, opportunities, implementations), `/m/integration-hub/…` (overview, workflow editor, action catalog, approvals, execution history, developers), `/notifications`, `/settings/profile` (password, MFA, sessions), `/help`, `/platform` (platform-admin org provisioning) |
| `(app)/admin` | `/admin`, `/admin/organization`, `/admin/users`, `/admin/roles`, `/admin/modules`, `/admin/connectors`, `/admin/connectors/[id]`, `/admin/ai-providers`, `/admin/ai-runs`, `/admin/policies`, `/admin/policies/[key]`, `/admin/audit`, `/admin/webhooks`, `/admin/security`, `/admin/usage`, `/admin/api-keys`, `/admin/health` |

The shell (`apps/web/src/components/app-shell.tsx`) renders module navigation from `modules.navigation(ctx)` and admin navigation from `apps/web/src/lib/admin-nav.ts` (each entry permission-filtered), plus the organization switcher, ⌘K command palette (backed by `/api/v1/search`), notifications and account menu. Every page re-checks permissions server-side through service calls with `viewer.ctx`.

## Repository layout

| Path | Contents |
|---|---|
| `apps/web` | Next.js 15 app: `/api/v1/**` route handlers (`src/app/api/v1`), server helpers (`src/lib/*.ts`), UI (`src/app/(auth)`, `src/app/(app)`, `src/components`) |
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
| `packages/design-system` | Tailwind v4 tokens + accessible React components |
| `modules/*` | Module packages: `workflow-intelligence` and `integration-hub` (installed), four placeholder manifests |
| `packages/module-catalog` | `MODULE_DEFINITIONS` — the modules apps install |
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
| Redis-backed rate limiter | Not implemented | In-memory limiter is per instance; `REDIS_URL` is reserved (commented in `.env.example`, not read) |
| Email | Requires credentials | Webhook relay you operate (`EMAIL_WEBHOOK_URL`) |
| Web UI | Implemented | Sign-in/MFA/invitation/reset flows, app shell, admin console, platform console — see below |
| AI Workflow Intelligence | Implemented | Enable per org under Administration → Modules; AI redesign needs a real AI provider |
| Enterprise AI Integration | Implemented | Live runs against Salesforce, ServiceNow, SAP, Microsoft 365 etc. need those connector adapters (contract-only today; test mode dry-runs them). REST/GraphQL/webhook connectors work live |
| AI Agent Governance | Implemented | Enforcement is cooperative: agents are governed through the runtime API and Integration's gateway; external OAuth/certificate identities are recorded but not yet used for authentication |
| AI Data Security | Implemented | Discovery adapters: sandbox (simulated) and custom REST APIs; Microsoft 365, Google, Box, Dropbox, Slack, Salesforce etc. push inventory through the ingestion API until their adapters ship. Shadow AI needs a telemetry integration (proxy/CASB/SSO logs) to see employee AI use |
| Other two modules | Placeholders | Catalog shows "not installed"; cannot be enabled |

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
