# Observability

Code: `packages/observability/src`, `packages/platform/src/{errors,health}.ts`, `packages/usage/src/index.ts`.

## Structured logs

`createLogger` writes one JSON object per line: `info`/`debug` to stdout, `warn`/`error` to stderr. Every line has `ts`, `level`, `msg`, logger bindings (`service: "eaop"`; the worker adds `component: "worker"`, `workerId`), and — when inside a correlation scope — `correlationId`, `organizationId`, `actorId`. Extra fields are passed through `redact()`. Level from `LOG_LEVEL` (`debug`/`info`/`warn`/`error`, default `info`). Use `logger.child({...})` for component bindings. `console.log` is a lint error outside `scripts/` and the worker.

Notable messages: `http.request` (method, path, status, durationMs, organizationId — one per API call), `job.failed`, `event.subscriber_failed`, `webhook.delivery_error`, `connector.execute_failed`, `connector.health_check_error`, `ai.run_failed`, `search.provider_failed`, `error.reported`, `error.persist_failed`, `db.after_commit_failed`, `audit.record_detached_failed`, `auth.password_reset_email_not_configured`, `email.not_configured`, `worker.started`, `worker.stopping`, `retention.done`.

## Correlation ids

`route()` takes `x-request-id` from the request when it matches `^[A-Za-z0-9._:-]{8,128}$`, otherwise generates a UUID, runs the request inside `runWithCorrelation`, and returns it as the `x-request-id` response header and as `error.requestId` in error envelopes. The same id is stored as `correlation_id` on audit events, AI runs, outbox events, jobs (when passed) and `platform_errors`. Server Components (`getViewer`) generate a fresh id per render.

## Metrics

In-process registry (`createMetrics()`), one per process. Emitted names:

| Metric | Type | Labels | Source |
|---|---|---|---|
| `eaop_http_requests_total` | counter | `method`, `status` | `packages/api/src/route.ts` |
| `eaop_http_request_duration_ms` | histogram | `method` | same |
| `eaop_jobs_total` | counter | `type`, `outcome` (`succeeded`/`failed`/`dead`) | `packages/jobs` |
| `eaop_job_duration_ms` | histogram | `type` | same |
| `eaop_events_published_total` | counter | `type` | `packages/events/src/bus.ts` |
| `eaop_event_deliveries_total` | counter | `type`, `outcome` (`ok`/`error`) | same |
| `eaop_connector_actions_total` | counter | `type`, `outcome` (`ok` or error class) | `packages/connectors/src/service.ts` |
| `eaop_connector_latency_ms` | histogram | `type` | same |
| `eaop_ai_runs_total` | counter | `provider`, `model`, `outcome` (`ok`/`refused`/`error`) | `packages/ai/src/service.ts` |
| `eaop_ai_latency_ms` | histogram | `provider` | same |
| `eaop_span_duration_ms` | histogram | `span`, `outcome` | `Tracer.span` (no call sites yet) |

