-- AI Data Security — module-owned tables.
-- Every table is tenant-owned (organization_id) with forced RLS. Users,
-- organizations, connectors, policies, secrets and audit events stay in the
-- shared core and are referenced, never copied.
--
-- Privacy: no table stores raw sensitive content. Classifications keep
-- counts, confidence and basis; DLP events keep an HMAC fingerprint, the
-- category summary and (only when retention allows) a label-redacted preview.

CREATE TABLE data_security_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- none: fingerprints + classification only; redacted_preview: also a short label-redacted preview.
  content_retention text NOT NULL DEFAULT 'redacted_preview' CHECK (content_retention IN ('none','redacted_preview')),
  large_export_chars integer NOT NULL DEFAULT 100000 CHECK (large_export_chars BETWEEN 1000 AND 100000000),
  abnormal_blocked_per_hour integer NOT NULL DEFAULT 5 CHECK (abnormal_blocked_per_hour BETWEEN 2 AND 10000),
  broad_group_size integer NOT NULL DEFAULT 500 CHECK (broad_group_size BETWEEN 10 AND 10000000),
  -- Shared secret-store reference for the HMAC key used by tokenization and fingerprints.
  tokenization_secret_ref text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

-- Custom classifications and per-category DLP actions (built-in categories may be overridden here too).
CREATE TABLE data_classification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  builtin boolean NOT NULL DEFAULT false,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  sensitivity text NOT NULL DEFAULT 'confidential' CHECK (sensitivity IN ('public','internal','confidential','restricted')),
  patterns text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  confidence text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  action_approved text NOT NULL CHECK (action_approved IN ('ALLOW','REDACT','REQUIRE_APPROVAL','BLOCK')),
  action_unapproved text NOT NULL CHECK (action_unapproved IN ('ALLOW','REDACT','REQUIRE_APPROVAL','BLOCK')),
  min_confidence text NOT NULL DEFAULT 'medium' CHECK (min_confidence IN ('low','medium','high')),
  redaction_mode text NOT NULL DEFAULT 'label' CHECK (redaction_mode IN ('mask','tokenize','label')),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE data_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('connector','api')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  assets_seen integer NOT NULL DEFAULT 0,
  assets_classified integer NOT NULL DEFAULT 0,
  findings_opened integer NOT NULL DEFAULT 0,
  error_message text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz(3),
  finished_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX data_scans_org_idx ON data_scans (organization_id, created_at DESC);

CREATE TABLE data_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  source_system text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  asset_type text NOT NULL DEFAULT 'file',
  location text NOT NULL DEFAULT '',
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  owner_label text,
  department text,
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','confidential','restricted')),
  classification_locked boolean NOT NULL DEFAULT false,
  categories text[] NOT NULL DEFAULT '{}',
  permissions jsonb NOT NULL DEFAULT '{"scope":"private"}'::jsonb,
  sharing_scope text NOT NULL DEFAULT 'private' CHECK (sharing_scope IN ('private','specific','group','organization','public')),
  last_modified_at timestamptz(3),
  last_accessed_at timestamptz(3),
  retention_category text,
  ai_exposure_status text NOT NULL DEFAULT 'none' CHECK (ai_exposure_status IN ('none','potential','observed')),
  content_fingerprint text,
  size_bytes bigint,
  discovered_via text NOT NULL CHECK (discovered_via IN ('connector','api','manual')),
  current_version integer NOT NULL DEFAULT 1,
  last_scan_id uuid REFERENCES data_scans(id) ON DELETE SET NULL,
  last_classified_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_system, external_id)
);
CREATE INDEX data_assets_class_idx ON data_assets (organization_id, classification);

CREATE TABLE data_asset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES data_assets(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version)
);

CREATE TABLE data_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES data_assets(id) ON DELETE CASCADE,
  category text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('public','internal','confidential','restricted')),
  detection_method text NOT NULL CHECK (detection_method IN ('pattern','checksum','keyword','heuristic','custom','manual')),
  detectors text[] NOT NULL DEFAULT '{}',
  confidence text NOT NULL CHECK (confidence IN ('low','medium','high')),
  confidence_basis text NOT NULL,
  match_count integer NOT NULL DEFAULT 0,
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','confirmed','rejected')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz(3),
  scan_id uuid REFERENCES data_scans(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (asset_id, category)
);

CREATE TABLE data_access_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES data_assets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('public_link','organization_wide','stale_user','overly_broad_group','departed_user','inherited_access','sensitive_broad_access','no_owner')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  principal text NOT NULL DEFAULT '',
  detail text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted')),
  resolution_note text,
  first_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  resolved_at timestamptz(3),
  UNIQUE (asset_id, kind, principal)
);
CREATE INDEX data_access_findings_open_idx ON data_access_findings (organization_id, status, severity);

CREATE TABLE shadow_ai_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  catalog_key text,
  vendor text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  domains text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('approved','experimental','unknown','restricted','blocked')),
  source text NOT NULL CHECK (source IN ('telemetry','manual','platform')),
  user_count integer NOT NULL DEFAULT 0,
  departments text[] NOT NULL DEFAULT '{}',
  data_categories text[] NOT NULL DEFAULT '{}',
  risk_score integer NOT NULL DEFAULT 0,
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high','critical')),
  risk_factors text[] NOT NULL DEFAULT '{}',
  notes text NOT NULL DEFAULT '',
  status_changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status_changed_at timestamptz(3),
  first_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, vendor, name)
);

