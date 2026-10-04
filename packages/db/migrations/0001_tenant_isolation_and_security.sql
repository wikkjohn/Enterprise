-- ═══════════════════════════════════════════════════════════════════════════
-- Tenant isolation (Row-Level Security), append-only audit, runtime role.
--
-- The application connects as a NON-superuser role that is a member of
-- eaop_runtime. Every transaction sets three transaction-local GUCs (see
-- packages/db/src/client.ts):
--   app.current_org_id   – active tenant (tenant scope)
--   app.current_user_id  – acting user (tenant or user scope)
--   app.system_context   – 'on' only for platform-level operations
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eaop_runtime') THEN
    CREATE ROLE eaop_runtime NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION eaop_current_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION eaop_current_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION eaop_is_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.system_context', true), '') = 'on'
$$;

-- Standard policy for a table with a NOT NULL organization_id column.
-- Module migrations MUST call this for every tenant-owned table:
--   SELECT eaop_enable_tenant_rls('workflows');
CREATE OR REPLACE FUNCTION eaop_enable_tenant_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (eaop_is_system() OR organization_id = eaop_current_org()) '
    'WITH CHECK (eaop_is_system() OR organization_id = eaop_current_org())', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO eaop_runtime', p_table);
END $$;

-- Policy for tables where organization_id NULL means a platform-provided row
-- (readable by every tenant, writable only in system scope).
CREATE OR REPLACE FUNCTION eaop_enable_shared_catalog_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS catalog_read ON %s', p_table);
  EXECUTE format('DROP POLICY IF EXISTS catalog_write ON %s', p_table);
  EXECUTE format('CREATE POLICY catalog_read ON %s FOR SELECT USING (eaop_is_system() OR organization_id IS NULL OR organization_id = eaop_current_org())', p_table);
  EXECUTE format('CREATE POLICY catalog_write ON %s FOR ALL USING (eaop_is_system() OR organization_id = eaop_current_org()) WITH CHECK (eaop_is_system() OR organization_id = eaop_current_org())', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO eaop_runtime', p_table);
END $$;

-- ── Strictly tenant-owned tables ────────────────────────────────────────────
SELECT eaop_enable_tenant_rls(t) FROM unnest(ARRAY[
  'organization_settings', 'organization_domains', 'organization_modules',
  'invitations', 'identity_providers', 'member_roles',
  'connectors', 'connector_capabilities', 'connector_credentials_metadata',
  'ai_runs', 'api_keys_metadata', 'webhooks', 'usage_events',
  'policies', 'policy_versions', 'notifications', 'notification_preferences',
  'idempotency_keys'
]::regclass[]) AS t;

-- ── Shared catalogs (platform rows + tenant rows) ───────────────────────────
SELECT eaop_enable_shared_catalog_rls(t) FROM unnest(ARRAY[
  'feature_flags', 'roles', 'ai_providers', 'ai_models'
]::regclass[]) AS t;

-- ── organizations ───────────────────────────────────────────────────────────
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON organizations FOR SELECT USING (
  eaop_is_system() OR id = eaop_current_org()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = eaop_current_user() AND m.status = 'active')
);
CREATE POLICY org_update ON organizations FOR UPDATE USING (eaop_is_system() OR id = eaop_current_org()) WITH CHECK (eaop_is_system() OR id = eaop_current_org());
CREATE POLICY org_insert ON organizations FOR INSERT WITH CHECK (eaop_is_system());
CREATE POLICY org_delete ON organizations FOR DELETE USING (eaop_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO eaop_runtime;

-- ── memberships: tenant rows, plus a user may read their own memberships ────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON memberships FOR SELECT USING (
  eaop_is_system() OR organization_id = eaop_current_org() OR user_id = eaop_current_user()
);
CREATE POLICY membership_write ON memberships FOR ALL USING (eaop_is_system() OR organization_id = eaop_current_org())
  WITH CHECK (eaop_is_system() OR organization_id = eaop_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO eaop_runtime;

-- ── users: visible to themselves and to organizations they belong to ────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_read ON users FOR SELECT USING (
  eaop_is_system() OR id = eaop_current_user()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = eaop_current_org())
);
CREATE POLICY user_update ON users FOR UPDATE USING (eaop_is_system() OR id = eaop_current_user())
  WITH CHECK (eaop_is_system() OR id = eaop_current_user());
CREATE POLICY user_insert ON users FOR INSERT WITH CHECK (eaop_is_system());
CREATE POLICY user_delete ON users FOR DELETE USING (eaop_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO eaop_runtime;

-- ── sessions / auth tokens: owner user or system ────────────────────────────
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'auth_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_only ON %I USING (eaop_is_system() OR user_id = eaop_current_user()) WITH CHECK (eaop_is_system() OR user_id = eaop_current_user())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO eaop_runtime', t);
  END LOOP;
END $$;

-- ── role_permissions: follows the role's ownership ──────────────────────────
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY rp_read ON role_permissions FOR SELECT USING (
  eaop_is_system() OR EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND (r.organization_id IS NULL OR r.organization_id = eaop_current_org()))
);
CREATE POLICY rp_write ON role_permissions FOR ALL USING (
  eaop_is_system() OR EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.organization_id = eaop_current_org())
) WITH CHECK (
  eaop_is_system() OR EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.organization_id = eaop_current_org())
);
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO eaop_runtime;

-- ── Platform catalogs: readable by all, writable only by system ─────────────
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['permissions', 'modules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY system_write ON %I FOR ALL USING (eaop_is_system()) WITH CHECK (eaop_is_system())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO eaop_runtime', t);
  END LOOP;
END $$;

-- ── Outbox / jobs / errors / dev secrets: tenants insert & read own; system manages ──
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['event_outbox', 'background_jobs_metadata', 'platform_errors', 'dev_secret_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (eaop_is_system() OR organization_id = eaop_current_org())', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (eaop_is_system() OR organization_id = eaop_current_org())', t);
    EXECUTE format('CREATE POLICY system_update ON %I FOR UPDATE USING (eaop_is_system()) WITH CHECK (eaop_is_system())', t);
    EXECUTE format('CREATE POLICY system_delete ON %I FOR DELETE USING (eaop_is_system())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO eaop_runtime', t);
  END LOOP;
END $$;

-- ═══ Append-only audit log ═════════════════════════════════════════════════
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT USING (eaop_is_system() OR organization_id = eaop_current_org());
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (eaop_is_system() OR organization_id = eaop_current_org());
GRANT SELECT, INSERT ON audit_events TO eaop_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM eaop_runtime;

CREATE OR REPLACE FUNCTION eaop_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention_purge', true) = 'on' AND current_user = (
    SELECT tableowner FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'audit_events'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION eaop_audit_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION eaop_audit_immutable();

-- Retention purge is the ONLY deletion path. Runs as the table owner
-- (SECURITY DEFINER) and enforces a 90-day floor.
CREATE OR REPLACE FUNCTION eaop_purge_audit_events(p_org uuid, p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n bigint;
BEGIN
  IF p_before > now() - interval '90 days' THEN
    RAISE EXCEPTION 'audit retention floor is 90 days';
  END IF;
  PERFORM set_config('app.audit_retention_purge', 'on', true);
  PERFORM set_config('app.system_context', 'on', true);
  DELETE FROM audit_events WHERE organization_id = p_org AND occurred_at < p_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.audit_retention_purge', '', true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION eaop_purge_audit_events(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eaop_purge_audit_events(uuid, timestamptz) TO eaop_runtime;

GRANT USAGE ON SCHEMA public TO eaop_runtime;
GRANT SELECT ON schema_migrations TO eaop_runtime;
