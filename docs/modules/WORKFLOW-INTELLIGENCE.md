# AI Workflow Intelligence

Finds, scores and redesigns the workflows where AI creates measurable value, then tracks implementations from proposal to measured ROI. Module id `workflow_intelligence`, route prefix `/m/workflow-intelligence`, package `modules/workflow-intelligence`.

## Enabling it for an organization

1. Deploy as usual: `pnpm db:migrate` applies `modules/workflow-intelligence/migrations/*.sql` (14 `wi_*` tables, RLS forced).
2. An org admin (`module.manage`) opens **Administration → Modules → AI Workflow Intelligence → Enable**, or calls `POST /api/v1/modules/workflow_intelligence/enable`. Until then every module permission is denied with `MODULE_NOT_ENABLED`, its pages show "Not enabled", and its API routes return 403.
3. Grant access through roles. System-role defaults (`roleGrants`):

| Role | Grants |
|---|---|
| `org_admin` | all (`*`) |
| `department_leader` | read, create, update, analyze, approve, roi.read, implementation.manage |
| `analyst` | read, create, update, analyze, roi.read, roi.manage |
| `executive`, `auditor` | read, roi.read |
| `standard_user`, `read_only` | read |

4. AI redesign needs a configured AI provider (Administration → AI providers) and `ai.use`. With only the simulated provider it refuses with `NOT_CONFIGURED`; it never fabricates a proposal.

## Permissions

| Key | Risk | Allows |
|---|---|---|
| `workflow.read` | low | Inventory, models, scores, opportunities, implementations (no financials) |
| `workflow.create` | low | Manual create; CSV / API / connector import; load sample data |
| `workflow.update` | low | Attributes, process model (new version), factor ratings |
| `workflow.delete` | high | Delete workflows; clear sample data |
| `workflow.analyze` | medium | Scoring + ROI projection + opportunity upsert; AI redesign (also needs `ai.use`) |
| `workflow.approve` | high | Decide opportunities (separation of duties: never your own analysis); accept/reject AI proposals |
| `workflow.roi.read` | medium | See any money figure — without it, financial fields are `null` server-side |
| `workflow.roi.manage` | high | Assumptions, costs, baselines, measurements, actual implementation cost |
| `workflow.implementation.manage` | high | Start implementations, edit plans, move stages |

## Data model (`migrations/0001_workflow_intelligence.sql`)

All tables carry `organization_id` with forced RLS. FKs point at shared tables (`organizations`, `users`, `connectors`, `ai_runs`) — nothing from the core is duplicated.

| Table | Purpose |
|---|---|
| `wi_workflows` | Inventory record (owner, sponsor, status, frequency, volume, systems, roles, risk, regulatory category, source, `data_class`, `current_version`, review dates) |
| `wi_workflow_versions` | Immutable snapshot per version (attributes + steps + edges + metrics) |
| `wi_workflow_steps` / `wi_workflow_edges` | Process graph. Step types: trigger, human_task, system_action, ai_task, decision, approval, delay, exception, completion |
| `wi_workflow_metrics` | Employees involved + nine 1–5 factor ratings with provenance and evidence |
| `wi_workflow_costs` | One-time / annual / per-execution costs with provenance |
| `wi_workflow_assumptions` | Editable ROI assumptions with provenance and rationale |
| `wi_workflow_scores` | Stored scoring result (all components + explanations), with workflow version and model version |
| `wi_workflow_roi_calculations` | Projected (per analysis) and actual (per measurement) ROI with inputs and outputs |
| `wi_workflow_recommendations` | AI redesign proposals, guard warnings, `ai_run_id`, prompt template id/version, review |
| `wi_workflow_opportunities` | One per workflow: value/complexity/risk, quadrant, money, priority, decision |
| `wi_workflow_implementations` | Stage, sponsor, owner, team, milestones, dependencies, systems, expected savings, actual cost, deployment date |
| `wi_workflow_baselines` / `wi_workflow_measurements` | Pre-deployment baseline and post-deployment period metrics |

**Sample data is never mixed with production.** `data_class` is `production` or `sample`; every list, dashboard and portfolio query filters on exactly one class (default production). Sample data is created only by **Load sample workflows** or by importing from a simulated (sandbox) connector, and the UI shows a banner whenever it is displayed. Event payloads carry `dataClass` so subscribers can filter too.

## Scoring (`src/scoring.ts`, model `wi-score-1.0`)

15 dimensions rated 1–5. Nine are rated by people (repetitiveness, decision complexity, human judgment, data availability, data quality, integration availability, error tolerance, security sensitivity, regulatory exposure); unrated ones become a neutral 3 tagged ASSUMPTION and are listed in the explanation. Six are derived with published thresholds: labor intensity (annual human hours), volume, systems count, handoffs (role changes), savings potential, revenue potential.

Each 0–100 score = Σ weight × normalized rating ((r − 1) / 4, inverted where noted) × 100:

| Score | Components |
|---|---|
| AI Opportunity | labor intensity 25%, volume 15%, repetitiveness 15%, savings 20%, revenue 10%, human judgment 15% (inverse) |
| Automation Readiness | repetitiveness 30%, integration availability 25%, decision complexity 25% (inverse), error tolerance 20% |
| Data Readiness | data availability 50%, data quality 50% |
| Risk (lower is better) | security 35%, regulatory 35%, workflow risk category 20%, error tolerance 10% (inverse) |
| Integration Complexity (lower is better) | systems 40%, integration availability 40% (inverse), handoffs 20% |
| Expected ROI | 60% × min(3-yr ROI ÷ 300%, 1) + 40% × payback factor (≤6 mo 1.0, ≤12 0.8, ≤24 0.5, ≤36 0.25) |

