# AI Agent Governance

The enterprise control plane for AI agents. Module id `agent_governance`, route prefix `/m/agent-governance`, package `modules/agent-governance`.

It answers:

- What agents exist?
- Who owns them?
- What can they access?
- What actions may they execute?
- What have they done?
- Which actions need approval?
- Can we stop them now?

```
AGENT (API key) → AUTHENTICATE AS AGENT → AUTHORIZER (agent resolver: scopes only while approved)
      → REQUEST ACTION → BINDINGS (least privilege) → agent_action POLICIES (shared engine) → LOGGED DECISION
      → ALLOW | REQUIRE_APPROVAL / ESCALATE → HUMAN APPROVAL | DENY
      → EXECUTE (agent reports result) → ACTIVITY TIMELINE + SHARED AUDIT
```

The module does not reimplement shared infrastructure. It plugs into the core as follows:

| Need | Shared service used |
|---|---|
| Agent credentials | `platform.apiKeys`: keys are hashed and the raw key is shown once. Other secrets go through `platform.secrets`, which stores only a reference |
| Authentication as an agent | New core extension point `apiKeys.registerActorBinder` |
| What an agent may do platform-wide | `authorizer.registerActorResolver("agent", …)` |
| Rules | `platform.policies` (new policy kind `agent_action`) and `platform.policyEngine` (binding conditions) |
| Enforcement inside Integration | New core extension point `policies.registerInterceptor("integration_action", …)` |
| Audit / events / notifications | `platform.audit`, `platform.events.bus`, `platform.notifications` |
| Usage | `platform.usage` (metric `agent.action_requests`) |
| Background work | `platform.jobs` (approval expiry, review reminders, retention) |
| Retention and privacy | Organization `dataRetention.aiPromptRetention` and `aiRunDays` |
| Search | `platform.search` (resource type `agent`) |

The module never calls an AI provider.

## Enabling it for an organization

1. Deploy: `pnpm db:migrate` applies `modules/agent-governance/migrations/0001_agent_governance.sql`. That creates 12 `agent*` tables with RLS forced.
2. Enable the module. Either:
   - use **Administration → Modules → AI Agent Governance** (needs `module.manage`), or
   - call `POST /api/v1/modules/agent_governance/enable`.
3. Grant roles. The defaults are below; `org_admin` holds everything.

   | Role | Grants |
   |---|---|
   | `security_admin` | read, suspend, policy.read, policy.manage, action.read, approval.review, audit.read, incident.manage |
   | `ai_admin` | read, register, manage, suspend, policy.read, action.read, approval.review, incident.manage |
   | `auditor` | read, policy.read, action.read, audit.read |
   | `department_leader` | read, register, approval.review, action.read |
   | `analyst` | read, register |

4. Register agents under **Agent Governance → Agents → Register agent**.
   - Assign an owner.
   - A second person with `agent.manage` approves the agent. The registrant can never approve their own agent.
5. Add permission bindings on the agent's **Permissions** tab (needs `agent.policy.manage`).
6. Optionally add organization rules: **Administration → Policies**, kind `agent_action`. This needs `policy.manage`.
7. Issue a credential on the agent's **Identities** tab (needs `agent.manage`).
   - Choose scopes. You can only delegate permissions you hold.
   - To call Integration tools, the key needs `integration.execute`, `integration.connector.use` and `connector.use`.
   - Copy the key. It is shown once.
8. The agent calls the runtime API with `Authorization: Bearer <key>`.

## Permissions

| Key | Allows |
|---|---|
| `agent.read` | Inventory, risk, dashboard, incidents and reviews (read) |
| `agent.register` | Register agents. They start `pending` |
| `agent.manage` | Approve, edit, restrict and retire agents, issue credentials, schedule reviews, and decide **escalated** approvals |
| `agent.suspend` | The kill switch. Also needed to lift a suspension or quarantine |
| `agent.policy.read` | See bindings and evaluations, and run the simulator |
| `agent.policy.manage` | Add and enable permission bindings |
| `agent.action.read` | Action requests and the activity timeline |
| `agent.approval.review` | Approve, reject, request clarification or escalate |
| `agent.audit.read` | Session replay with filters |
| `agent.incident.manage` | Open, investigate and resolve incidents |

