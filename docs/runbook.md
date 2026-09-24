# Operations Runbook

## Local Development

### Starting the stack

```bash
# Full stack (infrastructure + services) in one command
make dev

# Or step by step:
make infra-up    # postgres, redis, chromadb, minio
make wait-infra  # waits until postgres is healthy (~10s)
make migrate     # applies all SQL migrations via prisma
make app-up      # gateway, tenant-api, flow-engine, rag-indexer

# Seed a test tenant + flow + knowledge base
make seed
# Prints: tenant ID, user credentials (demo@local / demo1234), JWT token
```

### Resetting the database

```bash
# Stop services, remove volumes, restart fresh
make down
docker volume rm whatsapp-ai-saas_pg_data whatsapp-ai-saas_chroma_data whatsapp-ai-saas_minio_data
make infra-up
make wait-infra
make migrate
make seed
```

### Viewing logs per service

```bash
make logs SERVICE=gateway
make logs SERVICE=tenant-api
make logs SERVICE=flow-engine
make logs SERVICE=rag-indexer
make logs SERVICE=postgres
make logs SERVICE=redis

# Follow all services
docker compose -f infra/docker-compose.yml logs -f

# Filter flow-engine logs for a specific tenant
docker compose -f infra/docker-compose.yml logs -f flow-engine | grep '"tenant_id":"<uuid>"'
```

### Accessing PostgreSQL directly

```bash
make psql
# Equivalent: docker compose -f infra/docker-compose.yml exec postgres psql -U app_user saas

# Inspect conversation logs
SELECT direction, content->>'body' AS body, created_at FROM conversation_logs ORDER BY created_at DESC LIMIT 20;

# Check RLS (should only see rows for the current tenant_id GUC)
SELECT set_config('app.tenant_id', '<tenant-uuid>', true);
SELECT id, name, is_active FROM flows;
```

### Accessing Redis directly

```bash
make redis-cli
# Equivalent: docker compose -f infra/docker-compose.yml exec redis redis-cli

# Inspect a session
HGETALL session:<tenant_id>:<wa_id>

# Check stream lag for a tenant
XINFO GROUPS flow-engine:<tenant_id>

# List all flow-engine streams
KEYS flow-engine:*

# Inspect pending entries list (messages in-flight or stuck)
XPENDING flow-engine:<tenant_id> flow-engine-workers - + 10
```

### Accessing ChromaDB directly

ChromaDB requires the bearer token (`CHROMA_AUTH_TOKEN` in `infra/.env`). Every
route except `/api/v1/heartbeat` answers `403` without it — the heartbeat is
what the compose healthcheck polls, so liveness can still be checked
anonymously.

```bash
# ChromaDB HTTP API on port 8000 (internal network) or 18000 (host, if mapped in docker-compose)
curl -H "Authorization: Bearer <CHROMA_AUTH_TOKEN>" http://localhost:18000/api/v1/collections

# Count vectors in a tenant's collection
curl -H "Authorization: Bearer <CHROMA_AUTH_TOKEN>" \
  "http://localhost:18000/api/v1/collections/tenant_<tenant_id_no_hyphens>/count"
```

---

## Production Deployment (Single VPS)

### Prerequisites

- Ubuntu 22.04 / Debian 12 VPS (4 vCPU / 8 GB RAM minimum)
- Docker Engine 24+ and Docker Compose v2
- A domain pointed at the VPS IP (A record, TTL 300)
- Caddy will obtain a Let's Encrypt TLS certificate automatically on first start

### Initial deployment steps

```bash
# 1. SSH into VPS
ssh deploy@your-vps-ip

# 2. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in

# 3. Clone the repository
git clone https://github.com/[TODO: YOUR_USERNAME]/whatsapp-ai-saas.git
cd whatsapp-ai-saas

# 4. Create and populate env file
cp infra/.env.example infra/.env
nano infra/.env
# Set all required variables with real secrets.
# For each secret: openssl rand -hex 32
# Set DOMAIN=api.yourdomain.com in .env for Caddy

# 5. Pull images (or build)
docker compose -f infra/docker-compose.yml pull
# OR: docker compose -f infra/docker-compose.yml build

# 6. Start infrastructure
docker compose -f infra/docker-compose.yml up -d postgres redis chromadb minio

# 7. Run migrations
make migrate

# 8. Start all services
docker compose -f infra/docker-compose.yml up -d

# 9. Verify health
make smoke
```

### Running migrations in production

```bash
# Apply all pending migrations (idempotent â€” safe to run multiple times)
docker compose -f infra/docker-compose.yml run --rm tenant-api pnpm exec prisma migrate deploy

# Check migration status
docker compose -f infra/docker-compose.yml run --rm tenant-api pnpm exec prisma migrate status
```

