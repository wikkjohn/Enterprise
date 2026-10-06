-- Enterprise AI Integration — module-owned tables.
-- Every table is tenant-owned (organization_id) and protected by the shared RLS
-- helper. Connectors, credentials, users, policies and AI runs are referenced in
-- the shared core — never duplicated here.

-- Actions: a validated, permissioned, risk-classified operation on a SHARED connector.
CREATE TABLE integration_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.-]{1,80}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  capability text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('read','list','search','write','delete','execute')),
  kind text NOT NULL DEFAULT 'catalog' CHECK (kind IN ('catalog','custom')),
  template_key text,
  bridge_type text NOT NULL DEFAULT 'native' CHECK (bridge_type IN ('native','api_wrapper','database','sftp','rpa','ui_automation')),
  input_schema jsonb NOT NULL,
  output_schema jsonb,
  -- How validated input becomes connector params ({{input.x}} placeholders); for custom REST actions: method/path/query/body/headers.
  request_template jsonb NOT NULL,
  required_permissions text[] NOT NULL DEFAULT '{}',
  risk text NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  requires_approval boolean NOT NULL DEFAULT false,
  idempotency text NOT NULL DEFAULT 'none' CHECK (idempotency IN ('none','auto','key_required')),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  rate_limit_per_minute integer CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  retry jsonb NOT NULL DEFAULT '{"maxAttempts":3,"backoffSeconds":10}',
  compensation jsonb,
  capture_payloads boolean NOT NULL DEFAULT false,
  ai_exposed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE INDEX integration_actions_connector_idx ON integration_actions (organization_id, connector_id);

-- Reusable field mappings (source → normalized → destination).
CREATE TABLE integration_transformations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  mappings jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE integration_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual','api','event')),
  trigger_config jsonb NOT NULL DEFAULT '{}',
  input_schema jsonb,
  is_sample boolean NOT NULL DEFAULT false,
  current_version integer NOT NULL DEFAULT 1,
  published_version integer,
  -- Event-triggered runs execute as this user; their permissions are re-checked at run time.
  run_as_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX integration_workflows_trigger_idx ON integration_workflows (organization_id, status, trigger_type);

CREATE TABLE integration_workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES integration_workflows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE integration_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES integration_workflows(id) ON DELETE CASCADE,
  key text NOT NULL,
  type text NOT NULL CHECK (type IN ('trigger','connector_action','ai_step','transform','condition','human_approval','delay','retry','branch','exception_handler','completion')),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  position jsonb NOT NULL DEFAULT '{"x":0,"y":0}',
  sort integer NOT NULL DEFAULT 0,
  UNIQUE (workflow_id, key)
);

CREATE TABLE integration_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES integration_workflows(id) ON DELETE CASCADE,
  from_key text NOT NULL,
  to_key text NOT NULL,
  kind text NOT NULL DEFAULT 'next' CHECK (kind IN ('next','true','false','error','case','rejected','exhausted')),
  label text,
  UNIQUE (workflow_id, from_key, to_key, kind)
);

CREATE TABLE integration_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES integration_workflows(id) ON DELETE SET NULL,
  workflow_version integer,
  -- Single action calls through the AI tool gateway have no workflow.
  action_id uuid REFERENCES integration_actions(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','test')),
  trigger text NOT NULL CHECK (trigger IN ('manual','api','event','gateway')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_approval','waiting_delay','succeeded','failed','partially_failed','cancelled')),
  idempotency_key text,
  input jsonb NOT NULL DEFAULT '{}',
  state jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  current_node text,
  actor jsonb NOT NULL,
  agent jsonb,
  error_class text,
  error_message text,
  ai_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  system_calls integer NOT NULL DEFAULT 0,
  correlation_id text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  started_at timestamptz(3),
  finished_at timestamptz(3),
  duration_ms integer
);
CREATE UNIQUE INDEX integration_executions_idem_uq ON integration_executions (organization_id, coalesce(workflow_id, action_id), idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX integration_executions_list_idx ON integration_executions (organization_id, created_at DESC);
CREATE INDEX integration_executions_wf_idx ON integration_executions (workflow_id, created_at DESC);

CREATE TABLE integration_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES integration_executions(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  node_key text NOT NULL,
  node_type text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('succeeded','failed','skipped','waiting','compensated','compensation_failed','dry_run')),
  idempotency_key text,
  input jsonb,
  output jsonb,
  system_call jsonb,
  ai_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  policy_decision jsonb,
  error_class text,
  error_message text,
  cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  started_at timestamptz(3) NOT NULL DEFAULT now(),
  finished_at timestamptz(3),
  duration_ms integer,
  UNIQUE (execution_id, seq)
);
CREATE INDEX integration_steps_idem_idx ON integration_execution_steps (execution_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Human approval requests bound to a paused step (shared policy decided they are needed).
CREATE TABLE integration_approval_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES integration_executions(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  action_id uuid REFERENCES integration_actions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  title text NOT NULL,
  system text,
  reason text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  business_impact text,
  affected_data jsonb,
  proposed_payload jsonb,
  policy_decision jsonb,
  requested_by jsonb NOT NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz(3),
  decision_note text,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (execution_id, node_key)
);
CREATE INDEX integration_approvals_pending_idx ON integration_approval_bindings (organization_id, status, created_at DESC);

-- Error log and dead-letter store; also feeds the per-connector circuit breaker.
CREATE TABLE integration_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES integration_executions(id) ON DELETE CASCADE,
  node_key text,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  action_id uuid REFERENCES integration_actions(id) ON DELETE SET NULL,
  error_class text NOT NULL,
  message text NOT NULL,
  retryable boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','retrying','dead_letter','resolved')),
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX integration_errors_breaker_idx ON integration_errors (organization_id, connector_id, created_at DESC);
CREATE INDEX integration_errors_status_idx ON integration_errors (organization_id, status, created_at DESC);

SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'integration_actions', 'integration_transformations', 'integration_workflows', 'integration_workflow_versions',
  'integration_nodes', 'integration_edges', 'integration_executions', 'integration_execution_steps',
  'integration_approval_bindings', 'integration_errors'
]::regclass[]) AS t;
