import type { DomainError } from '../../domain/errors.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';

/**
 * Translate the persistence layer's error codes into domain errors.
 *
 * The database is where several invariants are actually enforced — unique
 * constraints such as `flows (tenant_id, name, version)`, `tenants (slug)`,
 * `tenants (phone_number_id)` and `users (tenant_id, email)`, plus foreign-key
 * and CHECK constraints. A use case that pre-checks for a collision before
 * inserting still races, and Prisma's error carried no domain meaning: it fell
 * through to the global error handler and answered 500.
 *
 * Schemathesis found this by creating two flows with the same name in one
 * tenant: `Unique constraint failed on the fields: (tenant_id, name, version)`
 * became a 500 instead of a 409.
 *
 * Codes handled (Prisma first, then the raw Postgres SQLSTATE for `$queryRaw`):
 *   P2002 / 23505  unique violation        -> 409
 *   P2025          record not found        -> 404
 *   P2003 / 23503  foreign key violation   -> 422
 *   23514          CHECK violation         -> 422
 *
 * Returns null when the error is not a recognised persistence error, so the
 * caller can keep its existing "unknown error -> 500" behaviour.
 */
export function translatePrismaError(err: unknown): DomainError | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;

  const target = extractTarget(err);
  const detail = target ? [target] : [];

  switch (code) {
    case 'P2002':
    case '23505':
      return new ConflictError(
        target ? `${target} already exists` : 'Resource already exists',
      );
    case 'P2025':
      return new NotFoundError('Resource');
    case 'P2003':
    case '23503':
      return new ValidationError('Referenced record does not exist', detail);
    case '23514':
      return new ValidationError('Value violates a database constraint', detail);
    default:
      return null;
  }
}

/** Prisma puts the constraint target in `meta.target`, as a string or array. */
function extractTarget(err: unknown): string | null {
  const meta = (err as { meta?: unknown } | null)?.meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const target = (meta as { target?: unknown }).target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.filter((t) => typeof t === 'string').join(', ');
  return null;
}
