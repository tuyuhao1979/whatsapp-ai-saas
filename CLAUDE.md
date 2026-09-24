# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-tenant SaaS platform where businesses connect a WhatsApp Business Account, define conversational flows, and get an AI-powered bot. All infrastructure is Docker-first; `make` targets are the primary interface.

## Development Commands

### Full stack

```bash
make dev          # copy .env.example if missing, then docker compose up -d
make down         # stop all containers
make migrate      # run SQL migrations (bash infra/migrate.sh)
make seed         # seed test tenant, flow, and KB document
make smoke        # health-check all 6 services
make logs         # follow all logs (SERVICE=<name> to filter a single service)
```

### Building

```bash
make build        # build all Docker images
make infra-up     # postgres, redis, chromadb, minio, caddy only
make app-up       # gateway, tenant-api, flow-engine, rag-indexer only
make wait-infra   # block until postgres and redis are healthy
```

### Tests

```bash
# All unit tests across all services
make test

# Per-service unit tests
cd services/gateway    && pnpm test:unit
cd services/tenant-api && pnpm test:unit
cd services/flow-engine  && python -m pytest tests/unit
cd services/rag-indexer  && python -m pytest tests/unit

# Run a single test file or test by name
cd services/gateway    && pnpm exec jest tests/unit/SignatureVerifier.test.ts
cd services/flow-engine  && python -m pytest tests/unit/test_trigger_matcher.py -k "test_keyword_match"

# Coverage
cd services/gateway    && pnpm test:coverage
cd services/flow-engine  && python -m pytest tests/unit --cov

# Integration tests (require running stack)
cd services/gateway    && pnpm test:integration
cd services/tenant-api && pnpm test:integration

# Full E2E suite
make e2e          # smoke + seed + test-webhook + test-isolation
make test-webhook # signed webhook simulation (needs APP_SECRET and WEBHOOK_VERIFY_TOKEN env vars)
make test-isolation # cross-tenant RLS enforcement
```

### Lint / typecheck

```bash
make lint                          # lint all services
cd services/gateway    && pnpm lint
cd services/tenant-api && pnpm typecheck
cd services/flow-engine  && python -m ruff check .
cd services/rag-indexer  && python -m ruff check .
```

### Local dev outside Docker (per service)

```bash
# Node services (live reload via tsx)
cd services/gateway    && pnpm dev   # :3000
cd services/tenant-api && pnpm dev   # :3001

# Python services
cd services/flow-engine  && python -m flow_engine.main
cd services/rag-indexer  && python -m rag_indexer.main
```

### Database / Redis utilities

```bash
make psql       # interactive psql session (app_user)
make redis-cli  # interactive redis-cli
```

## Architecture

### Services

| Service | Port | Stack | Role |
|---|---|---|---|
| `gateway` | 3000 | Node 20 + Fastify | HMAC-verifies Meta webhooks, resolves tenant by `phone_number_id`, enqueues to Redis Stream |
| `tenant-api` | 3001 | Node 20 + Fastify + Prisma | REST API for auth, flows, KB documents, conversations |
| `flow-engine` | 8001 (internal) | Python 3.12 + FastAPI + LangChain | Redis Stream consumer + admin HTTP API; executes flows, RAG, LLM |
| `rag-indexer` | â€” (worker) | Python 3.12 | Redis Stream consumer; loads, chunks, embeds documents into ChromaDB |

All four services follow **hexagonal architecture**: `domain/` â†’ `application/` â†’ `infrastructure/` + `interfaces/`.

### Inter-service communication

Two Redis Streams carry all async work:

- `flow-engine:{tenant_id}` â€” gateway â†’ flow-engine. Schema: `infra/contracts/flow-engine-message.schema.json`
- `indexing:{tenant_id}` â€” tenant-api â†’ rag-indexer. Schema: `infra/contracts/indexing-job.schema.json`

The gateway **never** calls flow-engine HTTP; all coupling is through Redis. The tenant-api calls flow-engine admin API (`FLOW_ENGINE_ADMIN_URL`) only for dry-run proxy requests.

