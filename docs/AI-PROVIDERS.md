# AI Provider Layer

All model calls — from the core or any module — go through `platform.ai.execute(ctx, input)`. Code: `packages/ai/src` (`types.ts`, `catalog.ts`, `router.ts`, `service.ts`, `providers/*.ts`). Only files under `packages/ai/src/providers/` may import provider SDKs (`openai`, `@anthropic-ai/sdk`); ESLint `no-restricted-imports` enforces this everywhere else.

## `AIProvider` interface

```ts
interface AIProvider {
  kind: ProviderKind;   // "anthropic" | "openai" | "openai_compatible" | "azure_openai" | "google" | "bedrock" | "local" | "sandbox"
  generate(req: AIGenerateRequest, runtime: { apiKey?: string; config: Record<string, unknown> }, signal: AbortSignal): Promise<AIGenerateResponse>;
}
// AIGenerateRequest  = { model, system?, messages: {role: "user"|"assistant", content}[], maxTokens, effort?, responseFormat?: "text"|"json", temperature? }
// AIGenerateResponse = { text, servedModel, finishReason: "stop"|"length"|"refusal"|"other", usage: { inputTokens, outputTokens }, refusalCategory? }
```

Registered adapters (`createPlatform`): `anthropicProvider`; `createOpenAICompatibleProvider` for `openai`, `openai_compatible`, `azure_openai`, `local`; `sandboxProvider` outside production.

| Kind | Status |
|---|---|
| `anthropic` | Implemented with the official `@anthropic-ai/sdk` |
| `openai`, `openai_compatible`, `azure_openai`, `local` (vLLM, Ollama, other Chat Completions servers) | Implemented via Chat Completions over `fetch` |
| `google`, `bedrock` | Configuration accepted, **not implemented** (`UNIMPLEMENTED_PROVIDER_KINDS`); never routed; `implemented: false` in listings |
| `sandbox` | Simulated (`[SIMULATED] <echo>`), development/test only; excluded from catalog sync, listings and routing when `APP_ENV=production` |

## Platform catalog and model registry

`PLATFORM_AI_CATALOG` (`packages/ai/src/catalog.ts`) is seeded by `ai.syncCatalog()` at bootstrap into `ai_providers` / `ai_models` with `organization_id NULL`:

| Provider key | Kind | Credential env | Models |
|---|---|---|---|
| `anthropic` | anthropic | `ANTHROPIC_API_KEY` | see below; provider config `{ refusalFallback: "default" }` |
| `openai` | openai | `OPENAI_API_KEY` | **none pre-seeded**; config `{ baseUrl: "https://api.openai.com/v1" }` |
| `sandbox` | sandbox | — | `sandbox-echo` (economy, approved up to `restricted`, cost 0) — non-production only |

| Model key | Display | Tier | Input / output USD per MTok | Context | Max output | Max data classification | Capabilities |
|---|---|---|---|---|---|---|---|
| `claude-opus-5-5` | Claude Opus 5.5 | premium | 4 / 20 | 1,000,000 | 128,000 | confidential | text, reasoning, json, long_context, vision, tools |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | standard | 2 / 10 | 1,000,000 | 128,000 | confidential | text, reasoning, json, long_context, vision, tools |
| `claude-haiku-4-5` | Claude Haiku 4.5 | economy | 1 / 5 | 200,000 | 64,000 | internal | text, json, vision, tools |

Prices are list-price **estimates** (code comment: "as of 2026-09"); override them per contract. Platform rows are inserted with `ON CONFLICT DO NOTHING`, so edited prices are not overwritten on restart.

Provider `status` at sync: `enabled` when its credential env var is set (or kind `sandbox`), `not_configured` otherwise; a provider previously set to `disabled` stays disabled. Existing `config` values in the DB win over catalog defaults.

## Configuring providers