## Inventory (`agents`, `agent_versions`)

**Fields:**

- name, description, owner, department, business purpose
- environment (`development`, `staging`, `production`)
- status
- provider, model
- autonomy level (`assistive`, `supervised`, `semi_autonomous`, `autonomous`)
- risk category
- connected systems
- customer and regulatory impact (1–5)
- last activity
- registration date
- last review date
- external id
- how it was discovered (`manual`, `api`, `integration`)

**Statuses:**

- `unknown`: discovered, never registered
- `pending`
- `approved`
- `restricted`: READ only
- `suspended`
- `retired`

`quarantined` is a separate flag that the kill switch sets.

**Versions:** every change to an agent or its bindings writes an `agent_versions` snapshot.

**Unknown-agent discovery:**

- Integration's AI tool gateway accepts an unverified `agent: { id, name }` claim from users and plain API keys.
- That claim now appears on `integration.execution.started` as `agentId` and `agentName`.
- This module subscribes to the event and registers an `unknown` agent the first time it sees an id.
- An unknown agent appears on the dashboard and can never act until someone registers and approves it.

## Identities (`agent_identities`)

There are two kinds:

- **API key**: issued through the shared API key service.
  - The identity row links to `api_keys_metadata` by `api_key_id` and stores the key prefix as its fingerprint.
  - The plaintext is never stored. The key is returned once.
- **External identity**: an OAuth client, certificate or IdP subject.
  - The row records issuer, subject, fingerprint, scopes, environment and expiry.
  - An optional secret goes to the shared secret store. The row keeps only `secret_ref`.

**Revocation:**

- Revoking calls `apiKeys.revoke` and `secrets.destroy`, and marks the identity `revoked`.
- From then on the key fails `authenticate`.
- A binder that finds a revoked identity fails closed: authentication returns `null`.

## Permission bindings (`agent_permission_bindings`)

Least privilege: **with no matching binding, everything is denied.**

Each binding grants one action type. The types are `READ`, `WRITE`, `CREATE`, `UPDATE`, `DELETE`, `SEND`, `EXECUTE`, `APPROVE` and `EXPORT`; `WRITE` also covers `CREATE` and `UPDATE`.

A binding is scoped by:

| Scope | Meaning |
|---|---|
| system | Glob, case-insensitive |
| connector | Optional. Pins the binding to one shared connector of this organization |
| resource | Glob, e.g. `Charge/*` |
| environment | `any` or a specific one |
| maximum data sensitivity | `public`, `internal`, `confidential`, `restricted` |
| financial limit | Amounts above it require approval |
| time window | Weekdays and hours in an IANA time zone, including overnight windows |
| context conditions | Shared policy-engine conditions over `context.*` |
| require approval | Always send to a person |
| expiry | The binding stops matching after this date |

### Decision order

This is implemented in `src/decision.ts`, a pure function covered by unit tests.

1. **Lifecycle.**
   - `unknown`, `pending`, `suspended`, `retired` or quarantined → DENY.
   - `restricted` allows READ only.
2. **Kill-switch blocks.** A blocked connector → DENY.
3. **Least privilege.** The request needs an active, unexpired binding that matches its action type, system or connector, resource and environment.
4. **Scope.** Data sensitivity, time window and conditions must also be satisfied.
5. **Thresholds.**
   - A matching binding that covers the amount and is not approval-flagged → ALLOW.
   - Otherwise → REQUIRE_APPROVAL, with the reason (amount over limit, or binding requires approval).
