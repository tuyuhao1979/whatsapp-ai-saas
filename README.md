# WhatsApp AI SaaS Platform

> A production-ready multi-tenant SaaS platform where businesses connect their WhatsApp Business Account,
> define conversational flows, and get an AI-powered bot that handles customer conversations automatically.

## Architecture

```
                              ┌──────────────────────────────────────────────────────┐
                              │                  Docker Network                       │
                              │                                                        │
  Meta Cloud API              │   ┌──────────┐       Redis Streams                   │
  (WhatsApp)  ────────────────┼──▶│ gateway  │─────────────────────────┐            │
                              │   │ Node.js  │                          │            │
                              │   └──────────┘                          ▼            │
                              │                              ┌─────────────────────┐  │
  Dashboard client ───────────┼──▶┌────────────┐            │    flow-engine      │  │
  (browser/curl)              │   │ tenant-api │            │    Python 3.12      │  │
                              │   │ Node.js    │            │    (×2 replicas)    │  │
                              │   └────────────┘            └─────────────────────┘  │
                              │         │                           │    │            │
                              │   Redis │ Streams                  │    │            │
                              │         ▼                          │    ▼            │
                              │   ┌─────────────┐    ChromaDB      │  Meta Send API  │
                              │   │ rag-indexer │    (vectors)  ◀──┘                 │
                              │   │ Python 3.12 │                                    │
                              │   └─────────────┘                                    │
                              │                                                        │
                              │   PostgreSQL 16  ·  Redis 7  ·  ChromaDB 0.5  ·  MinIO│
                              └──────────────────────────────────────────────────────┘
```

### Services

| Service | Stack | Responsibility |
|---|---|---|
| `gateway` | Node.js 20 + Fastify | HMAC verification, tenant routing, Redis Stream enqueue |
| `tenant-api` | Node.js 20 + Fastify + Prisma | REST API, JWT auth, flow & KB management, dry-run proxy |
| `flow-engine` | Python 3.12 + FastAPI + LangChain | Flow execution, RAG retrieval, LLM orchestration, Meta Send |
| `rag-indexer` | Python 3.12 worker | Document loading, chunking, embedding, ChromaDB indexing |

## Tech Stack

