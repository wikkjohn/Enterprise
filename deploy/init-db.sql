-- Local/compose bootstrap: owner role for migrations, NON-superuser runtime role.
CREATE ROLE eaop_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'eaop_app';
-- After migrations create the eaop_runtime group role, compose runs:
--   GRANT eaop_runtime TO eaop_app;
