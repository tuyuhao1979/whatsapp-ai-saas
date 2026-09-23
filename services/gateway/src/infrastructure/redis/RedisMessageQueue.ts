import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { IMessageQueue } from '../../domain/ports/IMessageQueue.js';
import type { WebhookEnvelope } from '../../domain/models/WebhookEnvelope.js';

/**
 * Implements IMessageQueue by publishing WebhookEnvelopes to a Redis Stream.
 *
 * Stream name pattern: flow-engine:{tenantId}
 * Entry format: one field "data" whose value is the JSON-serialised envelope.
 * Stream is capped at ~MAXLEN entries (approximate trim for performance).
 *
 * The envelope shape must match contracts/flow-engine-message.schema.json.
 * In development mode, consider validating via Ajv before XADD.
 *
 * Error policy: Redis errors are logged and re-thrown so the caller (the HTTP
 * handler) can increment a Prometheus counter. The HTTP handler returns 200
 * regardless — Meta's 7-day retry window covers any loss.
 */
export class RedisMessageQueue implements IMessageQueue {
  private readonly redis: Redis;
  private readonly logger: FastifyBaseLogger;
  private readonly maxlenApprox: number;

  constructor(redis: Redis, logger: FastifyBaseLogger, maxlenApprox: number = 10000) {
    this.redis = redis;
    this.logger = logger;
    this.maxlenApprox = maxlenApprox;
  }

  async publish(tenantId: string, envelope: WebhookEnvelope): Promise<void> {
    const streamKey = `flow-engine:${tenantId}`;
    const data = JSON.stringify(envelope);

    try {
      await this.redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        this.maxlenApprox,
        '*',   // auto-generated stream ID
        // `kind` is written as its own field so the consumer can dispatch
        // message vs status envelopes without parsing the JSON body first.
        'kind',
        envelope.kind,
        'data',
        data,
      );
    } catch (err) {
      this.logger.error(
        {
          event: 'queue.publish_failed',
          stream_key: streamKey,
          tenant_id: tenantId,
          message_id: envelope.message_id,
          err,
        },
        'Failed to publish envelope to Redis Stream',
      );
      throw err;
    }
  }
}
