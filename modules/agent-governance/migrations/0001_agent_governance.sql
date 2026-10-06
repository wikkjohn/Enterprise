-- AI Agent Governance — module-owned tables.
-- Every table is tenant-owned (organization_id) with forced RLS. Users,
-- organizations, connectors, API keys (agent credentials), secrets, policies
-- and audit events stay in the shared core and are referenced, never copied.

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Identifier the agent presents to other systems (e.g. an unverified claim seen by the AI tool gateway).
  external_id text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department text,
  business_purpose text NOT NULL DEFAULT '',
  environment text NOT NULL DEFAULT 'development' CHECK (environment IN ('development','staging','production')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('unknown','pending','approved','restricted','suspended','retired')),
  quarantined boolean NOT NULL DEFAULT false,
  provider text,
  model text,
  autonomy_level text NOT NULL DEFAULT 'supervised' CHECK (autonomy_level IN ('assistive','supervised','semi_autonomous','autonomous')),
  risk_category text NOT NULL DEFAULT 'medium' CHECK (risk_category IN ('low','medium','high','critical')),
  connected_systems text[] NOT NULL DEFAULT '{}',
  blocked_connector_ids uuid[] NOT NULL DEFAULT '{}',
  customer_impact integer CHECK (customer_impact BETWEEN 1 AND 5),
  regulatory_impact integer CHECK (regulatory_impact BETWEEN 1 AND 5),
  discovered_via text NOT NULL DEFAULT 'manual' CHECK (discovered_via IN ('manual','api','integration')),
  current_version integer NOT NULL DEFAULT 1,
  last_activity_at timestamptz(3),
  last_review_at timestamptz(3),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz(3),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
CREATE UNIQUE INDEX agents_external_uq ON agents (organization_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX agents_status_idx ON agents (organization_id, status);

CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

-- Credentials live in the shared core: platform API keys (hashed) or secret-store references. Never plaintext here.
CREATE TABLE agent_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('api_key','oauth_client','certificate','external')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  api_key_id uuid UNIQUE REFERENCES api_keys_metadata(id) ON DELETE SET NULL,
  secret_ref text,
  fingerprint text,
  issuer text,
  subject text,
  scopes text[] NOT NULL DEFAULT '{}',
  environment text NOT NULL CHECK (environment IN ('development','staging','production')),
  expires_at timestamptz(3),
  last_used_at timestamptz(3),
  revoked_at timestamptz(3),
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_identities_agent_idx ON agent_identities (agent_id);

-- Least privilege: an agent may do nothing that no active binding grants.
CREATE TABLE agent_permission_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('READ','WRITE','CREATE','UPDATE','DELETE','SEND','EXECUTE','APPROVE','EXPORT')),
  system text NOT NULL DEFAULT '*',
  connector_id uuid REFERENCES connectors(id) ON DELETE CASCADE,
  resource text NOT NULL DEFAULT '*',
  environment text NOT NULL DEFAULT 'any' CHECK (environment IN ('any','development','staging','production')),
  max_data_sensitivity text NOT NULL DEFAULT 'internal' CHECK (max_data_sensitivity IN ('public','internal','confidential','restricted')),
  financial_limit numeric(18,2) CHECK (financial_limit >= 0),
  time_window jsonb,
  conditions jsonb,
  requires_approval boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  description text NOT NULL DEFAULT '',
  expires_at timestamptz(3),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_bindings_agent_idx ON agent_permission_bindings (agent_id, status);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  external_ref text,
  on_behalf_of_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  instruction text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','failed','terminated')),
  started_at timestamptz(3) NOT NULL DEFAULT now(),
  ended_at timestamptz(3),
  last_event_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_sessions_agent_idx ON agent_sessions (organization_id, agent_id, started_at DESC);

