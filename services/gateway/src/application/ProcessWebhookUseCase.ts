import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { IMessageQueue } from '../domain/ports/IMessageQueue.js';
import type { ITenantCache } from '../domain/ports/ITenantCache.js';
import type { MetaWebhookValue, WebhookEnvelope } from '../domain/models/WebhookEnvelope.js';
import { TenantNotFoundError } from '../domain/errors.js';

export interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: MetaWebhookValue;
    }>;
  }>;
}

export interface ProcessWebhookDeps {
  tenantCache: ITenantCache;
  messageQueue: IMessageQueue;
  logger: FastifyBaseLogger;
}

/**
 * Application use case — orchestrates the full webhook processing pipeline:
 *   1. Extract all value objects from the parsed Meta payload
 *   2. For each value: resolve tenant_id via cache (Redis → Postgres fallback)
 *   3. Build a WebhookEnvelope and enqueue it on the Redis Stream
 *
 * This is intentionally side-effect-free from an HTTP perspective: all errors
 * are caught and logged. The caller (HTTP handler) has already returned 200 OK
 * to Meta by the time this runs, so failures here must never propagate upward.
 */
export class ProcessWebhookUseCase {
  private readonly tenantCache: ITenantCache;
  private readonly messageQueue: IMessageQueue;
  private readonly logger: FastifyBaseLogger;

  constructor({ tenantCache, messageQueue, logger }: ProcessWebhookDeps) {
    this.tenantCache = tenantCache;
    this.messageQueue = messageQueue;
    this.logger = logger;
  }

  async execute(payload: MetaWebhookPayload, receivedAt: string): Promise<void> {
    const entries = payload.entry ?? [];

    for (const entry of entries) {
      const changes = entry.changes ?? [];

      for (const change of changes) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) {
          this.logger.warn({ event: 'webhook.missing_phone_number_id' }, 'No phone_number_id in metadata, skipping');
          continue;
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];

        if (messages.length === 0 && statuses.length === 0) {
          this.logger.debug(
            { event: 'webhook.unhandled_event' },
            'Ignoring webhook event with no messages or statuses',
          );
          continue;
        }

        let tenantId: string;
        try {
          tenantId = await this.tenantCache.getTenantId(phoneNumberId);
        } catch (err) {
          if (err instanceof TenantNotFoundError) {
            this.logger.warn(
              { event: 'webhook.unknown_phone_number', phone_number_id: phoneNumberId },
              'Unknown phone_number_id — skipping entry',
            );
            continue;
          }
          throw err;
        }

        // One envelope per item: a batched Meta payload used to collapse to a
        // single envelope holding messages[0], silently dropping the rest.
        for (const message of messages) {
          await this.publish(tenantId, phoneNumberId, receivedAt, {
            wamid: message.id,
            kind: 'message',
            raw: { ...value, messages: [message], statuses: undefined },
          });
        }

        for (const status of statuses) {
          await this.publish(tenantId, phoneNumberId, receivedAt, {
            // Include the status and timestamp so a message's
            // sent → delivered → read progression is not de-duplicated away,
            // while a re-delivery of the same transition still is.
            wamid: `${status.id}:${status.status}:${status.timestamp}`,
            kind: 'status',
            raw: { ...value, messages: undefined, statuses: [status] },
          });
        }
      }
    }
  }

  /** Build and enqueue a single envelope. */
  private async publish(
    tenantId: string,
    phoneNumberId: string,
    receivedAt: string,
    item: Pick<WebhookEnvelope, 'wamid' | 'kind' | 'raw'>,
  ): Promise<void> {
    const envelope: WebhookEnvelope = {
      message_id: randomUUID(),
      wamid: item.wamid,
      kind: item.kind,
      received_at: receivedAt,
      tenant_id: tenantId,
      phone_number_id: phoneNumberId,
      raw: item.raw,
    };

    await this.messageQueue.publish(tenantId, envelope);

    this.logger.info(
      {
        event: 'webhook.enqueued',
        kind: envelope.kind,
        tenant_id: tenantId,
        phone_number_id: phoneNumberId,
        wamid: envelope.wamid,
        message_id: envelope.message_id,
      },
      'Webhook envelope enqueued',
    );
  }
}
