# Enterprise AI Integration

The controlled execution layer between AI (applications and agents) and enterprise systems. Module id `integration_hub`, route prefix `/m/integration-hub`, package `modules/integration-hub`.

```
AI / USER → INTEGRATION MODULE → VALIDATION → POLICY → APPROVAL IF REQUIRED → SHARED CONNECTOR → ENTERPRISE SYSTEM → RESULT → AUDIT
```

Nothing here talks to an enterprise system directly. Every call goes through `platform.connectors.execute` (shared credentials, SSRF guard, connector rate limits, in-call retries, credential refresh, usage, audit). AI steps go through `platform.ai.execute`. Approvals use the shared policy engine and notifications. Background work uses the shared job queue.

## Enabling it for an organization

1. Deploy: `pnpm db:migrate` applies `modules/integration-hub/migrations/*.sql` (10 `integration_*` tables, RLS forced).
2. Enable it under **Administration → Modules → Enterprise AI Integration** (`module.manage`), or call `POST /api/v1/modules/integration_hub/enable`.
3. Configure shared connectors under **Administration → Connectors** and enable the capabilities you need.
4. In **Integration → Action catalog → Templates**, install actions on those connectors. Admins can also build custom REST actions.
5. Grant roles. The defaults are below. Runs also need the core `connector.use` permission, and AI steps need `ai.use`.

| Role | Grants |
|---|---|
| `org_admin` | everything |
| `ai_admin` | read, create, manage, execute, connector.use, history.read, admin |
| `department_leader` | read, execute, approve, connector.use, history.read |
| `analyst` | read, create, execute, connector.use, history.read |
| `security_admin` | read, history.read, approve |
| `auditor` | read, history.read |
| `standard_user`, `read_only` | read |

6. Optional, in non-production only: **Workflows → Sample workflow** creates a sandbox connector, four sample actions and the customer-quote workflow.

## Permissions

| Key | Allows |
|---|---|
| `integration.read` | Workflows, catalog, transformations, approval requests |
| `integration.create` | Create and edit draft workflows and transformations |
| `integration.manage` | Install catalog actions, publish, pause and archive workflows, retry failed runs, resolve dead letters |
| `integration.execute` | Run workflows and call AI tools |
| `integration.approve` | Decide approvals. Never for your own executions (separation of duties) |
| `integration.connector.use` | Let integration runs use shared connectors |
| `integration.history.read` | Execution history |
| `integration.admin` | Custom action builder and legacy bridges |

## Actions (`integration_actions`)

An action is a business operation on a **shared connector capability**. It carries:

