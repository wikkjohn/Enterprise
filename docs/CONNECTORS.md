# Connectors

Connectors are the **only** path by which platform code (core or modules) calls a tenant's external systems. Code: `packages/connectors/src` (`types.ts`, `catalog.ts`, `service.ts`, `http.ts`, `contract-tests.ts`, `adapters/*.ts`).

## Model

| Concept | Where | Description |
|---|---|---|
| **Definition** (`ConnectorDefinition`) | `catalog.ts` | Code-declared type: auth types, capabilities, config schema/fields, credential fields, default rate limit, optional OAuth endpoints, `urlConfigKeys`, `availability` |
| **Adapter** (`ConnectorAdapter`) | `adapters/*.ts` | Implementation: `testConnection`, `execute`, optional `refreshCredentials` |
| **Instance** | `connectors` table | A tenant's configured connection (non-secret `config`, `auth_type`, status, health, rate-limit override) |
| **Capabilities** | `connector_capabilities` | Which declared capabilities/operations are enabled on the instance |
| **Credentials** | `connector_credentials_metadata` + secret store | Metadata in the DB; the JSON credential values live in the secret store under `secret_ref` |

### Definition contract

| Field | Notes |
|---|---|
| `type` | snake_case, unique (`ConnectorCatalog.register` throws on duplicates) |
| `availability` | `available` (adapter ships), `contract_only` (definition + config only; test/execute → `NOT_IMPLEMENTED`), `sandbox` (simulated) |
| `authTypes` | Subset of `oauth2`, `api_key`, `service_account`, `basic`, `none` |
| `capabilities[]` | `{ key: "ns.verb", description, operations: read\|list\|search\|write\|delete\|execute\|subscribe, scopes?, risk, params? }` |
| `configSchema` / `configFields` | zod schema + UI fields. Config keys that look like secrets (`secret`, `password`, `token`, `api_key`, `private_key` — unless the key also contains `header`, `prefix` or `url`) are rejected |
| `credentialFields` | Per auth type; secret fields are `secret: true` and never echoed |
| `rateLimit.requestsPerMinute` | Default; tenants can override per instance |
| `oauth?` | `{ authorizationUrl, tokenUrl, defaultScopes }`; `{placeholders}` are filled from instance config (e.g. `{tenantId}`) |
| `urlConfigKeys?` | Config keys that must pass the SSRF guard on save |

### Adapter interface

```ts
interface ConnectorAdapter {
  type: string;
  testConnection(ctx: AdapterContext): Promise<{ ok: boolean; message: string; latencyMs?: number; details?: Record<string, unknown> }>;
  execute(ctx: AdapterContext, req: { capability: string; operation: CapabilityOperation; params: Record<string, unknown> }): Promise<unknown>;
  refreshCredentials?(ctx: AdapterContext): Promise<{ values: Record<string, string>; expiresAt?: Date }>;
}
// AdapterContext = { connectorId, organizationId, config, authType, credentials, fetch: GuardedFetch, signal }
```

Adapters must use `ctx.fetch` (the guarded fetch) and throw `ConnectorError` (or use `classifyStatus`).

## Catalog

| Type | Name | Availability | Auth types | Capabilities |
|---|---|---|---|---|
| `rest_api` | REST API | **available** | api_key, basic, oauth2 (client credentials), none | `http.request` (read/write/delete; optional `headers` param — `Authorization`, cookies, host and hop-by-hop headers are dropped, connector auth always wins) |
| `graphql` | GraphQL API | **available** | api_key, none | `graphql.query`, `graphql.mutation` |
| `outbound_webhook` | Outbound Webhook | **available** | api_key (signing secret), none | `webhook.send` |
| `sandbox` | Sandbox (simulated) | sandbox — excluded when `APP_ENV=production` | api_key, none | `records.list`, `records.write`, `simulate.failure` |
| `microsoft_graph` | Microsoft 365 (Graph) — SharePoint, OneDrive, Teams, Outlook, Entra ID | contract_only | oauth2, service_account | `files.read`, `files.permissions.read`, `mail.read`, `mail.send`, `teams.messages.read`, `directory.read` |
| `salesforce` | Salesforce | contract_only | oauth2 | `records.read`, `records.write` |
| `servicenow` | ServiceNow | contract_only | oauth2, basic | `table.read`, `table.write` |
| `sap` | SAP S/4HANA | contract_only | oauth2, basic | `odata.read`, `odata.write` |
| `workday` | Workday | contract_only | oauth2 | `workers.read`, `business_process.read` |
| `jira` | Jira | contract_only | oauth2, api_key | `issues.read`, `issues.write` |
| `confluence` | Confluence | contract_only | oauth2, api_key | `pages.read` |
| `slack` | Slack | contract_only | oauth2 | `messages.read`, `messages.write` |
| `google_workspace` | Google Workspace | contract_only | oauth2, service_account | `drive.read`, `gmail.send`, `directory.read` |
| `box` | Box | contract_only | oauth2 | `files.read` |
| `dropbox` | Dropbox | contract_only | oauth2 | `files.read` |
| `notion` | Notion | contract_only | oauth2, api_key | `pages.read` |
| `oracle` | Oracle Fusion / E-Business | contract_only | oauth2, basic | `resources.read`, `resources.write` |
| `sql_database` | SQL Database | contract_only | basic | `sql.query` |
| `sftp` | SFTP | contract_only | basic, service_account | `files.read`, `files.write` |