6. **Organization policies of kind `agent_action`.**
   - Evaluated through `policies.evaluateKind`.
   - They can only make a decision **stricter**: ALLOW → REQUIRE_APPROVAL / ESCALATE / DENY.
   - They never loosen a binding DENY.

**Every evaluation is logged** in `agent_policy_evaluations`. That covers direct requests, Integration tool calls and simulations. Each row records the input, effect, reasons, matched bindings and the policies (with versions) that applied.

### Example policy

```json
{ "combining": "deny-overrides", "defaultEffect": "ALLOW", "rules": [
  { "id": "refunds-over-500", "effect": "REQUIRE_APPROVAL", "actions": ["refund"],
    "when": { "all": [ { "field": "subject.attributes.name", "op": "eq", "value": "RefundAgent" },
                       { "field": "context.amount", "op": "gt", "value": 500 } ] } } ] }
```

This reads: RefundAgent + refund + amount > 500 → REQUIRE_APPROVAL.

**Policy input:**

- `subject.attributes`: `name`, `environment`, `autonomy`, `riskCategory`, `department`, `status`
- `resource`: `type` is the system, `id` is the resource, `attributes` has `sensitivity` and `connectorId`
- `action`: the business action name
- `context`: `actionType`, `amount`, `environment`, `source`, plus whatever context the agent sent

## Agent runtime API

Each of these calls requires a bearer key bound to an agent; the service rejects every other actor. The base path is `/api/v1/m/agent-governance/runtime`.

| Method & path | Purpose |
|---|---|
| `POST /sessions` | Start a session: `{ instruction?, onBehalfOfUserId?, externalRef? }`. Allowed only while the agent is approved or restricted |
| `POST /sessions/:id/activity` | Record a tool call, system or resource access, error or output. Platform-only kinds are refused |
| `POST /sessions/:id/end` | `{ status: completed\|failed, output? }` |
| `POST /actions` | Ask before acting (body below). Returns the decision, status and `approvalId` |
| `GET /actions/:id` | Poll status (an agent sees only its own requests) |
| `POST /actions/:id/result` | `{ status: executed\|failed, result?, error? }`. Accepted only when the request is `allowed` or `approved` |
| `POST /actions/:id/clarification` | Answer an approver's question |

The body for `POST /actions` is:

```
{ sessionId?, actionType, action, system, connectorId?, resource, environment?,
  dataSensitivity, amount?, currency?, justification?, affectedRecords?,
  context?, idempotencyKey? }
```

You can also pass the idempotency key as an `Idempotency-Key` header.

### Agents calling enterprise systems through Integration

When an agent's key calls Integration's AI tool gateway (`/api/v1/m/integration-hub/tools/:name/invoke`):

- The shared policy evaluation of `integration_action` runs this module's **interceptor**.
- The interceptor maps the tool to a request:
  - The operation becomes the action type (read/list/search → READ, delete → DELETE, execute → EXECUTE, otherwise WRITE).
  - The connector type becomes the system, and `connectorId` and `input.amount` are passed through.
- It evaluates the request exactly as above, logs it with `source: "integration"`, and combines the result deny-overrides with Integration's own policies.
- **Outcome:**
  - DENY fails the execution with `policy_denied`.
  - REQUIRE_APPROVAL / ESCALATE pauses it for Integration's approval flow.
  - A suspended agent is already stopped at the authorizer: its key has no permissions, so the gateway returns 403.

## Human approval (`agent_approvals`)

**What approvers see:**

- the agent and the proposed action
- the reason or justification
- affected systems and records
- financial impact and data sensitivity
- the policy decision, with reasons and policy versions
- supporting context
- a conversation thread

**Decisions:**

| Decision | Who can make it | Effect |
|---|---|---|
| approve / reject | Users with `agent.approval.review` | — |
| request clarification | Users with `agent.approval.review` | The agent answers through the runtime API and the request returns to the queue |
| escalate | Users with `agent.approval.review` | Raises the escalation level; deciding then needs `agent.manage` |

