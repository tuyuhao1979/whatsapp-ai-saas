-- Migration 008: runtime role grants for existing clusters
-- =========================================================
-- infra/postgres/init/00-runtime-role.sql provisions `app_runtime` when the
-- database is created. A database that already exists never runs init scripts
-- again, so this migration brings it to the same state: the runtime role exists,
-- is explicitly not a superuser and cannot bypass RLS, and holds DML (never DDL)
-- privileges on the schema.
--
-- The password is deliberately not set here — migrations are plain SQL files
-- without access to the environment. After this migration, set it once:
--
--   ALTER ROLE app_runtime PASSWORD '<from POSTGRES_RUNTIME_PASSWORD>';
--
-- then point DATABASE_URL at `app_runtime` and leave DATABASE_MIGRATION_URL on
-- the owning superuser role, which is what actually makes the RLS policies in
-- migrations 005 and 007 apply to the running service.
-- =========================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
    RAISE NOTICE 'app_runtime created without a password. Set it with ALTER ROLE app_runtime PASSWORD ...';
  ELSE
    -- Guard against a role that was created permissive by an earlier deployment.
    ALTER ROLE app_runtime NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Lets migration 007 (already applied on an existing cluster) be re-run to hand
-- the lookup functions to tenant_lookup_owner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_lookup_owner') THEN
    EXECUTE 'GRANT tenant_lookup_owner TO app_user';
  END IF;
END
$$;
