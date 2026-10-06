-- AI Operations Management — module-owned tables.
-- Every table is tenant-owned (organization_id) with forced RLS. Users,
-- organizations, AI providers/models, AI runs, usage events and audit events
-- stay in the shared core and are referenced, never copied.

CREATE TABLE ai_ops_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  fiscal_year_start_month integer NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  renewal_notice_days integer NOT NULL DEFAULT 90 CHECK (renewal_notice_days BETWEEN 7 AND 365),
  unused_license_days integer NOT NULL DEFAULT 30 CHECK (unused_license_days BETWEEN 7 AND 365),
  cost_spike_pct integer NOT NULL DEFAULT 50 CHECK (cost_spike_pct BETWEEN 10 AND 1000),
  contract_utilization_floor_pct integer NOT NULL DEFAULT 60 CHECK (contract_utilization_floor_pct BETWEEN 1 AND 100),
  adoption_min_group integer NOT NULL DEFAULT 5 CHECK (adoption_min_group BETWEEN 3 AND 100),
  seeded_at timestamptz(3),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

-- Vendors. Identity of platform AI providers lives in the shared ai_providers
-- registry; a vendor links to it by key instead of copying it.
CREATE TABLE ai_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  website text,
  platform_provider_keys text[] NOT NULL DEFAULT '{}',
  business_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  security_status text NOT NULL DEFAULT 'not_reviewed' CHECK (security_status IN ('not_reviewed','in_review','approved','conditional','rejected')),
  privacy_status text NOT NULL DEFAULT 'not_reviewed' CHECK (privacy_status IN ('not_reviewed','in_review','approved','conditional','rejected')),
  security_reviewed_at timestamptz(3),
  privacy_reviewed_at timestamptz(3),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE ai_vendor_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES ai_vendors(id) ON DELETE CASCADE,
  name text NOT NULL,
  contract_number text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','expired','terminated')),
  start_date date,
  end_date date,
  renewal_date date,
  auto_renew boolean NOT NULL DEFAULT false,
  notice_days integer NOT NULL DEFAULT 30 CHECK (notice_days BETWEEN 0 AND 365),
  annual_value numeric(14,2) NOT NULL DEFAULT 0 CHECK (annual_value >= 0),
  committed_annual_spend numeric(14,2) NOT NULL DEFAULT 0 CHECK (committed_annual_spend >= 0),
  billing_frequency text NOT NULL DEFAULT 'annual' CHECK (billing_frequency IN ('monthly','quarterly','annual','usage')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  document_url text,
  notes text NOT NULL DEFAULT '',
  renewal_alerted_for date,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX ai_vendor_contracts_renewal_idx ON ai_vendor_contracts (organization_id, renewal_date);

CREATE TABLE ai_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  vendor_id uuid REFERENCES ai_vendors(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES ai_vendor_contracts(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'other',
  purpose text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'experimental' CHECK (status IN ('strategic','approved','experimental','restricted','retiring')),
  business_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  departments text[] NOT NULL DEFAULT '{}',
  licensed_seats integer NOT NULL DEFAULT 0 CHECK (licensed_seats >= 0),
  annual_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (annual_cost >= 0),
  renewal_date date,
  security_review text NOT NULL DEFAULT 'not_started' CHECK (security_review IN ('not_started','in_progress','approved','conditional','rejected')),
  privacy_review text NOT NULL DEFAULT 'not_started' CHECK (privacy_review IN ('not_started','in_progress','approved','conditional','rejected')),
  max_data_classification text NOT NULL DEFAULT 'internal' CHECK (max_data_classification IN ('public','internal','confidential','restricted')),
  -- Relationships to the shared registry and to other modules (keys, not copies).
  platform_provider_key text,
  platform_model_keys text[] NOT NULL DEFAULT '{}',
  related_modules text[] NOT NULL DEFAULT '{}',
  usage_key text,
  website text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','request','data_security','import')),
  request_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE ai_tool_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tool_id uuid NOT NULL REFERENCES ai_tools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','sso','request')),
  assigned_at timestamptz(3) NOT NULL DEFAULT now(),
  last_active_at timestamptz(3),
  activity_days_30 integer NOT NULL DEFAULT 0 CHECK (activity_days_30 >= 0),
  revoked_at timestamptz(3),
  UNIQUE (tool_id, user_id)
);
CREATE INDEX ai_tool_licenses_tool_idx ON ai_tool_licenses (organization_id, tool_id, status);

-- Cost lines that are NOT already metered by the shared usage service
-- (subscriptions, invoices, cloud, services). Platform AI inference cost is
-- read from usage_events at query time and never copied here.
CREATE TABLE ai_cost_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount_usd numeric(14,2) NOT NULL,
  category text NOT NULL CHECK (category IN ('subscription','api','inference','cloud','implementation','consulting','support')),
  basis text NOT NULL CHECK (basis IN ('measured','estimated','allocated')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','api','allocation')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','allocated','void')),
  description text NOT NULL DEFAULT '',
  tool_id uuid REFERENCES ai_tools(id) ON DELETE SET NULL,
  vendor_id uuid REFERENCES ai_vendors(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES ai_vendor_contracts(id) ON DELETE SET NULL,
  department text,
  provider_key text,
  model_key text,
  agent_id text,
  workflow_id text,
  project text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES ai_cost_records(id) ON DELETE CASCADE,
  external_ref text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (organization_id, external_ref)
);
CREATE INDEX ai_cost_records_period_idx ON ai_cost_records (organization_id, period_start);

CREATE TABLE ai_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('organization','department','tool','vendor','provider','model','category','project')),
  scope_value text,
  period text NOT NULL CHECK (period IN ('monthly','quarterly','annual')),
  amount_usd numeric(14,2) NOT NULL CHECK (amount_usd > 0),
  thresholds integer[] NOT NULL DEFAULT '{80,100}',
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  alerted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE ai_cost_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'organization',
  scope_value text,
  month date NOT NULL,
  method text NOT NULL,
  forecast_usd numeric(14,2) NOT NULL,
  low_usd numeric(14,2) NOT NULL,
  high_usd numeric(14,2) NOT NULL,
  note text NOT NULL DEFAULT '',
  generated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope, scope_value, month)
);