**contract_only means not working**: tenants can create and configure these instances (config is saved for when an adapter ships), but `test` and `execute` return `NOT_IMPLEMENTED`, and the health sweep skips them. `GET /api/v1/connectors/catalog` returns every definition with its `availability`.

Available adapter notes:

- **`rest_api`** — config `baseUrl` (SSRF-checked), `healthPath` (default `/`), `apiKeyHeader` (default `Authorization`), `apiKeyPrefix` (default `Bearer `), `tokenUrl`, `oauthScope`. `params.path` must be absolute, without `..` or `//`, and stay on the base URL's origin (`resolveUnder`). The HTTP method must match the operation (`GET`→read, `DELETE`→delete, others→write). Returns `{ status, body }`.
- **`graphql`** — `graphql.query` refuses mutation documents and vice versa; GraphQL `errors` without `data` → permanent error. Test sends `{ __typename }`.
- **`outbound_webhook`** — POSTs `params.payload`; with `api_key` auth, adds `x-eaop-signature: t=<unix>,v1=<HMAC-SHA256(apiKey, "<t>.<body>")>`. Test only validates the URL (SSRF/DNS) with an `OPTIONS` probe.
- **`sandbox`** — returns synthetic records labelled `simulated: true`; `simulate.failure` with `params.kind` = `auth` / `rate_limited` / `permanent` / `transient`.

## Service API (`createConnectorService`)

| Method | Permission | Route |
|---|---|---|
| `catalog()` | (route: `connector.read`) | `GET /api/v1/connectors/catalog` |
| `list(ctx)` | `connector.read` | `GET /api/v1/connectors` |
| `get(ctx, id)` | `connector.read` (resource-scoped) | `GET /api/v1/connectors/:id` |
| `create(ctx, input)` | `connector.manage` | `POST /api/v1/connectors` (idempotent) |
| `update(ctx, id, patch)` | `connector.manage` (resource) | `PATCH /api/v1/connectors/:id` |
| `remove(ctx, id)` | `connector.manage` (resource) | `DELETE /api/v1/connectors/:id` — destroys secrets first |
| `setCredentials(ctx, id, { values, scopes?, expiresAt?, rotationIntervalDays? })` | `connector.credential.manage` (resource) | `PUT /api/v1/connectors/:id/credentials` |
| `rotateCredentials(ctx, id, values)` | `connector.credential.manage` | `POST /api/v1/connectors/:id/credentials/rotate` |
| `revokeCredentials(ctx, id)` | `connector.credential.manage` | `DELETE /api/v1/connectors/:id/credentials` |
| `test(ctx, id)` | `connector.manage` (resource) | `POST /api/v1/connectors/:id/test` (20 / 60 s) |
| `execute(ctx, id, { capability, operation, params }, { moduleId })` | `connector.use` (resource) | `POST /api/v1/connectors/:id/execute` (idempotent) |
| `findByCapability(ctx, capability)` | `connector.read` | — (for modules) |
| `startOAuth(ctx, id)` / `completeOAuth(ctx, { code, state })` | `connector.credential.manage` | `POST /api/v1/connectors/:id/oauth/start`, `GET /api/v1/connectors/oauth/callback` |
| `runHealthSweep()` | system | `connectors.health_sweep` job |

Mutations are audited (`connector.created/updated/deleted/tested`, `connector.credential_set/credential_rotated/credential_revoked`) and publish events (`connector.created/updated/deleted`, `credential.rotated`).

## Credentials and secrets

- `setCredentials` validates required/unknown fields against the definition's `credentialFields[authType]`, writes `JSON.stringify(values)` to the secret store (`secrets.put`), revokes the previous credential row, inserts metadata (`kind`, `secret_ref`, `scopes`, `expires_at`, `rotation_interval_days`, `owner_user_id`, `hint` = last 4 characters of the first secret field), and destroys the previous secret.
- `rotateCredentials` merges new values into the current ones and calls `secrets.rotate` (new version, old version destroyed).
- `revokeCredentials` destroys the secret, marks metadata `revoked`, sets the connector back to `draft`.
- Non-OAuth credentials past `expires_at` raise an `auth` error on use.
- Plaintext credentials never touch the application tables (asserted by "never stores plaintext credentials in the database").

