import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';

export interface HealthRouteDeps {
  redis: Redis;
}

/**
 * Registers health check routes:
 *
 *   GET /healthz — liveness probe (always 200 if process is up)
 *   GET /readyz  — readiness probe (pings Redis; 503 if unreachable)
 */
export async function healthRoutes(
  fastify: FastifyInstance,
  deps: HealthRouteDeps,
): Promise<void> {
  const { redis } = deps;

  fastify.get(
    '/healthz',
    async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await reply.status(200).send({ status: 'ok' });
    },
  );

  fastify.get(
    '/readyz',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        // ioredis' overload set makes `ping()` resolve to `never` here, which
        // broke the template literal below and made the PONG check dead code.
        const pong: string = await redis.ping();
        if (pong !== 'PONG') {
          throw new Error(`Unexpected Redis PING response: ${pong}`);
        }
        await reply.status(200).send({ status: 'ok', redis: 'ok' });
      } catch (err) {
        request.log.error(
          { event: 'readyz.redis_unreachable', err },
          'Redis PING failed — service not ready',
        );
        await reply.status(503).send({ status: 'not_ready', redis: 'unreachable' });
      }
    },
  );
}
