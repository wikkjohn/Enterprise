-- AI Knowledge & Verification — module-owned tables.
-- Every table is tenant-owned (organization_id) with forced RLS. Users,
-- organizations, connectors, AI runs and audit events stay in the shared
-- core and are referenced, never copied.

CREATE TABLE knowledge_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  stale_days integer NOT NULL DEFAULT 365 CHECK (stale_days BETWEEN 7 AND 3650),
  review_interval_days integer NOT NULL DEFAULT 365 CHECK (review_interval_days BETWEEN 7 AND 3650),
  store_questions boolean NOT NULL DEFAULT true,
  escalation_categories jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

-- Search/vector infrastructure behind an abstraction: one row per index an organization uses.
CREATE TABLE knowledge_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','building','failed')),
  document_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_built_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('upload','connector','api')),
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  authority text NOT NULL DEFAULT 'secondary' CHECK (authority IN ('authoritative','preferred','secondary','deprecated')),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department text,
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','confidential','restricted')),
  -- Who can retrieve documents that carry no ACL of their own (principals: org:*, user:<id>, role:<key>, dept:<name>).
  default_principals text[] NOT NULL DEFAULT '{org:*}',
  stale_days integer CHECK (stale_days BETWEEN 7 AND 3650),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  last_sync_at timestamptz(3),
  last_sync_status text CHECK (last_sync_status IN ('queued','running','succeeded','failed')),
  last_sync_message text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL,
  format text NOT NULL,
  source_url text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  owner_label text,
  department text,
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','confidential','restricted')),
  -- NULL = inherit the source's authority.
  authority text CHECK (authority IN ('authoritative','preferred','secondary','deprecated')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
  ingestion_status text NOT NULL DEFAULT 'pending' CHECK (ingestion_status IN ('pending','processing','indexed','failed')),
  ingestion_error text,
  ingestion_warnings text[] NOT NULL DEFAULT '{}',
  current_version integer NOT NULL DEFAULT 0,
  content_hash text,
  signature integer[] NOT NULL DEFAULT '{}',
  char_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  effective_date timestamptz(3),
  expiration_date timestamptz(3),
  review_due_at timestamptz(3),
  last_reviewed_at timestamptz(3),
  last_modified_at timestamptz(3),
  superseded_by_document_id uuid REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_id, external_id)
);
CREATE INDEX knowledge_documents_status_idx ON knowledge_documents (organization_id, status, ingestion_status);
CREATE INDEX knowledge_documents_hash_idx ON knowledge_documents (organization_id, content_hash);

CREATE TABLE knowledge_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content_hash text NOT NULL,
  char_count integer NOT NULL,
  chunk_count integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_summary text NOT NULL DEFAULT '',
  ingested_by text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  ordinal integer NOT NULL,
  heading text,
  text text NOT NULL,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  content_hash text NOT NULL,
  -- Default index provider (postgres_fts). Other providers keep their own index and are referenced in knowledge_indexes.
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || text)) STORED,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (document_id, version, ordinal)
);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);

CREATE TABLE knowledge_permissions_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL UNIQUE REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('source_default','source_acl','explicit')),
  -- ACL as reported by the source system (identities, groups, links) — for display and audit.
  raw_acl jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Principals that may retrieve the document. Retrieval requires an overlap with the caller's principals.
  principals text[] NOT NULL DEFAULT '{}',
  unmapped jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_permissions_principals_idx ON knowledge_permissions_metadata USING gin (principals);

CREATE TABLE knowledge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('duplicate','near_duplicate','newer_version','contradiction')),
  document_a_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  document_b_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  similarity numeric(5,4) NOT NULL DEFAULT 0,
  newer text CHECK (newer IN ('a','b')),
  detail text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution text CHECK (resolution IN ('keep_a','keep_b','both_valid','not_a_conflict')),
  resolution_note text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz(3),
  detected_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (document_a_id, document_b_id, kind)
);
CREATE INDEX knowledge_conflicts_open_idx ON knowledge_conflicts (organization_id, status);

CREATE TABLE knowledge_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department text,
  source_module text NOT NULL DEFAULT 'knowledge_verification',
  -- NULL when the organization does not retain question text.
  question text,
  normalized text,
  question_hash text NOT NULL,
  categories text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('answered','unanswered','escalated','failed')),
  retrieved_count integer NOT NULL DEFAULT 0,
  top_score numeric(6,4) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_queries_org_idx ON knowledge_queries (organization_id, created_at DESC);

CREATE TABLE knowledge_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  query_id uuid NOT NULL UNIQUE REFERENCES knowledge_queries(id) ON DELETE CASCADE,
  response text,
  mode text NOT NULL CHECK (mode IN ('generative','extractive','none')),
  mode_note text,
  ai_run_id uuid,
  model text,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low','insufficient')),
  confidence_factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_summary text NOT NULL,
  uncertainty text,
  escalated boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  answer_id uuid NOT NULL REFERENCES knowledge_answers(id) ON DELETE CASCADE,
  marker text NOT NULL,
  document_id uuid REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  chunk_id uuid REFERENCES knowledge_chunks(id) ON DELETE SET NULL,
  document_version integer NOT NULL,
  title text NOT NULL,
  authority text NOT NULL,
  freshness text NOT NULL,
  document_date timestamptz(3),
  score numeric(6,4) NOT NULL,
  cited boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_citations_doc_idx ON knowledge_citations (organization_id, document_id);

CREATE TABLE knowledge_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  answer_id uuid NOT NULL REFERENCES knowledge_answers(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  text text,
  important boolean NOT NULL DEFAULT false,
  cited text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE knowledge_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL UNIQUE REFERENCES knowledge_claims(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('VERIFIED','PARTIALLY_VERIFIED','UNSUPPORTED','CONTRADICTED')),
  explanation text NOT NULL,
  supporting text[] NOT NULL DEFAULT '{}',
  contradicting text[] NOT NULL DEFAULT '{}',
  coverage numeric(5,4) NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('escalation','stale','expired','no_owner','review_due','conflict')),
  document_id uuid REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  query_id uuid REFERENCES knowledge_queries(id) ON DELETE CASCADE,
  conflict_id uuid REFERENCES knowledge_conflicts(id) ON DELETE CASCADE,
  category text,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','dismissed')),
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz(3),
  dedupe_key text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX knowledge_reviews_open_idx ON knowledge_reviews (organization_id, status, kind);

SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'knowledge_settings', 'knowledge_indexes', 'knowledge_sources', 'knowledge_documents', 'knowledge_document_versions', 'knowledge_chunks',
  'knowledge_permissions_metadata', 'knowledge_conflicts', 'knowledge_queries', 'knowledge_answers', 'knowledge_citations', 'knowledge_claims',
  'knowledge_verifications', 'knowledge_reviews'
]::regclass[]) AS t;
