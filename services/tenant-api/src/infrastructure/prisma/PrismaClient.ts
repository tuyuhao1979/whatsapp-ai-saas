import { PrismaClient as BasePrismaClient } from '@prisma/client';
import { getCurrentTenantId, tenantContext } from './tenantContext.js';

// Tenant-scoped models that require RLS SET LOCAL before every query.
// `tenant` is included since migration 007: `tenants` holds the encrypted
// WhatsApp access token and the WABA/phone binding, so it is exactly the table
// that must not be readable across tenants by a query that forgot its predicate.
const TENANT_SCOPED_MODELS = new Set([
  'tenant',
  'user',
  'flow',
  'flowNode',
  'knowledgeBaseDocument',
  'conversationLog',
]);

/**
 * PostgreSQL casts a non-UUID string to uuid by raising an error, so the RLS
 * policy would surface as a 500 rather than "no rows". More importantly, the
 * tenant id arrives from a JWT claim and must never reach SQL as raw text.
 * Validate the shape before it is used anywhere.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidTenantId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

let _instance: BasePrismaClient | null = null;

/**
 * Singleton Prisma client that establishes the RLS context for every query on a
 * tenant-scoped model.
 *
 * Two things matter here, and the previous implementation got the second one
 * wrong:
 *
 *  1. The value comes from AsyncLocalStorage, and is always *bound as a
 *     parameter* — never interpolated into SQL text (audit finding H4: the
 *     earlier `$executeRawUnsafe` with string concatenation was an injection
 *     sink reachable through a forged JWT claim).
 *  2. The `set_config` and the query must run on the *same connection*. The
 *     earlier version was `$use` middleware that called `next(params)` inside a
 *     `$transaction` callback: `next(params)` goes back through the root client
 *     and checks out a different pooled connection, so the transaction-local
 *     GUC never applied to the query. That was invisible for as long as the
 *     runtime role was the bootstrap superuser — superusers bypass row security
 *     unconditionally — and it denies every row the moment the runtime role is
 *     an ordinary role (audit finding H1). `$extends` is used instead, and the
 *     model operation is dispatched on the transaction client `tx`.
 *
 * NOTE: DATABASE_URL must use the `app_runtime` role (no SUPERUSER, no
 * BYPASSRLS).
 */
export function getPrismaClient(): BasePrismaClient {
  if (_instance) return _instance;

  const base = new BasePrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });

  const extended = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const name = model?.toLowerCase();
          if (!name || !TENANT_SCOPED_MODELS.has(name)) {
            return query(args);
          }

          const tenantId = getCurrentTenantId();
          if (!isValidTenantId(tenantId)) {
            // No (or malformed) tenant context — RLS will block all rows.
            // Failing closed here is deliberate: it keeps an unset or tampered
            // context from ever reaching the database.
            return query(args);
          }

          return base.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            const delegate = (
              tx as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>
            )[name];
            if (!delegate) return query(args);
            return delegate[operation]?.(args);
          });
        },
      },
    },
  });

  _instance = extended as unknown as BasePrismaClient;

  return _instance;
}

/**
 * Run `fn` with a tenant RLS context established for its whole async scope.
 *
 * Needed by flows that legitimately have no request-scoped tenant context yet
 * — registration (the tenant is created moments earlier) and login (the tenant
 * is resolved from the slug). Without it, migration 005's FORCE ROW LEVEL
 * SECURITY blocks the INSERT/SELECT and both endpoints fail (audit finding B4).
 *
 * `tenantContext.run` scopes the store to `fn` only; the Prisma middleware
 * then wraps each tenant-scoped query in its own transaction with the
 * parameterised set_config.
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isValidTenantId(tenantId)) {
    throw new Error('withTenantContext requires a valid tenant UUID');
  }
  return tenantContext.run(tenantId, fn);
}

export { BasePrismaClient as PrismaClient };