Histogram buckets (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000.

**Exposition**: `GET /api/v1/metrics` returns Prometheus text (`text/plain; version=0.0.4`). It requires a session with an active organization **and** `users.is_platform_admin`; anyone else gets `FORBIDDEN`. Only the web process exposes metrics; the worker's registry (jobs, events, connector sweeps) is not exported. To integrate with an OpenTelemetry MeterProvider, implement the `Metrics` interface — call sites do not change.

## Tracing

`createTracer({ logger, metrics })` provides `tracer.span(name, async (span) => ..., attributes)` with `traceId`, `spanId`, `setAttribute`, `recordError`; it records `eaop_span_duration_ms` and a debug log line. The interface mirrors OpenTelemetry's `startActiveSpan` so an OTel tracer can be dropped in behind `Tracer`. It is available as `platform.tracer`, but no core code creates spans yet.

## Error reporting

`platform.errors.report(err, { source, severity, organizationId, correlationId, extra })` (`packages/platform/src/errors.ts`):

1. Logs `error.reported` with the code (`AppError.code` or error name), redacted message (≤ 2000 chars) and the first 8 stack lines.
2. Calls optional `ErrorSink`s (Sentry/Datadog adapters can be passed to `createErrorReporter`; `createPlatform` passes none). A throwing sink is ignored.
3. Inserts a row in `platform_errors` (system scope). Persist failures are logged, never thrown.

Called by `route()` for unexpected (non-`AppError`, non-zod) errors and by the worker loop. `platform_errors` older than 30 days are purged by retention.

## Health endpoints

| Endpoint | Audience | Content |
|---|---|---|
| `GET /api/v1/health` | Load balancers (public; 600 req/min per IP) | `{"status":"ok"}` 200 when `select 1` succeeds, else `{"status":"unavailable"}` 503. No details |
| `GET /api/v1/admin/health` | Session with `observability.read` | `HealthReport` (below) |

`HealthReport` (`packages/platform/src/health.ts`):

| Field | Tenant admin sees | Platform admin (also holding `observability.read`) sees |
|---|---|---|
| `services` | `database` (state + latency), `job_queue`, `event_bus` | same |
| `queue` | `null` (`job_queue` state `unknown`) | job counts by status + oldest queued age; `degraded` if any `dead` job or oldest > 600 s |
| `failedJobs` | Own org's 15 most recent `failed`/`dead` jobs | All orgs |
| `connectors` | Own org: total, counts by health, up to 20 failing | same (scoped to active org) |
| `aiProviders` | Platform providers: key, kind, status, implemented | same |
| `modules` | `modules.health()` per module (placeholders: `not_configured`) | same |
| `recentErrors` | Own org's `error`/`critical` rows from the last 7 days (25) | All orgs |
| `overall` | `unhealthy` if any service unhealthy; `degraded` if any degraded or any failing connector | same |

`event_bus` is currently always reported `healthy` (no probe). The Docker image's `HEALTHCHECK` calls `/api/v1/health`.

## Events and jobs observability

- `background_jobs_metadata`: `status`, `attempts`, `last_error` (redacted, ≤ 2000 chars), `duration_ms`, `locked_by` (`<hostname>:<pid>`), `correlation_id`. `jobs.stats()`, `jobs.recentFailures()`, `jobs.retryDead(id)` (no HTTP endpoint for retry yet).
- `event_outbox`: `status`, `attempts`, `last_error`, `dispatched_at`.
- Webhooks: `consecutive_failures`, `last_delivery_at`, `last_delivery_status` returned by `GET /api/v1/webhooks`.
- Connectors: `health_status`, `last_health_check_at`, `last_error`.

## Usage metering

`platform.usage.record(ctx, record | record[])` inserts tenant-scoped rows into `usage_events` (`ON CONFLICT DO NOTHING` on `(organization_id, dedupe_key)`) and then checks monthly thresholds.

| `USAGE_METRICS` key | Metric | Unit | Recorded by |
|---|---|---|---|
| `API_REQUESTS` | `api.requests` | request | `route()` for API-key requests (`endpoint` = `METHOD /path` with UUIDs replaced by `:id`) |
| `AI_RUNS` | `ai.runs` | run | AI service |
| `AI_INPUT_TOKENS` | `ai.input_tokens` | token | AI service |
| `AI_OUTPUT_TOKENS` | `ai.output_tokens` | token | AI service |
| `AI_COST` | `ai.cost` | usd | AI service (estimated) |
| `CONNECTOR_ACTIONS` | `connector.actions` | action | Connector service |
| `STORAGE` | `storage.bytes` | byte | Reserved |
| `JOBS` | `jobs.executed` | job | Reserved |
| `EXECUTIONS` | `executions` | execution | Reserved |

Dimensions columns: `module_id`, `user_id`, `connector_id`, `agent_id`, `ai_provider`, `ai_model`, `workflow_id`, `endpoint`, plus free-form `dimensions` jsonb. Modules may record additional namespaced metrics (e.g. `workflow.analyses`).

`GET /api/v1/usage/summary?from=<date>&to=<date>&groupBy=<g>&metric=&moduleId=` (`usage.read`) sums quantities in `[from, to)`, grouped by `metric` (default), `module`, `day`, `ai_provider`, `ai_model`, `user`, `connector`, `agent`, `workflow` or `endpoint`. Thresholds from `organization_settings.usage_limits` raise `usage.threshold.exceeded` (see [AI-PROVIDERS.md](AI-PROVIDERS.md#usage-cost-and-limits)).
