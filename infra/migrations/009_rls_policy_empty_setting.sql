-- Migration 009: make every RLS policy tolerate an empty app.tenant_id
-- =========================================================
-- The policies written in 005, 006 and 007 all cast the setting directly:
--
--   USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
--
-- `current_setting(name, true)` returns NULL only while the setting has never
-- been touched in that session. After a transaction-local
-- `set_config('app.tenant_id', <uuid>, true)` the custom GUC *exists*, and once
-- that transaction ends the session reports it as an **empty string** rather
-- than NULL:
--
--   SELECT set_config('app.tenant_id','probe-value',true);   -- one transaction
--   SELECT coalesce(current_setting('app.tenant_id', true), '<<NULL>>');
--   -- => (empty), not <<NULL>>
--
-- Because the connection is pooled, one tenant-scoped query poisons every later
-- query that runs without a context on the same connection: instead of denying
-- the rows, the policy raises
--
--   invalid input syntax for type uuid: ""
--
-- which surfaces as a 500 from an operation that has no rows to deny at all.
-- `nullif(..., '')` restores the intended "no tenant => no rows" behaviour and
-- makes it independent of connection history.
-- =========================================================

-- 005: users, flows, flow_nodes, knowledge_base_documents, conversation_logs
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON flows;
CREATE POLICY tenant_isolation ON flows
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON flow_nodes;
CREATE POLICY tenant_isolation ON flow_nodes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON knowledge_base_documents;
CREATE POLICY tenant_isolation ON knowledge_base_documents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON conversation_logs;
CREATE POLICY tenant_isolation ON conversation_logs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 006: message_statuses
DROP POLICY IF EXISTS tenant_isolation ON message_statuses;
CREATE POLICY tenant_isolation ON message_statuses
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 007: tenants (USING doubles as the INSERT/UPDATE check here)
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