### Updating a service (zero-downtime rolling)

```bash
# Pull latest code
git pull origin main

# Rebuild the changed service image
docker compose -f infra/docker-compose.yml build tenant-api

# Recreate the service container (Caddy keeps routing to the old container until the new one is healthy)
docker compose -f infra/docker-compose.yml up -d --no-deps tenant-api

# Verify the new container is healthy
docker compose -f infra/docker-compose.yml ps tenant-api
make smoke
```

### Scaling flow-engine workers

```bash
# Scale up to 3 replicas (each process handles WORKER_COUNT=4 concurrent flows)
docker compose -f infra/docker-compose.yml up -d --scale flow-engine=3

# Scale back down
docker compose -f infra/docker-compose.yml up -d --scale flow-engine=2
```

---

## Monitoring

### Health check endpoints per service

| Service | Endpoint | Expected |
|---|---|---|
| gateway | `GET /healthz` | `200 {"status":"ok"}` |
| gateway | `GET /readyz` | `200 {"status":"ok","redis":"ok"}` |
| tenant-api | `GET /healthz` | `200 {"status":"ok"}` |
| flow-engine admin | `GET /admin/health` | `200 {"status":"ok","redis":"ok","postgres":"ok","chromadb":"ok"}` |

### Key metrics to watch

**Redis stream lag per tenant** (consumers falling behind):
```bash
# In redis-cli:
XINFO GROUPS flow-engine:<tenant_id>
# Watch: "pending" count and "last-delivered-id" vs "last-generated-id"
# Alert threshold: pending > 100 entries for > 60 seconds
```

**LLM token usage** (cost tracking):
```sql
-- In psql:
SELECT
  DATE_TRUNC('day', created_at) AS day,
  SUM(llm_tokens) AS total_tokens,
  COUNT(*) AS conversations
FROM conversation_logs
WHERE llm_tokens IS NOT NULL
GROUP BY 1 ORDER BY 1 DESC;
```

**Document indexing queue depth**:
```bash
# In redis-cli:
XLEN indexing:<tenant_id>
# Alert threshold: > 50 entries (rag-indexer may be down or overloaded)
```

**Worker heartbeat freshness**:
```sql
-- In psql:
SELECT worker_name, last_seen_at, NOW() - last_seen_at AS age
FROM worker_heartbeats;
-- Alert threshold: age > 60 seconds (rag-indexer is not running)
```

**Per-service alert thresholds** (from spec US-07-5):
- Gateway P95 latency > 150ms
- Flow engine end-to-end reply latency > 5s
- Redis stream lag > 100 pending entries
- rag-indexer heartbeat age > 60s
- ChromaDB collection size > 100K chunks per tenant (migration to Qdrant recommended)

---

## Troubleshooting

### Bot not responding to WhatsApp messages

1. **Check gateway logs for HMAC failures:**
   ```bash
   make logs SERVICE=gateway | grep -E "invalid_signature|error"
   ```
   If you see HMAC failures, `META_APP_SECRET` in `infra/.env` does not match the Meta App secret.

2. **Check Redis stream lag:**
   ```bash
   make redis-cli
   XINFO GROUPS flow-engine:<tenant_id>
   ```
   High pending count means flow-engine is down or overloaded.

3. **Check flow-engine consumer lag:**
   ```bash
   make logs SERVICE=flow-engine | grep -E "error|ERROR|exception"
   ```

4. **Verify tenant phone_number_id mapping:**
   ```bash
   make redis-cli
   GET tenant:by_phone:<phone_number_id>
   ```
   If empty: the tenant is not connected (phone_number_id not in `tenants` table).

### Knowledge base not indexing

1. **Check rag-indexer heartbeat:**
   ```bash
   make psql
   SELECT * FROM worker_heartbeats;
   ```
   If missing or stale, rag-indexer is not running: `docker compose -f infra/docker-compose.yml up -d rag-indexer`.

2. **Check document status in DB:**
   ```bash
   make psql
   SELECT id, name, status, error_message FROM knowledge_base_documents ORDER BY uploaded_at DESC LIMIT 10;
   ```

3. **Check ChromaDB connectivity:**
   ```bash
   curl http://localhost:18000/api/v1/heartbeat
   ```

4. **Manually re-enqueue a failed document:**
   - Delete the document via `DELETE /api/v1/kb/documents/:id`
   - Re-upload the file

### Flow engine returning wrong answers

1. **Use the dry-run endpoint to test without hitting real WhatsApp:**
   ```bash
   curl -X POST http://localhost/api/v1/dry-run \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{"message":"your test message","simulated_wa_id":"test-1"}'
   # Response includes "trace" array â€” inspect node execution path and RAG confidence scores
   ```