| Scope | How | Credential |
|---|---|---|
| Platform | Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and restart (bootstrap). For OpenAI also add models (no API for platform-owned models; insert into `ai_models` with `organization_id NULL`) | Read from env at call time |
| Tenant BYO | `POST /api/v1/ai/providers { key, name, kind, config, apiKey? }` (`ai.provider.manage`) — upsert by `(organization_id, key)` | `apiKey` stored in the secret store; `credential_secret_ref` on the row |
| Tenant models | `POST /api/v1/ai/providers/:id/models { modelKey, displayName, capabilities, contextWindow?, maxOutputTokens?, inputCostPerMtok, outputCostPerMtok, tier, maxDataClassification }` | — |
| Toggle | `PATCH /api/v1/ai/providers/:id { status }`, `PATCH /api/v1/ai/models/:id { status }` — organization-owned rows only | — |

`config` must not contain keys matching `key|secret|token|password` (`VALIDATION_FAILED` "Put credentials in apiKey, not config."). Useful config keys: `baseUrl` (all kinds; required for OpenAI-compatible kinds), `apiVersion` (Azure, default `2024-10-21`), `refusalFallback: "off"` (Anthropic). A BYO provider is `enabled` when an `apiKey` was given or kind is `local`. Changes are audited (`ai.provider_changed`, `ai.model_changed`). `GET /api/v1/ai/providers` (`ai.provider.read`) shows platform + own providers with `scope`, `implemented`, `hasCredential` (never the key) and models.

## Routing

`rankModels(models, requirements)` (`packages/ai/src/router.ts`) is deterministic:

1. **Filter**: explicit `model` / `provider` if given; `maxDataClassification` rank ≥ requested `dataClassification` (`public < internal < confidential < restricted`); all requested `capabilities` present; estimated input tokens (characters / 4) ≤ `contextWindow`. Excluded models are returned with reasons.
2. **Rank**: (a) tier distance — the requested tier, then higher tiers, lower tiers last; (b) tenant-owned before platform; (c) lowest `input + output` price; (d) model key.

Candidates are enabled providers with active models visible to the tenant (platform + own), minus unimplemented kinds (and sandbox in production). After ranking, every registered **routing policy** runs in registration order and may filter or reorder:

```ts
platform.ai.registerRoutingPolicy("ai_ops.cost_caps", (candidates, req) =>
  req.useCase.startsWith("bulk.") ? candidates.filter((m) => m.tier !== "premium") : candidates);
```

(This is the extension point intended for AI Operations Management.) If nothing remains: `NOT_CONFIGURED` "No enabled AI model satisfies this request." with `details.excluded` and a hint.

## `execute()` pipeline

Input schema `aiExecuteSchema`:

| Field | Notes |
|---|---|
| `moduleId` (required) | Owner of the call: `"core"` or the id of a module **enabled for the tenant**; anything else → `MODULE_NOT_ENABLED` (checked before routing) |
| `useCase` (required) | `^[a-z][a-z0-9_.-]{1,100}$` |
| `system?`, `messages` (1–200) | Content |
| `maxTokens` | 1 – 128,000, default 4,000 |
| `effort?` | `low`, `medium`, `high`, `xhigh`, `max` |
| `responseFormat` | `text` (default) or `json` |
| `dataClassification` | default `internal` |
| `model?`, `provider?`, `tier?`, `capabilities?` | Routing requirements |
| `promptTemplate?` | `{ id, version }` recorded on the run |
| `references?` | Ids for explainability (never content), stored in `metadata.references` |

Steps (`packages/ai/src/service.ts`):

