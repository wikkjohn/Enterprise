# AI Operations Management

The system of record for the organization's AI estate. Module id `ai_operations`, route prefix `/m/ai-operations`, package `modules/ai-operations`.

It answers nine questions:

1. What AI are we using?
2. What are we paying for?
3. Who is using it?
4. Which tools overlap?
5. Which licenses are unused?
6. Which models are expensive?
7. Which teams are adopting AI?
8. What business value are we receiving?
9. What should be consolidated?

It manages tools, models, agents, vendors, people, costs, training, implementations and value across the platform.

The module builds none of the shared infrastructure itself:

| Need | Shared service |
|---|---|
| People, departments, roles | `memberships`, `users`, RBAC |
| AI model spend and usage | `usage_events` (shared metering, read at query time, never copied) and the `ai_runs` log |
| Model catalog | Shared `ai_providers` / `ai_models` registry |
| Model routing | `platform.ai.registerRoutingPolicy`: the AI layer still executes every request |
| Other modules' data | `platform.insights` read models and the event stream (`workflow.roi.measured`); no other module's tables are read |
| Audit, events, notifications, jobs, search | Shared services |

## Enabling it for an organization

1. **Deploy.** Run `pnpm db:migrate`. It applies `modules/ai-operations/migrations/0001_ai_operations.sql`, which creates 19 tables with RLS forced.
2. **Enable.** Use **Administration → Modules → AI Operations Management**, or `POST /api/v1/modules/ai_operations/enable`. The first visit creates starter content as drafts: seven implementation patterns and a use-case library for nine departments.
3. **Make sure members have departments.** Set each member's department. Allocation, adoption and per-department costs use it.
4. **Grant roles.** `org_admin` has every permission. The defaults are:

   | Role | Grants |
   |---|---|
   | `ai_admin` | all nine permissions |
   | `security_admin` | read, cost.read, adoption.read, request.manage (reviews requests, including the security stage) |
   | `department_leader`, `analyst`, `auditor` | read, cost.read, adoption.read |
   | `standard_user`, `read_only` | read: approved tools, the use-case library, their own training and their own requests |

5. **Load the estate:**
   - vendors and contracts;
   - tools, with owner, status, reviews, seats and cost;
   - licenses and activity exports;
   - cost records not metered by the platform, entered or bulk-imported with `POST /api/v1/m/ai-operations/costs/records`;
   - budgets;
   - model policies;
   - training programs.
6. **Run the daily job.** The worker runs `ai_operations.daily` once a day. In order, it:
   1. seeds starter content (first run only);
   2. sends renewal alerts;
   3. checks budget thresholds;
   4. expires training;
   5. takes the adoption snapshot;
   6. refreshes the forecast;
   7. runs the optimization scan.

## Permissions

| Permission | Allows |
|---|---|
| `ai_ops.read` | Open the module. See the tool inventory without costs, the use-case library, the Center of Excellence, your own training and your own requests. Submit requests |
| `ai_ops.tool.manage` | Tools, license assignment and revocation, activity imports |
| `ai_ops.vendor.manage` | Vendors, contacts, contracts, renewal dates |
| `ai_ops.cost.read` | Spend, budgets, forecasts, model spend and policies, optimization findings, value, unit economics, the executive dashboard |
| `ai_ops.cost.manage` | Record, void and allocate costs. Manage budgets and value records. Decide findings and run scans |
| `ai_ops.adoption.read` | Department-level adoption |
| `ai_ops.training.manage` | Training programs, assignments and completion records. The use-case library |
| `ai_ops.request.manage` | Review AI requests at every stage |
| `ai_ops.admin` | Model routing policies, Center of Excellence content, templates, settings, cost by user |

Money is server-filtered. Without `ai_ops.cost.read`, tool costs and contract values come back as `null`, and the dashboard is a personal workspace instead of the executive view.

## Tool inventory, licenses and vendors

### Tools

Each tool records:

- vendor and contract;
- category and purpose;
- status: Strategic, Approved, Experimental, Restricted or Retiring;
- business owner and departments;
- licensed seats and annual cost;
- renewal date;
- security and privacy reviews;
- the highest data classification it is approved for;
- links to the platform and other modules (keys, not copies):
  - the shared AI provider key, which links usage;
  - model keys;
  - related modules;
  - a usage key.

### Licenses

