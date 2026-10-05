-- AI Workflow Intelligence — module-owned tables.
-- Every table is tenant-owned (organization_id) and protected by the shared
-- RLS helper. References to shared entities (users, connectors, ai_runs) point
-- at the core tables; nothing from the core is duplicated.

CREATE TABLE wi_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  department text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  owner_name text,
  business_sponsor text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','under_review','retired')),
  frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('continuous','daily','weekly','monthly','quarterly','yearly','ad_hoc')),
  annual_volume numeric(18,2) NOT NULL DEFAULT 0 CHECK (annual_volume >= 0),
  systems text[] NOT NULL DEFAULT '{}',
  roles text[] NOT NULL DEFAULT '{}',
  risk_category text NOT NULL DEFAULT 'medium' CHECK (risk_category IN ('low','medium','high','critical')),
  regulatory_category text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv','api','connector')),
  source_ref text,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  -- 'sample' rows (demo data, simulated connectors) are never aggregated with 'production' rows.
  data_class text NOT NULL DEFAULT 'production' CHECK (data_class IN ('production','sample')),
  current_version integer NOT NULL DEFAULT 1,
  last_reviewed_at timestamptz(3),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX wi_workflows_org_idx ON wi_workflows (organization_id, data_class, department);
CREATE UNIQUE INDEX wi_workflows_source_uq ON wi_workflows (organization_id, connector_id, source_ref) WHERE source_ref IS NOT NULL;

-- Immutable snapshots of the model (steps + edges + metrics) per version.
CREATE TABLE wi_workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE wi_workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  key text NOT NULL,
  type text NOT NULL CHECK (type IN ('trigger','human_task','system_action','ai_task','decision','approval','delay','exception','completion')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner text,
  role text,
  system text,
  input text,
  output text,
  duration_minutes numeric(12,2) NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
  wait_minutes numeric(12,2) NOT NULL DEFAULT 0 CHECK (wait_minutes >= 0),
  frequency_per_run numeric(8,3) NOT NULL DEFAULT 1 CHECK (frequency_per_run >= 0),
  cost_per_execution numeric(14,4) NOT NULL DEFAULT 0 CHECK (cost_per_execution >= 0),
  error_rate numeric(6,4) NOT NULL DEFAULT 0 CHECK (error_rate BETWEEN 0 AND 1),
  rework_rate numeric(6,4) NOT NULL DEFAULT 0 CHECK (rework_rate BETWEEN 0 AND 1),
  requires_approval boolean NOT NULL DEFAULT false,
  risk text NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high','critical')),
  automation_potential text NOT NULL DEFAULT 'unknown' CHECK (automation_potential IN ('unknown','none','low','medium','high')),
  position jsonb NOT NULL DEFAULT '{"x":0,"y":0}',
  sort integer NOT NULL DEFAULT 0,
  UNIQUE (workflow_id, key)
);

CREATE TABLE wi_workflow_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  from_key text NOT NULL,
  to_key text NOT NULL,
  label text,
  UNIQUE (workflow_id, from_key, to_key)
);

-- Operational metrics and 1–5 factor ratings, each with provenance.
CREATE TABLE wi_workflow_metrics (
  workflow_id uuid PRIMARY KEY REFERENCES wi_workflows(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employees_involved integer,
  factors jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE wi_workflow_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('implementation','integration','software','ai_inference','support','other')),
  period text NOT NULL CHECK (period IN ('one_time','annual','per_execution')),
  amount numeric(16,4) NOT NULL CHECK (amount >= 0),
  provenance text NOT NULL CHECK (provenance IN ('fact','assumption','ai_estimate')),
  description text NOT NULL DEFAULT ''
);

CREATE TABLE wi_workflow_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  key text NOT NULL,
  value numeric(18,6) NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('fact','assumption','ai_estimate')),
  rationale text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, key)
);

CREATE TABLE wi_workflow_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  workflow_version integer NOT NULL,
  model_version text NOT NULL,
  scores jsonb NOT NULL,
  computed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  computed_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX wi_scores_wf_idx ON wi_workflow_scores (workflow_id, computed_at DESC);

CREATE TABLE wi_workflow_roi_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  implementation_id uuid,
  kind text NOT NULL CHECK (kind IN ('projected','actual')),
  inputs jsonb NOT NULL,
  outputs jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX wi_roi_wf_idx ON wi_workflow_roi_calculations (workflow_id, kind, created_at DESC);

-- AI redesign proposals. ai_run_id links to the shared AI run log (model, prompt template, tokens, cost).
CREATE TABLE wi_workflow_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  workflow_version integer NOT NULL,
  ai_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  prompt_template_id text NOT NULL,
  prompt_template_version text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),
  proposal jsonb NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz(3),
  review_note text
);

CREATE TABLE wi_workflow_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL UNIQUE REFERENCES wi_workflows(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'identified' CHECK (status IN ('identified','approved','rejected','in_implementation','delivered')),
  value_score numeric(5,1) NOT NULL,
  complexity_score numeric(5,1) NOT NULL,
  risk_score numeric(5,1) NOT NULL,
  quadrant text NOT NULL,
  strategic_priority integer NOT NULL DEFAULT 3 CHECK (strategic_priority BETWEEN 1 AND 5),
  estimated_annual_savings numeric(18,2) NOT NULL DEFAULT 0,
  potential_revenue numeric(18,2) NOT NULL DEFAULT 0,
  implementation_cost numeric(18,2) NOT NULL DEFAULT 0,
  payback_months numeric(10,2),
  roi_3yr_pct numeric(12,2),
  labor_hours_recoverable numeric(18,2) NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz(3),
  decision_note text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE wi_workflow_implementations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL UNIQUE REFERENCES wi_workflow_opportunities(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'proposed' CHECK (stage IN ('proposed','approved','design','build','testing','pilot','production','measured')),
  sponsor text,
  owner text,
  team text[] NOT NULL DEFAULT '{}',
  milestones jsonb NOT NULL DEFAULT '[]',
  dependencies text[] NOT NULL DEFAULT '{}',
  systems text[] NOT NULL DEFAULT '{}',
  expected_annual_savings numeric(18,2) NOT NULL DEFAULT 0,
  actual_cost numeric(18,2) NOT NULL DEFAULT 0,
  deployment_date date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE wi_workflow_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  implementation_id uuid NOT NULL REFERENCES wi_workflow_implementations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  metrics jsonb NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('fact','assumption','ai_estimate')),
  captured_by uuid REFERENCES users(id) ON DELETE SET NULL,
  captured_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE wi_workflow_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  implementation_id uuid NOT NULL REFERENCES wi_workflow_implementations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES wi_workflows(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  metrics jsonb NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('fact','assumption','ai_estimate')),
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'wi_workflows', 'wi_workflow_versions', 'wi_workflow_steps', 'wi_workflow_edges', 'wi_workflow_metrics',
  'wi_workflow_costs', 'wi_workflow_assumptions', 'wi_workflow_scores', 'wi_workflow_roi_calculations',
  'wi_workflow_recommendations', 'wi_workflow_opportunities', 'wi_workflow_implementations',
  'wi_workflow_baselines', 'wi_workflow_measurements'
]::regclass[]) AS t;