1. `authorizer.require(ctx, "ai.use")` (skipped for system actors).
2. Validate input; reject a `moduleId` other than `"core"` that is not an enabled module (`MODULE_NOT_ENABLED`); rate limit `ai:<org>:<actor>` with `RATE_LIMITS.ai` (60 / 60 s) — the HTTP route applies the same rule again under its own key.
3. Read the org's `aiPromptRetention`.
4. Route (above).
5. **Policy**: `policies.evaluateKind(ctx, "ai_usage", { subject: { type, id }, resource: { type: "ai_model", id: model, attributes: { moduleId, useCase, tier, provider, model } }, action: "ai.generate", context: { dataClassification } })`. No active `ai_usage` policy ⇒ `ALLOW`.
6. **Hooks**: if still `ALLOW`, each registered `AIPolicyHook` runs in order. `REDACT` with a `request` replaces the system/messages and continues; any other non-`ALLOW` decision stops.
7. **Blocked**: decision `DENY` → run `blocked`, error `POLICY_DENIED`; `REQUIRE_APPROVAL` or `ESCALATE` → run `pending_approval`, error `APPROVAL_REQUIRED` (HTTP 202 error envelope). Both publish `ai.run.failed`, audit `ai.run_blocked` (`outcome: denied`) and include `runId`, `decision`, `reasons` in `details`. No provider call is made.
8. **Call** the adapter with the credential (secret store ref, or platform env var for platform providers) and provider config; timeout 10 minutes.
9. **Cost** is computed with the price of the model that actually served (`servedModel`, matched within the same provider), falling back to the chosen model's price.
10. **Persist** an `ai_runs` row; record usage `ai.runs`, `ai.input_tokens`, `ai.output_tokens`, `ai.cost` (dedupe keys `<runId>:runs|in|out|cost`, `aiModel = servedModel`); metrics `eaop_ai_runs_total`, `eaop_ai_latency_ms`.
11. **Refusal** (`finishReason: "refusal"`): run `blocked` with `errorCode: "PROVIDER_REFUSAL"` and the category in `errorMessage`; publish `ai.run.failed`; throw `POLICY_DENIED` "The AI provider declined this request." with `{ runId, category }`.
12. **Success**: publish `ai.run.completed`; return `{ runId, text, provider, model, servedModel, finishReason, usage, estimatedCostUsd, latencyMs, policy: { decision, reasons } }`.
13. **Provider error**: run `failed` with the error code and a redacted message (≤ 500 chars); publish `ai.run.failed`; rethrow the `AppError` with `runId` added (non-`AppError`s become `UPSTREAM_ERROR`).

HTTP: `POST /api/v1/ai/execute` (`auth: "any"`, `ai.use`, status 200).

### Policy hooks (DLP extension)

```ts
platform.ai.registerPolicyHook("data_security.dlp", async ({ organizationId, actor, moduleId, useCase, dataClassification, model, request }) => {
  const masked = request.messages.map((m) => ({ ...m, content: m.content.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]") }));
  return { decision: "REDACT", reasons: ["masked SSN"], request: { ...request, messages: masked } };
  // or { decision: "DENY" | "REQUIRE_APPROVAL" | "ESCALATE" | "ALLOW", reasons }
});
```

Hook names must be unique. Reasons are prefixed with `[<hook name>]` in the run record. `actor` is the caller (`{ type, id, label }`). A hook that returns `DENY` / `REQUIRE_APPROVAL` / `ESCALATE` may also return a sanitized `request`; it is what the run log persists (under `full` retention) instead of the original, so a blocked prompt's secrets are never stored. AI Data Security registers the `data_security` hook — see [modules/DATA-SECURITY.md](modules/DATA-SECURITY.md).

### `ai_usage` policy kind

Registered by the AI service (owner `core`). Documented attributes: `resource.attributes.moduleId`, `resource.attributes.useCase`, `resource.attributes.tier`, `resource.attributes.provider`, `resource.attributes.model`, `context.dataClassification`. Example (mirrors `tests/integration/ai.test.ts`):

```json
{ "defaultEffect": "ALLOW", "rules": [
  { "id": "deny-restricted", "effect": "DENY", "when": { "field": "context.dataClassification", "op": "eq", "value": "restricted" } },
  { "id": "approve-premium", "effect": "REQUIRE_APPROVAL", "when": { "field": "resource.attributes.tier", "op": "eq", "value": "premium" } }
] }
```

Create with `POST /api/v1/policies { key, name, kind: "ai_usage", definition }`, then `POST /api/v1/policies/:key/activate { version: 1 }`. There is no approval workflow yet: `pending_approval` runs are recorded but nothing resumes them.

## Run logging and retention

`ai_runs` stores provider, chosen `model_key`, module, use case, actor, status (`succeeded`/`failed`/`blocked`/`pending_approval`), tokens, latency, cost, retention mode, template id/version, `prompt_hash` (SHA-256 of the final request JSON), `prompt_chars`, `response_chars`, policy decision/reasons, error code/message, correlation id and `metadata` (`references`, `dataClassification`, `routingExcluded`, `servedModel`, `finishReason`).