2. **Check RAG confidence scores in conversation_logs:**
   ```sql
   SELECT content->'rag' AS rag_debug FROM conversation_logs
   WHERE direction = 'outbound' ORDER BY created_at DESC LIMIT 5;
   ```

3. **Force reload tenant flow cache:**
   ```bash
   curl -X POST http://flow-engine:8001/admin/flows/<tenant_id>/reload \
     -H "X-Internal-Token: <INTERNAL_API_TOKEN>"
   # Or from the host (if flow-engine admin port is mapped):
   docker compose -f infra/docker-compose.yml exec tenant-api \
     curl -X POST http://flow-engine:8001/admin/flows/<tenant_id>/reload \
     -H "X-Internal-Token: $INTERNAL_API_TOKEN"
   ```

4. **Reset a stuck session:**
   ```bash
   docker compose -f infra/docker-compose.yml exec tenant-api \
     curl -X POST http://flow-engine:8001/admin/sessions/<tenant_id>/<wa_id>/reset \
     -H "X-Internal-Token: $INTERNAL_API_TOKEN"
   ```

---

## Security Operations

### Rotating MASTER_KEY (access_token re-encryption required)

`MASTER_KEY` encrypts each tenant's WhatsApp `access_token` at rest. Rotation requires re-encrypting all stored tokens:

```bash
# 1. Generate new key
NEW_KEY=$(openssl rand -hex 32)

# 2. Run the rotation script (decrypt with old key, re-encrypt with new key)
# [TODO: implement rotate_master_key.py â€” decrypt all tenants.access_token with old MASTER_KEY, re-encrypt with NEW_KEY]

# 3. Update infra/.env with the new MASTER_KEY
sed -i "s/^MASTER_KEY=.*/MASTER_KEY=$NEW_KEY/" infra/.env

# 4. Restart services that hold the key
docker compose -f infra/docker-compose.yml up -d --no-deps tenant-api flow-engine
```

### Rotating OPENAI_API_KEY

```bash
# 1. Update infra/.env
nano infra/.env  # change OPENAI_API_KEY

# 2. Restart flow-engine (the only service using it)
docker compose -f infra/docker-compose.yml up -d --no-deps flow-engine
```

### Revoking a tenant's WhatsApp access

```bash
# Via API
curl -X PATCH http://localhost/api/v1/tenant \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"waba_id": null, "phone_number_id": null, "access_token": null}'

# Clear tenant routing cache in Redis
make redis-cli
DEL tenant:by_phone:<phone_number_id>
```

### Suspending a tenant

```bash
# In psql: set tenant status to suspended
make psql
UPDATE tenants SET status = 'suspended' WHERE id = '<tenant_id>';

# The rlsPlugin and authPlugin will reject all API calls with a 403.
# Flow-engine will still process queued messages until the stream drains.
# To stop processing immediately, trim the stream:
XTRIM flow-engine:<tenant_id> MAXLEN 0
```

---

## Meta Tech Provider Path (Production Multi-Tenancy)

In MVP, all tenants share a single sandbox WhatsApp Business Account. For production multi-tenancy (each business client with their own WhatsApp number), Meta Tech Provider status is required.

### Step-by-step

1. **Apply for Tech Provider status** at [developers.facebook.com/docs/whatsapp/embedded-signup](https://developers.facebook.com/docs/whatsapp/embedded-signup). Requires a business verification (Meta Partner Center account). Review takes 1â€“4 weeks.

2. **Set up Embedded Signup** in your Meta App:
   - Enable "WhatsApp Embedded Signup" product
   - Configure OAuth redirect URI: `https://your-domain/api/v1/tenant/whatsapp/callback`

3. **Implement the OAuth exchange** in `tenant-api`:
   - The endpoint `POST /api/v1/tenant/whatsapp/embedded-signup` is stubbed in `ConnectWhatsAppUseCase.ts`
   - Replace the stub with the real OAuth token exchange using the Meta Graph API
   - Store the resulting `access_token` (encrypted with `MASTER_KEY`) in the `tenants` table

4. **What the Embedded Signup endpoint receives:**
   ```json
   {
     "code": "<oauth_code_from_meta>",
     "waba_id": "<waba_id>",
     "phone_number_id": "<phone_number_id>"
   }
   ```
   Exchange `code` for a system user access token via `POST https://graph.facebook.com/v21.0/oauth/access_token`.

5. **No architectural changes required.** All tenant isolation (RLS, Redis namespacing, ChromaDB collections) is already in place and production-ready.