| Technology | Version | Why chosen |
|---|---|---|
| Node.js | 20 LTS | I/O-bound services (webhook, REST API); built-in crypto for HMAC |
| Fastify | 4.x | 2–3× faster than Express; built-in JSON Schema validation; pino logging |
| Prisma | 5.x | Type-safe Postgres queries; migration management; RLS-compatible |
| Python | 3.12 | AI/ML ecosystem (LangChain, sentence-transformers, ChromaDB) |
| FastAPI | 0.111+ | Async admin API with OpenAPI docs; Pydantic validation |
| LangChain | 0.3.x | LLM provider abstraction; history trimming; retriever composition |
| PostgreSQL | 16 | Row Level Security for multi-tenant isolation; JSONB for flow graphs |
| Redis | 7 | Streams (async queue) + sessions + tenant lookup cache; AOF durability |
| ChromaDB | 0.5 | Per-tenant vector collections; simple HTTP interface; no schema migrations |
| MinIO | latest | S3-compatible local storage for KB documents; replaced by S3 in prod |
| Caddy | 2 | Automatic HTTPS (Let's Encrypt); reverse proxy to gateway and tenant-api |
| sentence-transformers | 2.7+ | Local CPU embeddings (all-MiniLM-L6-v2); zero marginal cost |
| argon2id | — | Password hashing with memory-hard properties |

## Getting Started

### Prerequisites

- Docker 24+ and Docker Compose v2
- Node.js 20 LTS (for local development outside Docker; use [nvm](https://github.com/nvm-sh/nvm))
- pnpm 10 via Corepack (`corepack enable`) for all Node.js services; npm is not used in this repo
- Python 3.12 (for local development outside Docker; use [pyenv](https://github.com/pyenv/pyenv))
- `make`, `git`, `openssl` (available on Linux/macOS; Windows users: WSL2 recommended)
- A Meta Developer account (for WhatsApp Cloud API — free sandbox available at [developers.facebook.com](https://developers.facebook.com))
- An OpenAI API key (for LLM — gpt-4o-mini, approximately $0.001 per conversation)

### Quick Start

```bash
# 1. Clone and enter
git clone https://github.com/[TODO: YOUR_USERNAME]/whatsapp-ai-saas.git
cd whatsapp-ai-saas

# 2. Configure environment
cp infra/.env.example infra/.env
# Edit infra/.env — at minimum set OPENAI_API_KEY and APP_SECRET
# Generate secrets: openssl rand -hex 32

# 3. Build service images
make build

# 4. Start infrastructure (Postgres, Redis, ChromaDB, MinIO)
make infra-up

# 5. Wait for Postgres to be healthy (~10s)
make wait-infra

# 6. Run database migrations
make migrate

# 7. Start application services
make app-up

# 8. Seed test data (creates a test tenant + greeting flow + FAQ knowledge base)
make seed

# 9. Verify everything is healthy
make smoke

# 10. Send a test WhatsApp message (signed webhook simulation)
export APP_SECRET=your-app-secret-from-infra/.env
export WEBHOOK_VERIFY_TOKEN=your-verify-token-from-infra/.env
make test-webhook
```

Alternatively, `make dev` starts the full stack (infrastructure + services) in one command — skip steps 3–7 and run `make migrate && make seed` after.

## Environment Variables

Copy `infra/.env.example` to `infra/.env` and fill in the values below.

| Variable | Service | Description | Required | Example |
|---|---|---|---|---|
| `OPENAI_API_KEY` | flow-engine | OpenAI API key for LLM completions | YES | `sk-...` |
| `META_APP_SECRET` | gateway, flow-engine | Meta App secret for HMAC-SHA256 webhook verification | YES | `openssl rand -hex 32` |
| `META_VERIFY_TOKEN` | gateway | Token for Meta webhook handshake | YES | any random string |
| `JWT_SECRET` | tenant-api | HS256 signing secret (min 32 chars) | YES | `openssl rand -hex 32` |
| `MASTER_KEY` | tenant-api, flow-engine | AES-256 key for encrypting WhatsApp access tokens at rest (min 32 bytes) | YES | `openssl rand -hex 32` |
| `INTERNAL_API_TOKEN` | tenant-api, flow-engine | Shared secret for tenant-api → flow-engine admin calls | YES | `openssl rand -hex 32` |
| `DATABASE_URL` | tenant-api, flow-engine, gateway, rag-indexer | PostgreSQL connection string (app_runtime, no SUPERUSER / BYPASSRLS, so RLS applies) | YES | `postgresql://app_runtime:pass@postgres:5432/saas` |
| `DATABASE_MIGRATION_URL` | tenant-api | Migration connection string (app_user, owns the schema) | YES | `postgresql://app_user:pass@postgres:5432/saas` |
| `REDIS_URL` | all services | Redis connection string | YES | `redis://:pass@redis:6379/0` |
| `CHROMA_HOST` | flow-engine, rag-indexer | ChromaDB service hostname | YES | `chromadb` |
| `S3_ENDPOINT` | tenant-api, rag-indexer | MinIO/S3 endpoint | YES | `http://minio:9000` |
| `S3_BUCKET_KB` | tenant-api, rag-indexer | Bucket for knowledge base documents | YES | `kb-documents` |
| `S3_ACCESS_KEY` | tenant-api, rag-indexer | MinIO/S3 access key | YES | `minioadmin` |
| `S3_SECRET_KEY` | tenant-api, rag-indexer | MinIO/S3 secret key | YES | `minioadmin` |

See `infra/.env.example` for the complete list (40+ variables) including optional tunables.

## API Reference

All public endpoints are prefixed `/api/v1`. All responses use the envelope:
```json
{ "data": <payload>, "error": null, "meta": { "request_id": "..." } }
```

Full contract in `openspec/changes/whatsapp-ai-saas/proposal.md` Section 4.

### Auth

```
POST /api/v1/auth/register
  Body: { "tenant_name": "Acme", "email": "a@b.com", "password": "..." }

POST /api/v1/auth/login
  Body: { "email": "...", "password": "..." }
  Returns: { "token": "jwt", "tenant_id": "uuid", "expires_at": "..." }
```

### Flows

```
GET    /api/v1/flows
POST   /api/v1/flows
GET    /api/v1/flows/:id
PUT    /api/v1/flows/:id          — creates a new version; previous retained
POST   /api/v1/flows/:id/activate — deactivates overlapping triggers first
DELETE /api/v1/flows/:id
```

### Knowledge Base

```
POST   /api/v1/kb/documents       — multipart upload; returns { id, status: "pending" }
GET    /api/v1/kb/documents       — list with status (pending/indexing/indexed/failed)
DELETE /api/v1/kb/documents/:id   — removes from DB and ChromaDB collection
```

### Conversations

```
GET /api/v1/conversations?wa_id=&from=&to=&limit=
```

### Bot Testing

```
POST /api/v1/dry-run
  Body: { "message": "what's the price?", "simulated_wa_id": "test-1" }
  Returns: { "reply": "...", "flow_id": "...", "trace": [...] }
```

## Connecting WhatsApp (Meta Cloud API)

1. Create a [Meta Developer](https://developers.facebook.com) account and a Meta App.
2. Enable the **WhatsApp** product on the app.
3. Add a test phone number (Meta provides a free sandbox number with 1000 free messages/month).
4. Copy the **App Secret** from App Settings → Basic → App Secret. Set it as `META_APP_SECRET` in `infra/.env`.
5. Set `META_VERIFY_TOKEN` to any random string (e.g. `openssl rand -hex 16`).
6. Deploy or expose your local gateway (use [ngrok](https://ngrok.com) for local testing: `ngrok http 80`).
7. In Meta App Dashboard → WhatsApp → Configuration: set the webhook URL to `https://your-domain.com/webhook` and the verify token to your `META_VERIFY_TOKEN`.
8. Subscribe to the **messages** webhook field.
9. Call `POST /api/v1/tenant/whatsapp/connect` with your WABA ID, phone number ID, and access token.

> **Production note:** For real multi-tenant onboarding (multiple business clients each with their own WhatsApp number), Meta Tech Provider status is required. See [docs/adr/007-sentence-transformers-local-embeddings.md](docs/adr/007-sentence-transformers-local-embeddings.md) and the runbook for details. MVP operates in single-WABA sandbox mode; all tenant isolation is fully implemented at the application layer.

## How Conversational Flows Work

A **flow** is a directed graph of nodes. Each node performs an action (send a message, collect input, query the knowledge base, call the LLM) and transitions to the next node based on conditions.

Example flow — a simple pricing inquiry:

```json
{
  "name": "Pricing Flow",
  "trigger": { "type": "keyword_match", "keywords": ["price", "pricing", "cost"] },
  "entry_node": "node_greet",
  "nodes": [
    {
      "node_key": "node_greet",
      "type": "message",
      "config": { "content": "Hi! Let me look up our pricing for you." },
      "transitions": [{ "condition": { "type": "always" }, "next": "node_rag" }]
    },
    {
      "node_key": "node_rag",
      "type": "rag_lookup",
      "config": { "query_template": "pricing plans", "top_k": 5, "min_confidence": 0.6, "store_in_slot": "rag_context" },
      "transitions": [
        { "condition": { "type": "rag_confidence_above", "threshold": 0.6 }, "next": "node_answer" },
        { "condition": { "type": "always" }, "next": "node_fallback" }
      ]
    },
    {
      "node_key": "node_answer",
      "type": "llm_generate",
      "config": { "system_prompt": "Answer using the provided context.", "include_rag": true, "max_tokens": 300 },
      "transitions": [{ "condition": { "type": "always" }, "next": "node_end" }]
    },
    {
      "node_key": "node_fallback",
      "type": "message",
      "config": { "content": "I don't have that info right now. A team member will follow up!" },
      "transitions": [{ "condition": { "type": "always" }, "next": "node_end" }]
    },
    { "node_key": "node_end", "type": "end", "config": {}, "transitions": [] }
  ]
}
```

When no flow matches, the engine falls back to a RAG + LLM response using the tenant's entire knowledge base.

The flow-engine resolves each tenant's encrypted WhatsApp access token from Postgres using the tenant and phone number IDs, then decrypts it locally before calling Meta. The Redis Stream does **not** carry plaintext access tokens.

## Testing

```bash
make smoke           # Health checks for all 6 services (gateway, tenant-api, flow-engine, Postgres, Redis, ChromaDB)
make test-webhook    # Simulate 5 Meta webhook scenarios end-to-end (requires APP_SECRET and WEBHOOK_VERIFY_TOKEN env vars)
make test-isolation  # Verify multi-tenant data isolation (RLS enforcement)
make e2e             # Run full suite (smoke + test-webhook + test-isolation)
```

For `make test-webhook`, set these env vars before running:
```bash
export APP_SECRET=<value from infra/.env>
export WEBHOOK_VERIFY_TOKEN=<value from infra/.env>
export JWT_TOKEN=<JWT printed by make seed>   # optional; skips dry-run assertion if not set
```

The smoke test derives the container name prefix from `COMPOSE_PROJECT` (default: `whatsapp-ai-saas`). Override with:
```bash
COMPOSE_PROJECT=my-project make smoke
```

## Project Structure

```
whatsapp-ai-saas/
├── services/
│   ├── gateway/        # Node.js 20 + Fastify — webhook receiver
│   ├── tenant-api/     # Node.js 20 + Fastify + Prisma — REST API
│   ├── flow-engine/    # Python 3.12 + FastAPI — flow executor + LLM
│   └── rag-indexer/    # Python 3.12 worker — document indexing
├── infra/
│   ├── docker-compose.yml
│   ├── Caddyfile
│   ├── .env.example
│   ├── migrations/     # PostgreSQL schema (5 SQL files)
│   ├── contracts/      # JSON Schema for inter-service messages
│   ├── seed/           # Test data scripts (seed.sh + seed.py)
│   └── e2e/            # End-to-end test scripts
├── docs/
│   ├── runbook.md      # Operations playbook
│   └── adr/            # Architecture Decision Records (7 ADRs)
├── contracts/          # JSON Schema for stream envelopes (symlinked from infra/contracts/)
├── Makefile
└── README.md
```

## Production Deployment

For a single-VPS deployment (Fly.io or DigitalOcean Droplet, 4 vCPU / 8 GB RAM):

1. Provision the VPS and install Docker + Docker Compose v2.
2. Clone this repository and copy `infra/.env.example` to `infra/.env`; populate with real secrets from your secret manager (`flyctl secrets set ...` or DO environment variables).
3. Point your domain at the VPS. Caddy obtains a Let's Encrypt certificate automatically.
4. Run migrations: `make migrate`.
5. Start all services: `docker compose -f infra/docker-compose.yml up -d`.
6. In Meta App Dashboard, set the webhook URL to `https://your-domain/webhook`.
7. Validate with `make smoke` and a real WhatsApp message.

See [docs/runbook.md](docs/runbook.md) for the complete operations playbook, including log access, rolling updates, backups, and troubleshooting.

## Roadmap (v2)

- [ ] Dashboard UI (React)
- [ ] Meta Embedded Signup (Tech Provider onboarding — self-serve multi-tenant)
- [ ] Proactive message campaigns (WhatsApp Templates)
- [ ] Per-tenant custom LLM keys (BYOK)
- [ ] Visual flow builder
- [ ] Qdrant migration for high-volume tenants (>500K chunks)
- [ ] Redis Sentinel / HA for production
- [ ] Grafana + Loki observability stack
- [ ] Billing / Stripe integration

## License

MIT