## OAuth 2.0

| Flow | Status |
|---|---|
| **Client credentials** (`rest_api` with `authType: "oauth2"`, config `tokenUrl`, optional `oauthScope`, credentials `clientId`/`clientSecret`) | Implemented in `restApiAdapter.refreshCredentials`. Used when testing a connector without an `accessToken`, and once per `execute` after an `auth` error; the new `accessToken` is stored via `secrets.rotate` |
| **Authorization code** (definitions with `oauth`) | `startOAuth` requires `clientId` already stored, builds `state = base64url({ c: connectorId, o: orgId, n: nonce, e: +10 min }).HMAC(APP_SECRET)` and returns the authorization URL (`redirect_uri = ${APP_URL}/api/v1/connectors/oauth/callback`, scopes = instance scopes or `defaultScopes`). The callback (session route) verifies the HMAC, expiry and that the state's org equals the caller's active org, exchanges the code through the guarded fetch, and stores `accessToken`/`refreshToken`. Audited as `connector.credential_rotated` with `via: "oauth_authorization_code"` |

Limitations: only `contract_only` definitions currently declare `oauth`, so the authorization-code flow can obtain tokens but no shipped adapter can use them yet; the flow sends no PKCE challenge (confidential client with `client_secret`); there is no `refresh_token` grant implementation (OAuth credentials are skipped by the expiring-credential alert on the assumption they refresh automatically).

## Execution pipeline (`execute`)

