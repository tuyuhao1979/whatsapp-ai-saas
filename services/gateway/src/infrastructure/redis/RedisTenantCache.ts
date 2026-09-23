import type { Redis } from 'ioredis';
import type { ITenantCache } from '../../domain/ports/ITenantCache.js';
import { TenantNotFoundError } from '../../domain/errors.js';

/** Minimal interface for the Postgres client used in cache-miss fallback. */
export interface IPostgresClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: R[] }>;
}

const KEY_PREFIX = 'tenant:by_phone:';

/**
 * Implements ITenantCache using Redis GET/SET with a Postgres fallback.
 *
 * Cache hit path (~1ms):
 *   GET tenant:by_phone:{phoneNumberId} → return cached tenant UUID
 *
 * Cache miss path (~10ms):
 *   SELECT id FROM tenants WHERE phone_number_id = $1
 *   → SET tenant:by_phone:{phoneNumberId} EX {ttl} → return UUID
 *
 * Throws TenantNotFoundError if the phone number ID is unknown in the DB.
 */
export class RedisTenantCache implements ITenantCache {
  private readonly redis: Redis;
  private readonly postgres: IPostgresClient;
  private readonly cacheTtlSeconds: number;

  constructor(redis: Redis, postgres: IPostgresClient, cacheTtlSeconds: number = 300) {
    this.redis = redis;
    this.postgres = postgres;
    this.cacheTtlSeconds = cacheTtlSeconds;
  }

  async getTenantId(phoneNumberId: string): Promise<string> {
    const cacheKey = `${KEY_PREFIX}${phoneNumberId}`;

    // Cache hit
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached;
    }

    // Cache miss — query Postgres
    const result = await this.postgres.query<{ id: string }>(
      'SELECT id FROM tenants WHERE phone_number_id = $1 LIMIT 1',
      [phoneNumberId],
    );

    if (result.rows.length === 0) {
      throw new TenantNotFoundError(phoneNumberId);
    }

    const tenantId = result.rows[0]?.id;
    if (!tenantId) {
      throw new TenantNotFoundError(phoneNumberId);
    }

    // Populate cache
    await this.redis.set(cacheKey, tenantId, 'EX', this.cacheTtlSeconds);

    return tenantId;
  }
}