Policies that return ESCALATE create the approval already escalated.

**Restrictions:**

- **Separation of duties:** the user the agent acts for (`onBehalfOfUserId`) can never decide its request.
- Agents and API keys cannot decide.
- A suspended, quarantined or retired agent's requests cannot be approved.
- Approvals expire after 48 h. A job marks them `expired`.
- Every decision is audited as `agent.approval_decided` and emits `agent.action.allowed` or `agent.action.denied`.

## Kill switch

`POST /agents/:id/emergency` (needs `agent.suspend`). The confirmation must equal the agent's name and the reason must be at least 5 characters.

| Action | Effect |
|---|---|
| `suspend` | Status `suspended`. The agent's key still authenticates but carries **no permissions**. It cancels pending approvals, un-executed allowed requests and active sessions |
| `quarantine` | Suspend, revoke every credential and disable every binding |
| `revoke_credentials` | Revoke every API key and external secret |
| `disable_capability` | Disable one binding |
| `block_connector` | Deny everything through one shared connector of this organization |

**Every emergency action:**

- is audited as `agent.emergency_<action>`
- appears in the timeline
- opens a `kill_switch` incident and emits `agent.incident.created`
- notifies the owner (priority critical)
- recomputes risk

Suspend and quarantine also emit `agent.suspended`.

Lifting a suspension (`POST /agents/:id/status`) needs both `agent.manage` and `agent.suspend`. Revoked credentials and disabled bindings stay as they are.

## Activity timeline and audit replay

**What gets recorded:** `agent_actions` records:

- instructions and tool calls
- system and resource access
- proposed actions and policy decisions
- approvals and executed actions
- errors, outputs and emergency actions

Each event has a timestamp and a source (`agent`, `platform` or `integration`).

**Retention:**

- `full`: content is kept after redaction (keys such as password, secret, token, key, authorization, ssn and card are masked; strings go through the shared redactor).
- `metadata` or `none`: only metadata. The instruction text and details become `{ retained: false }`.
- Rows older than `aiRunDays` are purged by the daily `agent_governance.retention` job, which the worker schedules.

**Replay UI:** **Activity & replay** filters sessions by:

- agent
- user (on behalf of)
- system
- action type
- policy result
- date range
- incident (a 24 h window before the incident and 1 h after)

A session opens a step-through player with previous, next and play controls. It shows each step's detail and the session's action requests.

## Risk scoring (`agent_risk_assessments`)

Risk scoring is explainable and versioned (`ag-risk-1.0`, in `src/risk.ts`).

**Factors:** nine, each rated 1–5 by a published rule:

| Factor | Weight |
|---|---|
| sensitive data | 15% |
| financial authority | 15% |
| external communication | 10% |
| production access | 10% |
| autonomy | 15% |
| connected systems | 10% |
| customer impact | 10% |
| regulatory impact | 10% |
| historical violations (DENY decisions in 90 days) | 5% |

**Score:** `Σ weight × (rating − 1) / 4 × 100`.

**Bands:**

| Score | Band |
|---|---|
| ≥75 | critical |
| ≥55 | high |
| ≥30 | medium |
| below 30 | low |

**Unrated factors:** a missing customer or regulatory rating counts as a neutral 3 and is flagged "assumed".

**Explanation:** each assessment stores the components with their evidence and a sentence naming the top contributors.

**When it recomputes:** on registration, updates, binding changes, emergencies and reviews.

## Security dashboard

**Counts:**

- active, unknown, high-risk, suspended and privileged agents
- policy violations and denied actions (30 days)
- pending approval requests
- sensitive-data requests (30 days)
- agents without owners
- stale reviews
- open incidents

**Charts and lists:**

- agents by status
- decisions in the last 30 days
- a "needs attention" list
- the approval queue