-- Chronological activity timeline (content subject to the org's retention settings).
CREATE TABLE agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  request_id uuid,
  kind text NOT NULL CHECK (kind IN ('instruction','tool_call','system_access','resource_access','action_proposed','policy_decision','approval','action_executed','error','output','emergency')),
  source text NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','platform','integration')),
  system text,
  resource text,
  action_type text,
  decision text,
  summary text NOT NULL,
  detail jsonb,
  occurred_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_actions_timeline_idx ON agent_actions (organization_id, agent_id, occurred_at DESC);
CREATE INDEX agent_actions_session_idx ON agent_actions (session_id, occurred_at);

CREATE TABLE agent_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  action text NOT NULL,
  system text NOT NULL,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  resource text NOT NULL DEFAULT '*',
  environment text NOT NULL,
  data_sensitivity text NOT NULL,
  amount numeric(18,2),
  currency text,
  context jsonb NOT NULL DEFAULT '{}',
  decision text NOT NULL CHECK (decision IN ('ALLOW','DENY','REQUIRE_APPROVAL','ESCALATE')),
  status text NOT NULL CHECK (status IN ('allowed','denied','pending_approval','approved','rejected','clarification_requested','escalated','executed','failed','expired','cancelled')),
  reasons text[] NOT NULL DEFAULT '{}',
  binding_id uuid REFERENCES agent_permission_bindings(id) ON DELETE SET NULL,
  idempotency_key text,
  result jsonb,
  executed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_requests_idem_uq ON agent_action_requests (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX agent_requests_list_idx ON agent_action_requests (organization_id, created_at DESC);

-- Every evaluation is logged — direct requests, Integration tool calls and simulations.
CREATE TABLE agent_policy_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  request_id uuid REFERENCES agent_action_requests(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('direct','integration','simulation')),
  input jsonb NOT NULL,
  effect text NOT NULL CHECK (effect IN ('ALLOW','DENY','REQUIRE_APPROVAL','ESCALATE')),
  reasons text[] NOT NULL DEFAULT '{}',
  matched_bindings uuid[] NOT NULL DEFAULT '{}',
  policies jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_evals_idx ON agent_policy_evaluations (organization_id, agent_id, created_at DESC);

CREATE TABLE agent_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE REFERENCES agent_action_requests(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','clarification_requested','escalated','expired','cancelled')),
  reason text NOT NULL,
  affected_systems text[] NOT NULL DEFAULT '{}',
  affected_records jsonb,
  financial_impact numeric(18,2),
  data_sensitivity text NOT NULL,
  policy jsonb NOT NULL,
  supporting_context jsonb,
  escalation_level integer NOT NULL DEFAULT 0,
  conversation jsonb NOT NULL DEFAULT '[]',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz(3),
  decision_note text,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_approvals_status_idx ON agent_approvals (organization_id, status, created_at DESC);

CREATE TABLE agent_risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  score numeric(5,1) NOT NULL,
  band text NOT NULL,
  components jsonb NOT NULL,
  explanation text NOT NULL,
  computed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  computed_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_risk_idx ON agent_risk_assessments (agent_id, computed_at DESC);

CREATE TABLE agent_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('kill_switch','policy_violation','manual')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  actions_taken jsonb NOT NULL DEFAULT '[]',
  related_request_id uuid REFERENCES agent_action_requests(id) ON DELETE SET NULL,
  opened_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz(3),
  resolution text,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_incidents_idx ON agent_incidents (organization_id, status, created_at DESC);

CREATE TABLE agent_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  review_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  agent_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at timestamptz(3) NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  purpose_valid boolean,
  permissions_valid boolean,
  systems_required boolean,
  risk_status text,
  outcome text CHECK (outcome IN ('approved','changes_required','restricted','retired')),
  notes text,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX agent_reviews_due_idx ON agent_reviews (organization_id, status, due_at);

SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'agents', 'agent_versions', 'agent_identities', 'agent_permission_bindings', 'agent_sessions', 'agent_actions',
  'agent_action_requests', 'agent_policy_evaluations', 'agent_approvals', 'agent_risk_assessments', 'agent_incidents', 'agent_reviews'
]::regclass[]) AS t;
