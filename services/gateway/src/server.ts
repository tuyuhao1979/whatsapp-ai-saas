import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import type { Config } from './config.js';
import { SignatureVerifier } from './infrastructure/meta/SignatureVerifier.js';
import { RedisTenantCache } from './infrastructure/redis/RedisTenantCache.js';
import { RedisMessageQueue } from './infrastructure/redis/RedisMessageQueue.js';
import { ProcessWebhookUseCase } from './application/ProcessWebhookUseCase.js';
import { webhookRoutes } from './interfaces/http/webhookRoutes.js';
import { healthRoutes } from './interfaces/http/healthRoutes.js';

const { Pool } = pg;

/**
 * Fastify app factory. Accepts a Config so it can be instantiated in tests
 * without touching process.env. Returns the Fastify instance ready to listen.
 *
 * Composition root: all adapters are wired here and injected into use cases.
 * No DI container — the dependency graph is small enough for explicit wiring.
 *
 * The return type is spelled out as `FastifyInstance` rather than
 * `ReturnType<typeof Fastify>`: `Fastify` is both a callable and a namespace
 * with overloads, so `ReturnType` resolved to a loose type and every call site
 * (main.ts) was flagged as unsafe `any` access by the typed lint rules.
 */
export async function buildApp(config: Config): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
  });

  // ---------------------------------------------------------------------------
  // Infrastructure — Redis
  // ---------------------------------------------------------------------------
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  await redis.connect();

  fastify.addHook('onClose', async () => {
    await redis.quit();
  });

  // ---------------------------------------------------------------------------
  // Infrastructure — Postgres (read-only, only used for cache-miss fallback)
  // ---------------------------------------------------------------------------
  const pgPool = new Pool({ connectionString: config.POSTGRES_URL });

  fastify.addHook('onClose', async () => {
    await pgPool.end();
  });

  // ---------------------------------------------------------------------------
  // Adapters
  // ---------------------------------------------------------------------------
  const signatureVerifier = new SignatureVerifier(config.META_APP_SECRET);

  const tenantCache = new RedisTenantCache(
    redis,
    pgPool,
    config.TENANT_CACHE_TTL_SECONDS,
  );

  const messageQueue = new RedisMessageQueue(
    redis,
    fastify.log,
    config.STREAM_MAXLEN_APPROX,
  );

  // ---------------------------------------------------------------------------
  // Use cases
  // ---------------------------------------------------------------------------
  const processWebhookUseCase = new ProcessWebhookUseCase({
    tenantCache,
    messageQueue,
    logger: fastify.log,
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  await fastify.register(webhookRoutes, {
    verifyToken: config.META_VERIFY_TOKEN,
    signatureVerifier,
    processWebhookUseCase,
  });

  await fastify.register(healthRoutes, { redis });

  return fastify;
}