-- Aggregate adoption snapshots (department level only; small groups suppressed at read time).
CREATE TABLE ai_adoption_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL,
  department text NOT NULL,
  members integer NOT NULL DEFAULT 0,
  licensed_users integer NOT NULL DEFAULT 0,
  active_users integer NOT NULL DEFAULT 0,
  ai_runs integer NOT NULL DEFAULT 0,
  training_required integer NOT NULL DEFAULT 0,
  training_completed integer NOT NULL DEFAULT 0,
  use_case_users jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, period, department)
);

CREATE TABLE ai_training_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES ai_training_programs(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'course' CHECK (kind IN ('program','course')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  workflow_focus text NOT NULL DEFAULT '',
  departments text[] NOT NULL DEFAULT '{}',
  roles text[] NOT NULL DEFAULT '{}',
  required boolean NOT NULL DEFAULT false,
  validity_days integer CHECK (validity_days IS NULL OR validity_days BETWEEN 30 AND 3650),
  pass_score integer CHECK (pass_score IS NULL OR pass_score BETWEEN 0 AND 100),
  content_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE ai_use_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department text NOT NULL,
  title text NOT NULL,
  business_problem text NOT NULL DEFAULT '',
  approved_workflow text NOT NULL DEFAULT '',
  tool_id uuid REFERENCES ai_tools(id) ON DELETE SET NULL,
  instructions text NOT NULL DEFAULT '',
  expected_benefit text NOT NULL DEFAULT '',
  risks text NOT NULL DEFAULT '',
  required_training_id uuid REFERENCES ai_training_programs(id) ON DELETE SET NULL,
  success_metric text NOT NULL DEFAULT '',
  -- Links: a Workflow Intelligence workflow id and the AI use-case key metered by the shared usage service.
  workflow_ref text,
  usage_key text,
  template_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, department, title)
);

CREATE TABLE ai_training_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES ai_training_programs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department text,
  role text,
  required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','completed','expired','waived')),
  due_date date,
  completed_at timestamptz(3),
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  passed boolean,
  expires_at timestamptz(3),
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (program_id, user_id)
);
CREATE INDEX ai_training_assignments_user_idx ON ai_training_assignments (organization_id, user_id);

