-- Migration 006: message_statuses + schema drift repairs
-- =========================================================
-- Adds first-class storage for Meta delivery/read/failure callbacks
-- (the `statuses` array of the WhatsApp webhook payload), and repairs
-- column drift between the Python services and the SQL schema.
--
-- Idempotent: safe to re-run.
-- =========================================================

-- =========================================================
-- MESSAGE STATUSES (tenant-scoped, RLS enforced)
-- =========================================================
CREATE TABLE IF NOT EXISTS message_statuses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  wamid             TEXT        NOT NULL,
  status            TEXT        NOT NULL
                    CHECK (status IN (
                      'sent', 'delivered', 'read', 'failed',
                      'deleted', 'warning', 'unknown'
                    )),
  recipient_id      TEXT,
  occurred_at       TIMESTAMPTZ,
  error_code        TEXT,
  error_title       TEXT,
  conversation_id   TEXT,
  pricing_category  TEXT,
  raw               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_statuses_dedupe
    UNIQUE (tenant_id, wamid, status, occurred_at)
);

CREATE INDEX IF NOT EXISTS idx_message_statuses_tenant_wamid
  ON message_statuses (tenant_id, wamid);

CREATE INDEX IF NOT EXISTS idx_message_statuses_tenant_time
  ON message_statuses (tenant_id, created_at DESC);

-- =========================================================
-- SCHEMA DRIFT REPAIRS
-- =========================================================
-- knowledge_base_documents: rag-indexer sets updated_at on every status
-- transition (services/rag-indexer/.../postgres_repo.py) but the column
-- was never created in migration 003.
ALTER TABLE knowledge_base_documents
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- conversation_logs: the flow-engine INSERT references node_key and must
-- supply message_type/content (both NOT NULL in migration 004). Widen
-- message_type so non-Meta node output can also be recorded, and give
-- content a default so callers that intentionally store no body still work.
ALTER TABLE conversation_logs
  ALTER COLUMN message_type SET DEFAULT 'text';

ALTER TABLE conversation_logs
  ALTER COLUMN content SET DEFAULT '{}'::jsonb;

-- =========================================================
-- RLS for the new table (mirrors migration 005)
-- =========================================================
ALTER TABLE message_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_statuses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON message_statuses;

CREATE POLICY tenant_isolation ON message_statuses
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
