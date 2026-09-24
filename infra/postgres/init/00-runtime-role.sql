-- Runtime role provisioning, run once by the postgres entrypoint
-- =========================================================
-- The application previously connected as `app_user`, which docker's
-- POSTGRES_USER makes the *bootstrap superuser*. Postgres lets superusers bypass
-- row security unconditionally, so every RLS policy in infra/migrations —
-- including the FORCE ROW LEVEL SECURITY from 005 — was inert at runtime: tenant
-- isolation rested entirely on the application remembering a WHERE clause.
--
-- The bootstrap superuser cannot be demoted ("The bootstrap user must have the
-- SUPERUSER attribute"), so the fix is a second role:
--
--   app_user              bootstrap superuser — owns the schema, runs migrations
--                         (DATABASE_MIGRATION_URL), never used at runtime
--   app_runtime           NOSUPERUSER NOBYPASSRLS — DATABASE_URL for every service
--   tenant_lookup_owner   NOLOGIN BYPASSRLS — owns the cross-tenant lookup
--                         functions created in migration 007
--
-- Init scripts only run on an empty data directory. For an existing cluster,
-- migration 008 creates the role and the grants; set its password with
-- ALTER ROLE app_runtime PASSWORD '...'.
-- =========================================================

\getenv runtime_password POSTGRES_RUNTIME_PASSWORD
\if :{?runtime_password}
\else
\echo 'FATAL: POSTGRES_RUNTIME_PASSWORD is not set. It becomes the password of the'
\echo 'runtime role (DATABASE_URL); refusing to start with a guessable default.'
\quit 1
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_lookup_owner') THEN
    CREATE ROLE tenant_lookup_owner NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE tenant_lookup_owner NOLOGIN BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- psql variables are interpolated as literals here, so the password never
-- appears in a shell argv or a log line.
ALTER ROLE app_runtime PASSWORD :'runtime_password';

-- The runtime role needs to read and write rows, and to reach the sequences
-- behind the id defaults. It gets DML only: no DDL, so a compromised runtime
-- credential cannot alter policies or tables.
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Migrations run as app_user, so objects created later are owned by app_user.
-- Without this, every new table would need a manual grant before the service
-- could touch it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- So migration 007 can hand the lookup functions to tenant_lookup_owner.
GRANT tenant_lookup_owner TO app_user;