- **Assignment.** Licenses are assigned to members by email or user ID. Unknown users are reported back, not created.
- **Activity.** Activity comes from vendor admin or SSO exports via `POST /tools/:id/activity`. For tools linked to a platform provider, it also comes from that person's platform AI runs.
- **Unused licenses.** A license is unused when there has been no activity for `unusedLicenseDays` (default 30).

### Vendors

Vendors carry:

- contacts;
- products (their tools);
- security and privacy status;
- contracts: dates, notice period, auto-renewal, annual value, committed spend, billing frequency, owner;
- spend and utilization.

A vendor links to the shared AI provider registry by provider key instead of duplicating provider identity.

**Renewal alerts.** The daily job alerts once per renewal date when a contract enters its window: the larger of `renewalNoticeDays` and the contract notice period plus 14 days. It emits `ai_ops.contract.renewal_due` and notifies the contract owner, or vendor managers. Changing the renewal date re-arms the alert.

## Costs

### Where spend comes from

Spend comes from three sources. Nothing is copied between them:

1. **`ai_cost_records`.** Invoices, subscriptions, cloud and services. These are `measured`, or `estimated` if entered as an estimate. A record spanning several months is spread by day. An `externalRef` (such as an invoice number) prevents double entry.
2. **`usage_events` with metric `ai.cost`.** Platform AI inference metered by the shared usage service. These are `measured`, with provider, model, module, agent, workflow and user dimensions. Department comes from the user's membership.
3. **Contract run-rate.** An `estimated` amount of `annual value × days / 365`, added for each month in which nothing was recorded against the contract or its vendor. Usage-billed contracts never get an estimate, because their spend is already metered or invoiced. The future is never estimated as spend.

### Dimensions and categories

- **Dimensions:** organization, department, tool, vendor, provider, model, agent, workflow, project, module, category, basis, month, and user (only with `ai_ops.admin`).
- **Categories:** subscription, API, inference, cloud, implementation, consulting, support.

### Measured, estimated and allocated

These are kept separate everywhere: in totals, in every breakdown row, in budgets and in unit economics.

**Allocation** splits a shared cost record across departments. The split can be by:

- headcount;
- licensed seats;
- metered AI spend in the same period;
- custom weights.

The shares are exact to the cent (largest remainder). The children carry the basis `allocated`. The parent stays for the audit trail but stops counting. Allocation can be undone.

### Budgets

- **Scope:** a budget covers the organization, or one department, tool, vendor, provider, model, category or project.
- **Period:** monthly, or quarterly or annual following the fiscal year (`fiscalYearStartMonth`).
- **Status:**
  - `ok`;
  - `at_risk`: the run-rate projects an overrun;
  - `warning`: an alert threshold has been crossed;
  - `exceeded`: spend has reached 100%.
- **Alerts:** each threshold alerts once per period (`ai_ops.cost.threshold_exceeded` plus a notification).

### Forecasts

Forecasts use an ordinary least-squares trend over up to 12 months of history, with a band of ±1.28 × the residual standard deviation, clamped at zero. With fewer than three months of history they fall back to the average (±20%). Forecasts are always labelled estimated.

## Optimization (recommendations only)

The scan never switches a model, revokes a license or cancels a contract.

| Finding | Rule | Estimated savings |
|---|---|---|
| Unused licenses | Assigned licenses with no activity for `unusedLicenseDays`; at least 2 seats or 10% unused | seat cost × unused |
| Idle tool | A tool with a cost and assigned licenses but no active user for 60+ days | annual cost |
| Duplicate tools | Two or more non-retiring tools in the same category serving overlapping departments | all but the largest contract |
| Expensive model | A premium or standard model used for 50+ runs averaging ≤ 2,000 input and ≤ 400 output tokens, where an economy model approved for the same data classification would cost at least 30% less. The simulated sandbox model is never suggested | annualized difference |
| Abnormal token use | A module's latest day is more than 3 standard deviations above, and at least 3× the mean of, its 14-day baseline | — |
| Cost spike | Platform AI spend in the last 7 days is `costSpikePct` above the prior weekly average | annualized increase |
| Underutilized contract | Consumption is running below `contractUtilizationFloorPct` of committed annual spend | commitment − consumption |

Findings are keyed by a deduplication key, so a rescan updates a finding instead of duplicating it. A snapshot finding that is no longer detected resolves itself. A new finding emits `ai_ops.optimization.found` and notifies cost managers.