CREATE TABLE shadow_ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tool_id uuid NOT NULL REFERENCES shadow_ai_tools(id) ON DELETE CASCADE,
  telemetry_source text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- HMAC of the user identifier when it is not a platform user (no raw external identifiers).
  user_fingerprint text,
  department text,
  domain text,
  event_count integer NOT NULL DEFAULT 1,
  bytes_out bigint,
  data_categories text[] NOT NULL DEFAULT '{}',
  external_ref text,
  occurred_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX shadow_ai_usage_tool_idx ON shadow_ai_usage (organization_id, tool_id, occurred_at DESC);
CREATE UNIQUE INDEX shadow_ai_usage_ref_uq ON shadow_ai_usage (organization_id, telemetry_source, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE ai_exposure_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES data_assets(id) ON DELETE CASCADE,
  exposure_type text NOT NULL CHECK (exposure_type IN ('approved_ai','unapproved_ai','enterprise_copilot','agent','external_model_api','employee_ai_tool')),
  tool_id uuid REFERENCES shadow_ai_tools(id) ON DELETE SET NULL,
  destination text NOT NULL DEFAULT '',
  basis text NOT NULL CHECK (basis IN ('inferred','observed')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  detail text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted')),
  first_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (asset_id, exposure_type, basis, destination)
);

CREATE TABLE security_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('unauthorized_ai','credential_exposure','large_ai_export','restricted_data_access','abnormal_ai_activity','policy_violation','manual')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','contained','resolved')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  source text NOT NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  affected_asset_ids uuid[] NOT NULL DEFAULT '{}',
  affected_users text[] NOT NULL DEFAULT '{}',
  root_cause text,
  resolution text,
  remediation text,
  dedupe_key text,
  event_count integer NOT NULL DEFAULT 1,
  opened_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX security_incidents_open_idx ON security_incidents (organization_id, status, severity);
CREATE INDEX security_incidents_dedupe_idx ON security_incidents (organization_id, dedupe_key) WHERE status <> 'resolved';

CREATE TABLE incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL REFERENCES security_incidents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('created','evidence','note','status_change','assignment','remediation','severity_change')),
  message text NOT NULL,
  data jsonb,
  actor_label text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, created_at);

CREATE TABLE dlp_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ai_gateway','api')),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  actor_label text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  destination text NOT NULL,
  destination_trust text NOT NULL,
  destination_category text NOT NULL,
  tool_id uuid REFERENCES shadow_ai_tools(id) ON DELETE SET NULL,
  module_id text,
  use_case text,
  decision text NOT NULL CHECK (decision IN ('ALLOW','REDACT','REQUIRE_APPROVAL','BLOCK')),
  reasons text[] NOT NULL DEFAULT '{}',
  detections jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories text[] NOT NULL DEFAULT '{}',
  policies jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_fingerprint text NOT NULL,
  content_chars integer NOT NULL,
  redacted_preview text,
  asset_ids uuid[] NOT NULL DEFAULT '{}',
  approval_status text CHECK (approval_status IN ('pending','approved','rejected','expired','used')),
  approval_decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approval_decided_at timestamptz(3),
  approval_note text,
  approval_expires_at timestamptz(3),
  approved_via uuid REFERENCES dlp_events(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES security_incidents(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX dlp_events_org_idx ON dlp_events (organization_id, created_at DESC);
CREATE INDEX dlp_events_approval_idx ON dlp_events (organization_id, actor_id, destination, content_fingerprint) WHERE approval_status = 'approved';

CREATE TABLE redaction_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dlp_event_id uuid NOT NULL REFERENCES dlp_events(id) ON DELETE CASCADE,
  modes text[] NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',
  by_label jsonb NOT NULL DEFAULT '{}'::jsonb,
  redacted_count integer NOT NULL,
  output_fingerprint text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE remediation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('remove_broad_sharing','restrict_group','change_classification','assign_owner','block_ai_destination','require_approval','rotate_credential')),
  -- automatic: applied inside the platform; manual: performed in the source system and attested here.
  execution text NOT NULL CHECK (execution IN ('automatic','manual')),
  status text NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended','completed','dismissed','failed')),
  asset_id uuid REFERENCES data_assets(id) ON DELETE CASCADE,
  tool_id uuid REFERENCES shadow_ai_tools(id) ON DELETE CASCADE,
  incident_id uuid REFERENCES security_incidents(id) ON DELETE SET NULL,
  finding_type text CHECK (finding_type IN ('access','exposure','incident','classification')),
  finding_id uuid,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  result text,
  dedupe_key text NOT NULL,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX remediation_actions_status_idx ON remediation_actions (organization_id, status);

SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'data_security_settings', 'data_classification_rules', 'data_scans', 'data_assets', 'data_asset_versions', 'data_classifications',
  'data_access_findings', 'shadow_ai_tools', 'shadow_ai_usage', 'ai_exposure_findings', 'security_incidents', 'incident_events',
  'dlp_events', 'redaction_events', 'remediation_actions'
]::regclass[]) AS t;