CREATE TABLE ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tool','automation','model','agent','integration','use_case')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  business_justification text NOT NULL DEFAULT '',
  department text,
  requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'submitted' CHECK (stage IN ('submitted','business_review','security_review','technical_review','financial_review','approved','rejected','implementation','measurement','closed')),
  changes_requested boolean NOT NULL DEFAULT false,
  data_classification text NOT NULL DEFAULT 'internal' CHECK (data_classification IN ('public','internal','confidential','restricted')),
  estimated_annual_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (estimated_annual_cost >= 0),
  expected_annual_value numeric(14,2) NOT NULL DEFAULT 0 CHECK (expected_annual_value >= 0),
  vendor_name text,
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  tool_id uuid REFERENCES ai_tools(id) ON DELETE SET NULL,
  outcome text,
  closed_reason text,
  submitted_at timestamptz(3) NOT NULL DEFAULT now(),
  decided_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX ai_requests_stage_idx ON ai_requests (organization_id, stage);

CREATE TABLE ai_request_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES ai_requests(id) ON DELETE CASCADE,
  stage text NOT NULL,
  action text NOT NULL,
  decision text,
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE ai_implementation_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  business_objective text NOT NULL DEFAULT '',
  systems text[] NOT NULL DEFAULT '{}',
  data text NOT NULL DEFAULT '',
  ai_capability text NOT NULL DEFAULT '',
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  risks text NOT NULL DEFAULT '',
  implementation text[] NOT NULL DEFAULT '{}',
  measurement text[] NOT NULL DEFAULT '{}',
  workflow_refs text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
ALTER TABLE ai_use_cases ADD CONSTRAINT ai_use_cases_template_fk FOREIGN KEY (template_id) REFERENCES ai_implementation_templates(id) ON DELETE SET NULL;
ALTER TABLE ai_tools ADD CONSTRAINT ai_tools_request_fk FOREIGN KEY (request_id) REFERENCES ai_requests(id) ON DELETE SET NULL;

-- Business value ledger: realized (measured) and projected (estimated) value.
-- Event-derived rows (e.g. Workflow Intelligence ROI measurements) are keyed by
-- source so a newer measurement replaces the older one instead of adding to it.
CREATE TABLE ai_value_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('realized','projected')),
  basis text NOT NULL CHECK (basis IN ('measured','estimated')),
  annual_value_usd numeric(14,2) NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_module text NOT NULL DEFAULT 'ai_operations',
  source_ref text,
  department text,
  tool_id uuid REFERENCES ai_tools(id) ON DELETE SET NULL,
  use_case_id uuid REFERENCES ai_use_cases(id) ON DELETE SET NULL,
  request_id uuid REFERENCES ai_requests(id) ON DELETE SET NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, source_module, source_ref)
);

-- Business model-selection policies (execution stays in the shared AI layer).
CREATE TABLE ai_model_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  enforcement text NOT NULL DEFAULT 'advisory' CHECK (enforcement IN ('advisory','enforced')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  match jsonb NOT NULL,
  rules jsonb NOT NULL,
  regulatory_note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE ai_optimization_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  recommendation text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  estimated_annual_savings numeric(14,2) NOT NULL DEFAULT 0,
  tool_id uuid REFERENCES ai_tools(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES ai_vendors(id) ON DELETE CASCADE,
  contract_id uuid REFERENCES ai_vendor_contracts(id) ON DELETE CASCADE,
  model_key text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','resolved')),
  note text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  first_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);

-- Center of Excellence: standards, policies, guidance and best practices.
CREATE TABLE ai_coe_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('standard','policy','guidance','best_practice')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  review_date date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, title)
);

SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'ai_ops_settings', 'ai_vendors', 'ai_vendor_contracts', 'ai_tools', 'ai_tool_licenses', 'ai_cost_records', 'ai_budgets', 'ai_cost_forecasts',
  'ai_adoption_metrics', 'ai_training_programs', 'ai_use_cases', 'ai_training_assignments', 'ai_requests', 'ai_request_reviews',
  'ai_implementation_templates', 'ai_value_records', 'ai_model_policies', 'ai_optimization_findings', 'ai_coe_items'
]::regclass[]) AS t;
