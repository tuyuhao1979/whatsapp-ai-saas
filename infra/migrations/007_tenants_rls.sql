-- Migration 007: Row Level Security on `tenants`
-- =========================================================
-- Migration 005 deliberately left `tenants` out ("platform-level table; access
-- controlled at application layer"). That left the table holding the encrypted
-- WhatsApp access token, the WABA id and the phone-number binding readable and
-- writable across tenants by any query that omitted or got wrong its WHERE
-- clause — one missing predicate away from cross-tenant credential exposure.
-- This migration puts it under the same policy as every other tenant-scoped
-- table.
--
-- Two reads legitimately cross tenants and cannot use `app.tenant_id`:
--   * login resolves a tenant from its slug (no tenant context exists yet);
--   * the gateway / onboarding resolves a tenant from a phone number id, which
--     is how an inbound webhook finds its owner.
-- Both go through SECURITY DEFINER functions below instead of a relaxed policy.
--
-- Why the functions need a dedicated owner: `tenants` is FORCE ROW LEVEL
-- SECURITY, so the table owner (the role that ran this migration) does not
-- bypass the policy either — a SECURITY DEFINER function owned by it would
-- return zero rows. They are therefore owned by a NOLOGIN role that has
-- BYPASSRLS, and are granted only column-level SELECT on the columns they read.
-- Neither function returns the access token.
-- =========================================================

-- 1. Lookup-owner role. ------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_lookup_owner') THEN
    CREATE ROLE tenant_lookup_owner NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  ALTER ROLE tenant_lookup_owner BYPASSRLS;
EXCEPTION WHEN insufficient_privilege THEN
  -- Failing loudly on purpose: continuing would silently leave login and
  -- webhook routing unable to find a tenant, which looks like "no such
  -- account" rather than a misconfigured database.
  RAISE EXCEPTION
    'Cannot grant BYPASSRLS to tenant_lookup_owner. Run migrations as a superuser '
    'or pre-provision a BYPASSRLS role. Refusing to continue.';
END
$$;

-- Column-level grants only: the owner is never used directly, and the
-- functions must not be able to read more than they return.
GRANT SELECT (id, slug, status) ON tenants TO tenant_lookup_owner;
GRANT SELECT (id, phone_number_id, access_token) ON tenants TO tenant_lookup_owner;

-- 2. RLS on tenants. ---------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);

-- 3. Sanctioned cross-tenant lookups. ----------------------------------
-- Output columns are named distinctly from the table's columns to keep the
-- bodies unambiguous.

CREATE OR REPLACE FUNCTION lookup_tenant_by_slug(p_slug text)
RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.slug, t.status
    FROM tenants t
   WHERE t.slug = p_slug
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION tenant_id_for_phone(p_phone_number_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id
    FROM tenants t
   WHERE t.phone_number_id = p_phone_number_id
   LIMIT 1
$$;

-- Used by services/tenant-api/src/scripts/reencryptAccessTokens.ts to find the
-- rows that need rewriting. Returns identifiers only: the ciphertext is read
-- per tenant, under that tenant's own RLS context.
CREATE OR REPLACE FUNCTION list_bound_tenants()
RETURNS TABLE (tenant_id uuid, phone_number_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.phone_number_id
    FROM tenants t
   WHERE t.access_token IS NOT NULL
     AND t.phone_number_id IS NOT NULL
   ORDER BY t.id
$$;

ALTER FUNCTION lookup_tenant_by_slug(text) OWNER TO tenant_lookup_owner;
ALTER FUNCTION tenant_id_for_phone(text) OWNER TO tenant_lookup_owner;
ALTER FUNCTION list_bound_tenants() OWNER TO tenant_lookup_owner;
