import { PrismaClient as BasePrismaClient } from '@prisma/client';
import { getCurrentTenantId, tenantContext } from './tenantContext.js';

// Tenant-scoped models that require RLS SET LOCAL before every query.
const TENANT_SCOPED_MODELS = new Set([
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
 * Singleton Prisma client with RLS middleware.
 *
 * For every query on a tenant-scoped model, wraps the operation in a
 * transaction that first sets the RLS GUC:
 *   SELECT set_config('app.tenant_id', $1, true)
 *
 * The value is always *bound as a parameter* — never interpolated into SQL
 * text (audit finding H4: the previous `$executeRawUnsafe` with string
 * concatenation was an injection sink reachable through a forged JWT claim).
 *
 * The tenantId is read from AsyncLocalStorage, so it is never taken from a
 * request body.
 *
 * NOTE: DATABASE_URL must use the `app_user` role (no BYPASSRLS).
 */
export function getPrismaClient(): BasePrismaClient {
  if (_instance) return _instance;

  _instance = new BasePrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });

  _instance.$use(async (params, next) => {
    const model = params.model?.toLowerCase();

    if (!model || !TENANT_SCOPED_MODELS.has(model)) {
      return next(params);
    }

    const tenantId = getCurrentTenantId();

    if (!isValidTenantId(tenantId)) {
      // No (or malformed) tenant context — RLS will block all rows. Failing
      // closed here is deliberate: it keeps an unset or tampered context from
      // ever reaching the database.
      return next(params);
    }

    // Wrap in an interactive transaction so the GUC is set before the query
    // runs and is scoped to that transaction only.
    return _instance!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return next(params);
    });
  });

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