## Reviews and attestation (`agent_reviews`)

**Scheduling:** approving an agent schedules a review by risk band:

| Band | Review interval |
|---|---|
| critical | 30 days |
| high | 90 days |
| medium | 180 days |
| low | 365 days |

The review owner (by default the agent owner) gets a shared notification 7 days before it is due (job `agent_governance.review.reminder`).

**Completing a review** records:

- whether the purpose is still valid
- whether the permissions are still valid
- whether the systems are still required
- a risk status
- an outcome: `approved`, `changes_required`, `restricted` or `retired`

**Who can complete it:**

- the designated review owner, who still needs `agent.read`
- anyone with `agent.manage`

**Outcome effects:**

- `restricted` restricts the agent.
- `retired` retires it.
- Any outcome except `retired` schedules the next review.

## Data model (`migrations/0001_agent_governance.sql`)

`agents`, `agent_versions`, `agent_identities`, `agent_permission_bindings`, `agent_sessions`, `agent_actions`, `agent_action_requests`, `agent_policy_evaluations`, `agent_approvals`, `agent_risk_assessments`, `agent_incidents`, `agent_reviews`.

**Foreign keys to shared tables:**

- `organizations` and `users`
- `connectors` (bindings)
- `api_keys_metadata` (identities)

**Integrity rules:**

- RLS is forced on every table.
- Every child row carries `organization_id`.
- Cross-tenant connector ids are rejected in the service.

## Events

| Type | Payload |
|---|---|
| `agent.registered` | `agentId, name, status, discoveredVia` |
| `agent.approved` | `agentId, approvedBy` |
| `agent.suspended` | `agentId, action, reason` |
| `agent.action.requested` | `requestId, agentId, actionType, action, system, decision` |
| `agent.action.allowed` | `requestId \| null, agentId, source (direct\|approval\|integration)` |
| `agent.action.denied` | `requestId \| null, agentId, source, reason` |
| `agent.approval.required` | `approvalId, requestId, agentId, escalated` |
| `agent.incident.created` | `incidentId, agentId, kind, severity` |

**Notification types:** `agent.approval_required`, `agent.emergency`, `agent.incident`, `agent.review_due`.

## Shared-core extension points added for this module

- **`apiKeys.registerActorBinder(name, binder)`** (`packages/auth/src/api-keys.ts`).
  - After a key verifies, binders may map it to another actor. The first non-null result wins.
  - A binder that throws makes `authenticate` return `null` (fail closed).
- **`policies.registerInterceptor(kind, name, fn)`** (`packages/policies/src/service.ts`).
  - Runs inside `evaluateKind` for that kind after stored policies.
  - Combines deny-overrides; a throwing interceptor yields DENY.
  - Its reasons are prefixed `[name]`, and `policies` gains `interceptor:<name>`.
- **Integration changes:**
  - Integration now passes `connectorId` in the `integration_action` resource attributes.
  - It publishes `agentId` and `agentName` on `integration.execution.started`.

## Known limitations

- **Cooperative enforcement.** An agent is governed when it calls the runtime API or acts through Integration's gateway. An agent that holds its own credentials to an enterprise system and acts directly is not intercepted. The only remedy is to revoke those credentials and route the agent through shared connectors.
- **Approval does not execute the action.** After an approval, the agent performs the action and reports the result. Integration-mediated actions resume through Integration's own approval.
- **Only API keys authenticate.** External identities (OAuth clients, certificates) are recorded and their secrets stored, but this release does not authenticate agents with them. Agents authenticate with platform API keys.
- **Risk weights are fixed.** The model is published and versioned (`ag-risk-1.0`), not tuned per organization.
- **Discovery has one source.** Unknown agents are found only through agent claims on Integration's gateway. There is no network or SaaS discovery.
- **The time window and the approval expiry are fixed.** Time windows use the binding's time zone (UTC by default). Approval expiry is fixed at 48 h.