## Model management and routing policies

The module manages policy and reporting; the shared AI provider layer performs execution.

**What a policy matches:**

- task patterns (`*.classify`, `legal.*`);
- modules;
- data classifications.

**What a policy can require:**

- allowed tiers, as the quality proxy;
- a preferred tier;
- allowed or blocked models;
- allowed providers, for residency and regulatory constraints;
- required capabilities;
- a cost ceiling per million tokens;
- an observed median latency ceiling.

Each policy also has a priority and an optional regulatory note.

**Advisory or enforced.** A policy is one of two kinds:

- **Advisory:** never changes routing. It is used only for compliance reporting.
- **Enforced:** applied through the AI layer's routing hook, which filters and orders candidates. The highest-priority, most specific matching policy wins.

If nothing qualifies, the request fails closed with `NOT_CONFIGURED` for that task only. Saving such a policy returns a warning.

The **Models** page shows:

- model spend (measured, from `ai_runs`);
- spend by task with the governing policy;
- per-policy compliance over the last 30 days, with savings had the cheapest allowed real model been used.

## Adoption (privacy-preserving)

Adoption is computed for departments only, and stored monthly in `ai_adoption_metrics`. It covers:

- members, licensed people and active people;
- AI runs per active person (usage frequency);
- required-training completion;
- approved use-case adoption (people using a published use case's `usageKey` in shared metering).

Groups smaller than `adoptionMinGroup` (default 5) are suppressed, and nothing ranks or tracks individuals.

## Enablement, training and the Center of Excellence

### Use cases

There is a use-case library per department. Each use case records:

- the business problem;
- the approved workflow;
- the approved tool;
- instructions and expected benefit;
- risks;
- required training;
- the success metric;
- optional links to a Workflow Intelligence workflow and a usage key.

A published use case must name a Strategic or Approved tool.

### Training

Training is organized as programs and courses focused on real job workflows. Each has departments or roles, a required flag, a validity period and an assessment pass mark.

- **Assignment.** Training is assigned to people, departments or roles. Each assignment emits `ai_ops.training.required` and sends a notification.
- **Completion.** People record their own completion, managers record anyone's. A score below the pass mark keeps the assignment in progress.
- **Expiry.** Completion expires after the validity period, and required training is reassigned.

### Center of Excellence

The Center of Excellence holds:

- standards, policies, guidance and best practices, with review dates;
- the implementation library: business objective, systems, data, AI capability, risk, implementation steps, measurement and links to Workflow Intelligence workflows;
- views of approved tools, allowed models and requests in review.

## AI request workflow

```
Submitted → Business Review → Security Review → Technical Review → Financial Review → Approved | Rejected → Implementation → Measurement → Closed
```

- **Who can request.** Anyone with `ai_ops.read` can request a new tool, automation, model, agent, integration or use case.
- **Reviewing.** Reviewers (`ai_ops.request.manage`) record one of four decisions at each stage:
  - approve;
  - not applicable, with a reason;
  - request changes, which returns the request to the requester to edit and resubmit;
  - reject.

  Nobody reviews or advances their own request.
- **Implementation.** Starting implementation of an approved tool request adds the tool to the inventory (Experimental, source "request").
- **Measurement.** Measurement can record measured annual value into the value ledger.
- **Audit trail.** Every step is kept in `ai_request_reviews` and the audit log. The workflow emits `ai_ops.request.submitted` and `ai_ops.request.approved`; requesters and reviewers are notified.

## Value

`ai_value_records` is the value ledger:

- **Realized (measured).**
  - Workflow Intelligence `workflow.roi.measured` events arrive automatically. The latest measurement per implementation replaces the previous one.
  - Measured outcomes of AI requests.
  - Manual records.
- **Projected (estimated).**
  - Approved Workflow Intelligence opportunities (from its insight provider).
  - The expected value of approved requests.
  - Projected records.

Projections are never added to realized value.

## Executive dashboard and unit economics

### Dashboard

The dashboard shows:

- AI spend for the last 12 months (split by basis) and the trend;
- active tools and vendors;
- licenses in use or unused;
- adoption;
- model spend;
- agent count and risk;
- business value: realized and projected;
- savings: open and actioned;
- pending requests;
- the security and governance summary (from Data Security, Agent Governance and Knowledge insights);
- budgets;
- every enabled module's insight summary.

Every figure links to its drill-down.

### Unit economics

Unit economics cover the last 30 days, with measured, estimated and allocated cost per unit kept apart:

- cost per active user;
- cost per workflow (with attributed AI cost);
- cost per automated task (Integration's successful live executions);
- cost per agent (with attributed cost);
- cost per AI run;
- cost per model run;
- cost per department member;
- cost per $1 of realized value (12-month cost ÷ measured annual value).

## Data model

All tables have `organization_id` with forced RLS. The tenant-isolation test covers them automatically.

**Tables from the specification:**

`ai_tools`, `ai_tool_licenses`, `ai_vendors`, `ai_vendor_contracts`, `ai_cost_records`, `ai_budgets`, `ai_cost_forecasts`, `ai_adoption_metrics`, `ai_use_cases`, `ai_training_programs`, `ai_training_assignments`, `ai_requests`, `ai_request_reviews`, `ai_implementation_templates`, `ai_value_records`.

**Additional tables:**

- `ai_ops_settings`
- `ai_model_policies`
- `ai_optimization_findings`
- `ai_coe_items`

**Reused shared tables:**

`ai_models`, `ai_providers`, `ai_runs`, `users`, `organizations`, `memberships`, `usage_events`.

## Events

| Type | Payload |
|---|---|
| `ai_ops.tool.added` | `toolId, status, source` |
| `ai_ops.contract.renewal_due` | `contractId, vendorId, renewalDate, daysUntil, annualValue, autoRenew` |
| `ai_ops.cost.threshold_exceeded` | `budgetId, threshold, periodKey, spent, amount` |
| `ai_ops.request.submitted` | `requestId, kind` |
| `ai_ops.request.approved` | `requestId, kind` |
| `ai_ops.training.required` | `assignmentId, programId, userId, dueDate, required` |
| `ai_ops.optimization.found` | `findingId, kind, estimatedAnnualSavings` |

The module consumes `workflow.roi.measured`.

**Notification types:** `ai_ops.renewal_due`, `ai_ops.budget_threshold`, `ai_ops.request`, `ai_ops.training_required`, `ai_ops.optimization`.

## HTTP API (`/api/v1/m/ai-operations`)

There are 41 routes; each re-checks permissions in the service.

| Area | Routes |
|---|---|
| Dashboard | `dashboard` |
| Tools | `tools`, `tools/:id`, `tools/:id/licenses`, `tools/:id/licenses/:licenseId`, `tools/:id/activity` |
| Vendors | `vendors`, `vendors/:id`, `contracts`, `contracts/:id` |
| Costs | `costs?by=&from=&to=&basis=`, `costs/records`, `costs/records/:id`, `costs/records/:id/allocation` |
| Budgets and forecasts | `budgets`, `budgets/:id`, `forecasts`, `unit-economics` |
| Optimization | `optimization`, `optimization/scan`, `optimization/:id` |
| Models | `models`, `model-policies`, `model-policies/:id` |
| Adoption | `adoption` |
| Use cases and training | `use-cases`, `use-cases/:id`, `training`, `training/:id`, `training/:id/assign`, `training/assignments`, `training/assignments/:id` |
| Requests | `requests`, `requests/:id`, `requests/:id/actions` |
| Value | `value` |
| Center of Excellence | `coe`, `coe/:id`, `templates`, `templates/:id` |
| Settings | `settings` |

## Changes to the shared core

- **Cross-module insights.** `platform.insights` is a registry of per-module aggregate read models, and every installed module registers one. See [../MODULE-SYSTEM.md](../MODULE-SYSTEM.md).
- **Async routing policies.** `RoutingPolicy` may return a promise; the AI layer awaits it.

## Known limitations

- **No billing connectors.** Costs outside the platform (invoices, subscriptions, cloud bills) are entered or pushed through the API. There are no billing-system or cloud-cost connectors yet.
- **Activity sources.** License activity comes from vendor or SSO exports, or from platform AI usage for tools linked to a platform provider. Activity in third-party tools is not otherwise visible.
- **Proxy signals.** Quality tier is the proxy for model quality, and latency policies use observed medians from the last 7 days.
- **Short-lived policy cache.** Enforced routing policies are cached for 30 seconds per process, so changes take effect within that window.
- **Simple forecasts.** Forecasts are a simple trend, not a seasonal model.
- **Narrow value inputs.** Realized value relies on Workflow Intelligence measurements, request outcomes and manual records.
