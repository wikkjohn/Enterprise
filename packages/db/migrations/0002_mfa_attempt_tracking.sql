-- Per-session multi-factor attempt counter, so TOTP verification can be locked
-- out after repeated failures independently of the per-IP request rate limit.
-- The column lives on the (already RLS-protected, already granted) sessions table.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_failed_count integer NOT NULL DEFAULT 0;