1. `authorizer.require(ctx, "connector.use", { type: "connector", id })`; validate the request.
2. Load the instance (tenant-scoped; another tenant's id → `NOT_FOUND`); refuse `disabled` (`CONFLICT`); refuse `contract_only` or adapter missing (`NOT_IMPLEMENTED`).
3. Capability must be enabled and the operation declared → else `FORBIDDEN`.
4. **Rate limit**: `rateLimiter.consume("connector:<id>", { limit: instance.rate_limit.requestsPerMinute ?? definition default, windowSeconds: 60 })` → `RATE_LIMITED` with `retryAfterSeconds`.
5. Read credentials from the secret store; 30 s overall timeout (`AbortSignal.timeout`).
6. Up to **3 attempts**: on `auth` error with a refreshable adapter, refresh once and retry; on `transient`/`rate_limited`, wait `min(30, retryAfterSeconds ?? 0.2·2^attempt)` s and retry; other classes stop immediately.
7. Success: `eaop_connector_actions_total{outcome="ok"}`, `eaop_connector_latency_ms`, usage `connector.actions` (dimensions capability/operation, `moduleId` from opts), and an audit record `connector.action_executed` for `write`/`delete`/`execute` operations.
8. Failure: metric with the error class, `connectors.last_error` (redacted), event `connector.failed`, the `ConnectorError` is thrown.

### Error classes (`ConnectorError`)

| `errorClass` | From | `AppError` code | Retryable |
|---|---|---|---|
| `auth` | 401/403 | `UPSTREAM_ERROR` | no (one refresh attempt) |
| `rate_limited` | 429 (`retryAfterSeconds` from `Retry-After`) | `RATE_LIMITED` | yes |
| `transient` | ≥500, 408, network errors, timeouts | `UPSTREAM_ERROR` | yes |
| `permanent` | other 4xx, invalid JSON, > 5 MB body | `UPSTREAM_ERROR` | no |
| `configuration` | bad config/params, SSRF guard rejection | `VALIDATION_FAILED` | no |
| `not_implemented` | — | `NOT_IMPLEMENTED` | no |

`parseRetryAfter` accepts delta-seconds or an HTTP date, defaults to 30 s, caps at 300 s.

### SSRF guard

`createGuardedFetch` wraps every adapter request: `assertSafeOutboundUrl` (HTTPS only, no credentials in URL, DNS-resolved addresses must not be loopback, RFC 1918, link-local/metadata `169.254/16`, CGNAT `100.64/10`, `0/8`, multicast/reserved `≥224`, IPv6 `::1`, `::`, `fc/fd`, `fe80`), `redirect: "manual"` (redirects are never followed), response bodies capped at 5 MB. `ALLOW_PRIVATE_NETWORK_EGRESS=true` disables the private-address check (and, outside production, allows `http:`) for development and on-prem deployments. Config URLs listed in `urlConfigKeys` are checked on save as well.

## Health sweep and expiring credentials

The worker enqueues `connectors.health_sweep` every 15 minutes. `runHealthSweep` re-tests up to 500 connectors in status `connected`/`degraded`/`failed` (skipping `contract_only`), as a system actor. `setHealth` updates `health_status`/`status`/`last_error`, publishes `connector.health_changed` on change, and on a transition to `unhealthy` publishes `connector.failed` and notifies holders of `connector.manage` (`core.connector_failed`).

Credentials expiring within 7 days (non-OAuth, `active`) enqueue `connectors.credential_expiring` (idempotency key per credential per day), which publishes `credential.expiring` and notifies `connector.credential.manage` holders (`core.credential_expiring`).

## Contract tests

`definitionViolations(def, adapter?)` (`contract-tests.ts`) returns violations instead of asserting: snake_case type, ≥1 capability, namespaced capability keys with operations, credential fields for every non-`none` auth type, secret-looking fields marked `secret`, no secret-looking config fields, positive rate limit, `available` ⇒ adapter present, `contract_only` ⇒ no adapter, `adapter.type === def.type`. `tests/unit/connectors.contract.test.ts` runs it over every definition, plus `classifyStatus`, `parseRetryAfter` and `resolveUnder` cases.

## Adding an adapter

1. Implement `ConnectorAdapter` (use `ctx.fetch`, `classifyStatus(res.status, res.headers.get("retry-after"))`, throw `ConnectorError`, test errors with `isConnectorError()` rather than `instanceof`; never log credentials).
2. Flip the definition to `availability: "available"` (replace `contractOnly({...})` with a full definition: real `configSchema`, `configFields`, `urlConfigKeys`, `rateLimit`).
3. Register the adapter: add it to the `adapters` list in `createPlatform` (`packages/platform/src/platform.ts`), or pass `extraConnectorAdapters` via `PlatformOverrides`; module-provided definitions are registered with `platform.connectorCatalog.register(def)`.
4. Add it to the adapter map in `tests/unit/connectors.contract.test.ts` and write integration tests with a stubbed `fetchImpl` (see `tests/integration/connectors.test.ts`).

## Secret managers

`SECRETS_PROVIDER` selects the store (`packages/secrets/src/index.ts`):

| Provider | Status |
|---|---|
| `local` | Implemented: AES-256-GCM, 32-byte `LOCAL_SECRETS_KEY`, ciphertext in `dev_secret_values`, AAD = the reference string, rotation destroys the old version. Refuses `APP_ENV=production` unless `ALLOW_LOCAL_SECRETS_IN_PRODUCTION=true` |
| `aws` (Secrets Manager / KMS) | Stub: every call throws `NOT_CONFIGURED` |
| `azure` (Key Vault) | Stub |
| `vault` (HashiCorp Vault) | Stub |
| `gcp` (Secret Manager) | Stub |

Implementing a provider means writing a class implementing `SecretStore` (`put`, `get`, `rotate`, `destroy`) that:
- issues references in the existing format `secret://<provider>/<orgId|platform>/<id>#v<n>` (see `parseSecretRef`);
- enforces tenant binding — refuse when the reference's owner segment does not match the caller's `organizationId` (or `platform` for `null`);
- creates a new version on `rotate` and destroys old versions; destroys all versions on `destroy`;
- takes its credentials from the deployment's workload identity (IAM role, managed identity, Vault auth method) rather than static keys;
- is wired into `createSecretStore` in place of `UnconfiguredSecretStore`, with the provider SDK added as a dependency of `packages/secrets`.

Existing `local` references cannot be resolved by another provider; migrating providers requires re-entering or re-encrypting secrets.

## Integrations that require credentials

| Integration | What is needed | Where |
|---|---|---|
| Any `rest_api` / `graphql` target | Base URL + API key / basic / OAuth client credentials | Connector credentials |
| Outbound webhook connector | Endpoint URL, optional signing secret | Connector credentials |
| Tenant webhooks (event delivery) | Endpoint URL; signing secret is generated | `POST /api/v1/webhooks` |
| OAuth authorization-code connectors | OAuth app registration with redirect URI `${APP_URL}/api/v1/connectors/oauth/callback`, client id/secret | Connector credentials (adapters not yet implemented) |
| AI providers | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` or tenant BYO keys | [AI-PROVIDERS.md](AI-PROVIDERS.md) |
| OIDC SSO | IdP application, client id/secret | [AUTHENTICATION.md](AUTHENTICATION.md#sso--oidc-implemented-not-yet-tested-against-a-real-idp) |
| Email | An HTTPS relay you operate (`EMAIL_WEBHOOK_URL`) | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Managed secret manager | Provider implementation + cloud identity | Above |