| `aiPromptRetention` | Stored |
|---|---|
| `full` | Everything above plus `request` (system + messages after redaction hooks) and `response` (`{ text, finishReason }`) |
| `metadata` (default) | No request/response content; hash and sizes stored |
| `none` | No content and no derivatives: `prompt_hash`, `prompt_chars`, `response_chars`, `request`, `response` are all NULL |

Runs are deleted after `aiRunDays` by the retention job. Read with `GET /api/v1/ai/runs?moduleId=&status=&limit=&cursor=` and `GET /api/v1/ai/runs/:id` (`ai.run.read`).

## Usage, cost and limits

Usage rows are tenant-scoped in `usage_events`; summarize with `GET /api/v1/usage/summary?from=&to=&groupBy=ai_model` etc. Organization limits (`PATCH /api/v1/organization/settings/usage-limits { monthlyAiCostUsd?, monthlyAiTokens? }`) **alert, they do not block**: when month-to-date `ai.cost` or `ai.input_tokens` reaches the limit, one `usage.threshold.exceeded` event per org/metric/month is published and `usage.read` holders receive `core.usage_threshold`. (`monthlyAiTokens` is compared against input tokens only.)

## Anthropic adapter specifics (`packages/ai/src/providers/anthropic.ts`)

- Uses `client.beta.messages.create` from `@anthropic-ai/sdk`; clients cached per `(baseURL, apiKey)` with `maxRetries: 2`, `timeout: 10 min`. Optional provider config `baseUrl`.
- **No sampling parameters and no `thinking` field are ever sent** — Claude Opus 5.5 and Sonnet 5.5 reject sampling parameters and disabled thinking; `temperature` on the request is ignored by this adapter.
- **Effort**: for models matching `^claude-(fable|mythos|opus|sonnet)-(5|4-[678])` the adapter always sends `output_config: { effort }`, defaulting to `"medium"` when the caller passes none (Opus 5.5's own default is `medium`; note Sonnet 5.5's API default is `high`, so callers wanting `high` must ask for it). `claude-haiku-4-5` gets no effort parameter.
- **Refusal fallback**: on `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-opus-5`, `claude-fable-5-1` the adapter sends `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"` unless provider config has `refusalFallback: "off"`. This is the Claude API's server-side form; if `baseUrl` points at a gateway that does not support it, turn it off.
- `responseFormat: "json"` appends "Respond with a single valid JSON object and nothing else." to the system prompt.
- Text = concatenation of `text` blocks. `stop_reason: "refusal"` → `finishReason: "refusal"`, empty text, `refusalCategory = stop_details.category`; `end_turn`/`stop_sequence` → `stop`; `max_tokens` → `length`.
- `servedModel = response.model`, so cost and usage are attributed to the model that answered after a fallback.
- Error mapping: `RateLimitError` → `RATE_LIMITED` (retryable); `AuthenticationError`/`PermissionDeniedError` → `NOT_CONFIGURED`; `BadRequestError` → `VALIDATION_FAILED`; `APIConnectionTimeoutError` → `UPSTREAM_TIMEOUT`; other `APIError` → `UPSTREAM_ERROR` (retryable when status ≥ 500). Missing key → `NOT_CONFIGURED`.

## OpenAI-compatible adapter specifics (`providers/openai-compatible.ts`)

- URL: `<baseUrl>/chat/completions`; Azure: `<baseUrl>/openai/deployments/<model>/chat/completions?api-version=<apiVersion>` with header `api-key` (model omitted from the body). Others use `Authorization: Bearer`.
- Body: `messages` (system first), `max_completion_tokens`, `temperature` only if supplied, `response_format: { type: "json_object" }` for JSON.
- SSRF guard on the URL; `local` allows `http:` and private networks; other kinds allow private networks only with `ALLOW_PRIVATE_NETWORK_EGRESS=true`. Redirects not followed.
- Refusal: `message.refusal` or `finish_reason: "content_filter"`. Errors: 429 → `RATE_LIMITED`, 401/403 → `NOT_CONFIGURED`, ≥ 500 → `UPSTREAM_ERROR`, other 4xx → `VALIDATION_FAILED`, network/timeout → `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT`.
- Effort is ignored.