- an input schema (a strict JSON-Schema subset; validated on every call and published as the AI tool schema)
- an optional response schema
- a request template (`{{input.x}}` placeholders → connector params)
- required permissions (must be registered keys)
- a risk level, an approval flag and an idempotency setting (`none` | `auto` | `key_required`)
- a timeout, a rate limit (on top of the connector's own) and a retry policy
- an optional compensating action
- payload capture (history stores redacted summaries unless this is on) and AI exposure

**Templates** (`src/templates.ts`):

| Connector | Actions |
|---|---|
| Salesforce | Get Account, Create Lead, Update Opportunity (approval) |
| ServiceNow | Create Ticket, Update Ticket |
| Microsoft 365 | Read File, Create Draft, Send Email (approval) |
| SAP | Check Inventory |
| Jira | Create Issue |
| Slack | Post Message |
| Sandbox (simulated) | List, Create, Simulate failure |

Installing a template can only make it stricter (higher risk, add approval), never laxer.

**Custom actions** (`integration.admin`) run on a shared `rest_api` connector. You configure the method, the endpoint path, query, body and headers templates, the request and response schemas, the timeout and the rate limit. Authentication always comes from the connector's credential. Headers cannot set `Authorization`, cookies, host or hop-by-hop headers; the shared REST adapter drops them too.

**Legacy bridges.** An action's `bridgeType` is `api_wrapper`, `database`, `sftp`, `rpa` or `ui_automation`, describing the API you operate in front of the legacy system.
- `ui_automation` is always at least high risk, always requires approval, and always captures full payloads.
- `rpa` is at least medium risk.

## Workflow orchestrator

**Node types:**

| Node | What it does |
|---|---|
| Trigger | Starts a run: manual, API (API key) or a platform event |
| Connector action | Runs an installed action |
| AI step | Shared AI layer, JSON output validated against a schema |
| Transform | Field mappings |
| Condition | Evaluated by the **shared policy engine** (same operators as policies) |
| Human approval | Pauses for a decision |
| Delay | Waits, scheduled through the job queue |
| Retry | Sets the retry policy for the next action or AI step |
| Branch | Switches on a value |
| Exception handler | Reached by an error edge; optional compensation and notification |
| Completion | Ends the run with an output template |

**Edge kinds:** `next`, `true`/`false`, `error`, `case` (labelled), `rejected`.

**Rules:**
- A graph must have exactly one trigger and at least one completion.
- Every node must be reachable, and loops are not allowed (use Retry nodes).
- Edge kinds must match their node type.
- Drafts save with issues; publishing requires none.
- Every save creates an immutable version, and live runs use the published version.

**Visual editor** (`/m/integration-hub/workflows/:id`):
- Drag nodes and connect them with typed edges.
- Each node type has its own inspector form, including a mapping editor with preview and a condition builder.
- Validation issues link to the affected nodes.
- Auto-layout, publish, pause or activate, and test runs.

## AI tool gateway

`GET /tools` returns tool definitions (name, description, JSON schema) for actions marked AI-exposed whose required permissions the caller holds. `POST /tools/:name/invoke` checks each of the following before anything runs:

- **Caller:** the authenticated user, API key or agent.
- **Organization:** taken from authentication only.
- **Action:** active and AI-exposed.
- **Parameters:** validated against the schema.
- **Permissions:** `integration.execute`, `integration.connector.use`, the action's required permissions, and `connector.use`.
- **Policy:** the `integration_action` kind.
- **Approval:** applied when required.

It then runs through the same engine as workflows.

**Agent identity:**
- `agent` actors are recorded as verified.
- An `agent` claim from an API-key caller is recorded as **unverified**, alongside the authenticated key.
- Verified agent registration arrives with the Agent Governance module, which will register an actor resolver for `agent` actors.

## Policy and approval

The module registers the policy kind `integration_action`, evaluated before every connector call.

| Attribute | Values |
|---|---|
| `subject.type` | user, api_key, agent or system |
| `subject.attributes.agentId` | the agent's id |
| `resource.id` | action key |
| `resource.attributes.risk` | low, medium, high, critical |
| `resource.attributes.operation` | read, list, search, write, delete, execute |
| `resource.attributes.bridgeType` | native, api_wrapper, database, sftp, rpa, ui_automation |
| `resource.attributes.connectorType` | the shared connector type, e.g. salesforce |
| `context.mode` | live or test |
| `context.trigger` | manual, api, event or gateway |
| `context.input` | the validated input |

- **ALLOW:** the call proceeds.
- **DENY:** the step fails with `policy_denied`.
- **REQUIRE_APPROVAL / ESCALATE:** an approval request is opened. So does an action flagged for approval, or a UI-automation action.

**Approval requests:**
- Show the action, system, affected data, business impact, reason, proposed payload, risk and policy decision.
- Notify `integration.approve` holders.
- Expire on a scheduled job; 72 hours by default, configurable on approval nodes.
- Cannot be approved by the execution's initiator.

The template policy requires approval for critical-risk actions and for writes by agents.

## Reliability

| Concern | Behaviour |
|---|---|
| Error classification | auth, rate_limited, transient, timeout, circuit_open, permanent, configuration, not_implemented, validation, forbidden, policy_denied, approval_rejected, internal. Messages are redacted, and internal errors never leak details |
| Retries | Only rate_limited, transient, timeout and circuit_open. Exponential backoff from the action's or Retry node's policy, never shorter than the upstream Retry-After, capped at one hour. Scheduled through the job queue rather than by sleeping; the connector service also retries transient errors inside a single call |
| Timeouts | Per action (1–120 s) |
| Idempotency | Execution-level: an `Idempotency-Key` header or `idempotencyKey` field is unique per workflow or action, and duplicates return the original run. Step-level: a write that already succeeded in an execution is never sent again, including on job redelivery and retries. Custom actions with idempotency on send `Idempotency-Key: <execution>:<node>` |
| Rate limits | The connector's limit (shared) plus an optional action limit. Limited calls are rescheduled |
| Circuit breaker | Per connector, from `integration_errors`, so it holds across instances. Five transient, timeout or rate-limit failures in five minutes open it, and calls fail fast for 60 s; then a half-open probe is allowed |
| Dead letters | Retryable errors that exhaust their attempts become `dead_letter`. Retry the execution from the failed step, or resolve the error |
| Partial failure | A run that fails after a successful write ends `partially_failed`. A run that recovers through an exception handler also ends `partially_failed` |
| Rollback | **Best effort only.** Exception handlers can run each write's configured compensating action, newest first. Writes without one are reported `not_reversible`. External systems are not transactional, and the platform never claims a rollback |

## Execution history

Each execution records:

- **Run:** trigger, mode, actor and agent, input, output, status.
- **Timing:** duration, start and finish times.
- **Cost:** AI cost.
- **Errors:** error class and message.

Each step records:

- **Inputs and outputs:** redacted unless payload capture is on.
- **Calls:** the system call (connector, capability, operation, redacted request) or the AI call (model, tokens, cost, linked `ai_runs` id).
- **Policy:** the policy decision.
- **Attempts and timing:** attempt number, duration.
- **Errors:** error class and message.

Approvals and errors are linked to the execution. All of this is shown at `/m/integration-hub/executions/:id`.

## Data transformation

A mapping:

1. resolves a source path, a literal or template, or a `compute` operation (add, subtract, multiply, divide, percent; never NaN),
2. applies transforms: trim, lowercase, uppercase, round_2, round_0, abs, split_comma, join_comma, first, count, digits_only,
3. falls back to a default when empty,
4. converts the type (string, number, integer, boolean, date, datetime, json),
5. enforces required fields,
6. writes to a dotted target.

Mappings live inline on transform nodes or in reusable `integration_transformations`. They can be previewed against sample data.

## Developer experience

The `/m/integration-hub/developers` page has:

- authentication guidance
- `curl` examples for the gateway and workflow runs
- a fetch-based TypeScript SDK pattern
- the endpoint table
- webhooks: the shared webhook service delivers `integration.*` events
- the test sandbox
- the caller's live tool list
- the schema registry (`GET /schemas`)

**Test mode** runs drafts as follows:
- Only the simulated sandbox connector is called; other actions are validated and dry-run.
- Approvals and delays are skipped.
- AI steps use the configured provider. If only the simulated provider exists, they use schema-conforming samples labelled `_simulated`.

## Data model (`migrations/0001_integration_hub.sql`)

`integration_actions`, `integration_workflows`, `integration_workflow_versions`, `integration_nodes`, `integration_edges`, `integration_executions`, `integration_execution_steps`, `integration_transformations`, `integration_approval_bindings` (approval requests bound to a paused step), `integration_errors` (error log, dead letters, breaker source).

All tables are organization-owned with forced RLS. They reference the shared `connectors`, `users`, `organizations` and `ai_runs` tables; policies, audit and credentials stay in the core.

## Events

| Type | Payload |
|---|---|
| `integration.workflow.created` | workflowId, name |
| `integration.execution.started` | executionId, workflowId, actionId, mode, trigger |
| `integration.execution.failed` | executionId, workflowId, status, errorClass, nodeKey, mode |
| `integration.execution.completed` | executionId, workflowId, status, durationMs, mode |
| `integration.approval.required` | approvalId, executionId, nodeKey, risk, title |
| `integration.action.executed` | executionId, actionId, actionKey, connectorId, operation, mode, dryRun |

Notification types: `integration.approval_required` and `integration.execution_failed`. Search: workflows and actions.

## Known limitations

- **Contract-only connectors.** Salesforce, ServiceNow, SAP, Microsoft 365, Jira and Slack actions run live only once those shared connector adapters ship. Until then live calls fail with `NOT_IMPLEMENTED`, and test mode dry-runs them. REST, GraphQL, webhook and sandbox connectors work live today.
- **Database, SFTP, RPA and UI-automation bridges** are modelled as actions on an API you operate in front of the legacy system. The platform ships no direct database, SFTP or browser driver.
- **Agent identity** is only *verified* for `agent` actors, which arrive with Agent Governance. Claims from API keys are recorded as unverified.
- **No loops.** Workflow graphs must be acyclic; use Retry nodes instead.
- **No custom request signing.** Custom actions use the connector's authentication scheme as-is.