Every score is stored with its components (rating, weight, points, provenance, basis) and a prose explanation. Portfolio position: value = 60% AI Opportunity + 40% Expected ROI; complexity = 50% Integration Complexity + 30% (100 − Automation Readiness) + 20% (100 − Data Readiness); threshold 50 → quick win / strategic bet / fill-in / deprioritize. "AI-ready" = readiness ≥ 60, data readiness ≥ 60 and risk < 67.

## ROI (`src/roi.ts`, model `wi-roi-1.0`)

Inputs are tagged **FACT**, **ASSUMPTION** or **AI ESTIMATE**; each output carries its formula and the *weakest* provenance of its inputs.

- Labor hours: human step types only (human task, approval, decision, exception) — minutes × runs/execution × volume ÷ 60, plus error + rework share.
- Future hours: per-step reduction from automation potential (none 0, low 20%, medium 50%, high 80%; unknown → `default_time_reduction`), × `adoption_rate`. Approval steps use `approval_time_reduction`, capped at 60% — approvals stay human.
- Outputs: current/future annual hours and cost, recoverable hours, annual savings, revenue (`annual_revenue_uplift`), implementation cost (Σ one-time), recurring cost (annual + per-execution + AI inference), net annual benefit, payback months, ROI at 1/3/5 years. ROI and payback are `null` (with a note) when there is no implementation cost or no net benefit — never invented.
- Realized ROI: baseline and measurements are normalized per execution and annualized; variance lines (projected, actual, variance, variance %) for savings, recovered hours, net benefit, 3-yr ROI and payback.

## AI redesign (`src/redesign.ts`)

- Calls **only** `platform.ai.execute` with `moduleId: "workflow_intelligence"`, `useCase: "workflow.redesign"`, prompt template `workflow.redesign@1`, JSON response, `references: { workflowId, workflowVersion }`, and data classification `confidential` for high/critical-risk or regulated workflows (else `internal`). Routing, policy, budget, retention, usage and the `ai_runs` record (provider, model, template, version, org, user, tokens, cost, timestamp) all come from the shared AI layer; the recommendation stores `ai_run_id`.
- The response is schema-validated; invalid output is rejected with the run id (nothing saved).
- **Human-control guard**: any approval step or step marked `requiresApproval` that the model removed is restored (with its edges); one it tried to automate keeps `requiresApproval`. Each restoration is a visible warning. Dangling edges are dropped, missing exception paths and unexplained removals are flagged.
- All proposal numbers are tagged AI ESTIMATE. Accepting a proposal (`workflow.approve`) records the decision; it does not overwrite the current-state model.

## Implementation lifecycle

Proposed → Approved → Design → Build → Testing → Pilot → Production → Measured. Forward one stage at a time; backward moves allowed. Server-enforced gates: **Approved** needs an approved opportunity; **Production** needs a baseline (then baselines freeze); **Measured** needs a measurement. Measurements are accepted from Pilot on. Opportunity status follows (`in_implementation`, `delivered`).

## Events

| Type | Payload |
|---|---|
| `workflow.created` | workflowId, name, source, dataClass |
| `workflow.analyzed` | workflowId, version, modelVersion, quadrant, aiReady, scores{6}, dataClass |
| `workflow.opportunity.created` | opportunityId, workflowId, valueScore, quadrant, dataClass |
| `workflow.approved` | opportunityId, workflowId, decidedBy, dataClass |
| `workflow.implementation.started` | implementationId, opportunityId, workflowId, stage, dataClass |
| `workflow.production.started` | implementationId, workflowId, deploymentDate, dataClass |
| `workflow.roi.measured` | implementationId, workflowId, measurementId, actualAnnualSavings, dataClass |

Notification types: `workflow.opportunity_identified` (to `workflow.approve` holders; production quick wins / strategic bets), `workflow.opportunity_decided` (to the analyst), `workflow.implementation_production` (to `workflow.roi.manage` holders). Search: workflows appear in global search (`workflow.read`).

## API (`/api/v1/m/workflow-intelligence`)

All routes require the module to be enabled and accept session or API-key auth unless noted.

| Method & path | Permission |
|---|---|
| `GET /dashboard?dataClass=` | workflow.read |
| `GET /workflows?dataClass=&department=&status=&riskCategory=&q=` · `POST /workflows` | read · create |
| `GET/PATCH/DELETE /workflows/:id` | read / update / delete |
| `PUT /workflows/:id/graph` · `PUT /workflows/:id/metrics` | update |
| `PUT /workflows/:id/assumptions` · `PUT /workflows/:id/costs` | roi.manage |
| `GET /workflows/:id/versions` · `GET /workflows/:id/versions/:v` | read |
| `POST /workflows/:id/analyze` · `POST /workflows/:id/redesign` | analyze |
| `POST /recommendations/:id/review` | approve |
| `POST /imports/csv` · `POST /imports/records` · `POST /imports/connector` | create (+ `connector.use` for connectors) |
| `POST/DELETE /sample-data` (session only) | create / delete |
| `GET /opportunities?dataClass=&status=&quadrant=&department=&sort=` | read |
| `POST /opportunities/:id/decision` · `POST /opportunities/:id/implementation` | approve · implementation.manage |
| `GET /implementations` · `GET/PATCH /implementations/:id` | read · implementation.manage |
| `POST /implementations/:id/stage` | implementation.manage |
| `POST /implementations/:id/baseline` · `POST /implementations/:id/measurements` | roi.manage |

## Known limitations

- Connector discovery maps only `name`, `description`, `department` and an external id from list records; steps are not discovered.
- Scoring weights and thresholds are fixed per model version (no per-org tuning yet).
- Accepting an AI proposal does not generate a future-state model version or an AI-estimated ROI scenario automatically.
- Realized ROI assumes the measured process volume is representative when annualizing.
