#!/usr/bin/env bash
# run-verification.sh — bring up the isolated verification stack and migrate it
# ---------------------------------------------------------------------------
# The schema under test is the one in infra/migrations/, applied explicitly at
# run time, not a snapshot baked into an image. `docker compose up` alone leaves
# an empty database, so every query fails with "relation ... does not exist".
#
# Usage:
#   bash infra/verify/run-verification.sh
#
# Then (the same two commands .github/workflows/verify-integration.yml runs):
#   python3 infra/e2e/test_multitenant.py
#   schemathesis run infra/contracts/openapi-tenant-api.json \
#     --origin http://127.0.0.1:13001 -H "Authorization: Bearer <jwt>" \
#     --checks not_a_server_error,negative_data_rejection
#
# Teardown (--profile storage so a profiled minio container is removed too):
#   docker compose -f infra/verify/docker-compose.verify.yml --profile storage down -v
#
# Nothing here touches production: the stack runs its own postgres/redis/minio
# on 127.0.0.1, with a mock Meta Graph API instead of the real one.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/verify/docker-compose.verify.yml"
TENANT_API_URL="${TENANT_API_URL:-http://127.0.0.1:13001}"

cd "${REPO_ROOT}"

echo "==> Starting the verification stack"
docker compose -f "${COMPOSE_FILE}" up -d --build

echo "==> Waiting for postgres"
for _ in $(seq 1 60); do
  if docker compose -f "${COMPOSE_FILE}" exec -T postgres \
    pg_isready -U app_user -d whatsapp_saas > /dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
  pg_isready -U app_user -d whatsapp_saas

echo "==> Applying infra/migrations/*.sql in filename order"
# /migrations is the read-only mount of infra/migrations configured on the
# postgres service, so the files are read from the repository, not copied in.
docker compose -f "${COMPOSE_FILE}" exec -T postgres sh -c '
  set -e
  for migration in $(ls /migrations/*.sql | sort); do
    echo "    --> $(basename "${migration}")"
    psql -U app_user -d whatsapp_saas -v ON_ERROR_STOP=1 -q -f "${migration}"
  done
'

echo "==> Waiting for tenant-api"
for _ in $(seq 1 60); do
  if curl -fsS "${TENANT_API_URL}/api/v1/healthz" > /dev/null; then
    echo "tenant-api is healthy"
    exit 0
  fi
  sleep 3
done

echo "ERROR: tenant-api did not become healthy in time" >&2
docker compose -f "${COMPOSE_FILE}" ps >&2
docker compose -f "${COMPOSE_FILE}" logs --tail 100 tenant-api >&2
exit 1
