import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MetaOAuthState } from '../../domain/models/MetaConnection.js';
import type { IOAuthStateStore } from '../../domain/ports/IOAuthStateStore.js';

const KEY_PREFIX = 'oauth:meta:state:';

/**
 * Redis-backed OAuth `state` store implementing single-use semantics with
 * GETDEL, which is atomic — a concurrent replay cannot win a race.
 *
 * Keys live under `oauth:meta:state:*` and are granted to tenant_api_user in
 * infra/redis/users.acl.tpl.
 */
export class RedisOAuthStateStore implements IOAuthStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = 600,
  ) {}

  async issue(tenantId: string, userId: string): Promise<MetaOAuthState> {
    const state = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const record: MetaOAuthState = { state, tenantId, userId, createdAt };

    // The value is only ever read back by us; a plain JSON blob is enough.
    await this.redis.set(
      `${KEY_PREFIX}${state}`,
      JSON.stringify(record),
      'EX',
      this.ttlSeconds,
    );

    return record;
  }

  async consume(state: string): Promise<MetaOAuthState | null> {
    if (!state) return null;

    // GETDEL (Redis >= 6.2) makes consume-once atomic.
    const raw = await this.redis.getdel(`${KEY_PREFIX}${state}`);
    if (raw == null) return null;

    try {
      const parsed = JSON.parse(raw) as MetaOAuthState;
      if (typeof parsed?.tenantId !== 'string' || typeof parsed?.userId !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