`flow-engine` is deployed with 2 replicas. The `MODE` env var controls what each replica runs:
- `both` (default): stream consumer + admin HTTP server
- `consumer`: stream consumer only
- `admin`: admin API only

### Multi-tenancy (RLS)

All tenant-scoped tables have PostgreSQL Row Level Security enabled (`infra/migrations/005_enable_rls.sql`), `tenants` itself included (`007_tenants_rls.sql`). Every policy evaluates `nullif(current_setting('app.tenant_id', true), '')::uuid` (see `009_rls_policy_empty_setting.sql`): an unset *or* empty setting denies every row rather than raising a uuid cast error on a pooled connection.

`tenant-api` never issues `SET LOCAL` by hand. The Prisma client extension in `infrastructure/prisma/PrismaClient.ts` wraps each tenant-scoped operation in a transaction that calls `set_config('app.tenant_id', <uuid>, true)`; the uuid comes from an `AsyncLocalStorage` store that `authPlugin.authenticate` populates once the JWT is verified. The two lookups that legitimately cross tenants — login by slug and gateway by `phone_number_id` — go through `SECURITY DEFINER` functions (`lookup_tenant_by_slug`, `tenant_id_for_phone`).

Two DB connection strings exist:
- `DATABASE_URL` -- `app_runtime` role, no SUPERUSER / BYPASSRLS, RLS enforced, used at runtime
- `DATABASE_MIGRATION_URL` -- `app_user` (bootstrap superuser, owns the schema), used only for `make migrate`

The runtime role is created by `infra/postgres/init/00-runtime-role.sql` on a fresh cluster and by `008_runtime_role.sql` on an existing one.

Migrations live in `infra/migrations/` as plain SQL files â€” **not** Prisma migrations. The Prisma schema (`services/tenant-api/prisma/schema.prisma`) mirrors the SQL schema and is used only for type generation and Prisma Client queries.

### Session state

Conversation sessions are stored as Redis Hashes keyed `session:{tenant_id}:{wa_id}`. The `Session` dataclass in `services/flow-engine/flow_engine/domain/models.py` owns serialization to/from hash fields. Sessions have a TTL and track: `state` (IDLE / IN_FLOW / LLM_FALLBACK / ERROR), current node, slots (typed variables collected during flow), and last 10 turns of history.

### Flow graph

A flow is stored as `flows` + `flow_nodes` rows. `FlowNode.transitions` is a JSONB array of `{condition, next}` objects evaluated top-to-bottom in `flow_engine/application/flow_executor.py`. Node types: `message`, `interactive`, `collect_input`, `condition`, `rag_lookup`, `llm_generate`, `api_call`, `end`.

When no active flow matches an inbound message, flow-engine falls back to a RAG + LLM response using the tenant's full ChromaDB collection.

### Security

- **HMAC-SHA256** webhook verification in gateway (`SignatureVerifier`). Signature is compared in constant time.
- **JWT HS256** for tenant-api auth (ADR 006). Tokens are 12 h by default.
- **AES-256-GCM** encryption for the WhatsApp access token stored in `tenants.access_token`. The `MASTER_KEY` env var is the 32-byte key; decryption happens in flow-engine before calling Meta Send API.
- **argon2id** for password hashing in tenant-api.
- **ChromaDB token authentication** (`CHROMA_AUTH_TOKEN`). The server runs with `CHROMA_SERVER_AUTHN_PROVIDER=…TokenAuthenticationServerProvider` and the two Python services send the token as a bearer header; `/api/v1/heartbeat` stays exempt for the healthcheck. The chromadb client is pinned with `==` to the server image tag in `infra/docker-compose.yml` (a client/server major mismatch silently broke all RAG reads and writes).

### Environment

All env vars are in `infra/.env` (copy from `infra/.env.example`). Required vars at minimum: `OPENAI_API_KEY`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `JWT_SECRET`, `MASTER_KEY`, `INTERNAL_API_TOKEN`. Redis has per-service ACL users with scoped permissions; passwords are in the env file and rendered into `infra/redis/users.acl` via `envsubst` at container start.

