import type { IMessageQueue } from '../../src/domain/ports/IMessageQueue.js';
import type { ITenantCache } from '../../src/domain/ports/ITenantCache.js';
import type { WebhookEnvelope } from '../../src/domain/models/WebhookEnvelope.js';
import { TenantNotFoundError } from '../../src/domain/errors.js';
import { ProcessWebhookUseCase } from '../../src/application/ProcessWebhookUseCase.js';
import type { FastifyBaseLogger } from 'fastify';

// ---------------------------------------------------------------------------
// Hand-rolled in-memory fakes (no mocking library — fakes couple to ports only)
// ---------------------------------------------------------------------------

class FakeTenantCache implements ITenantCache {
  private readonly mapping: Map<string, string>;
  lookups: string[] = [];

  constructor(mapping: Record<string, string> = {}) {
    this.mapping = new Map(Object.entries(mapping));
  }

  async getTenantId(phoneNumberId: string): Promise<string> {
    this.lookups.push(phoneNumberId);
    const tenantId = this.mapping.get(phoneNumberId);
    if (!tenantId) throw new TenantNotFoundError(phoneNumberId);
    return tenantId;
  }
}

class FakeMessageQueue implements IMessageQueue {
  published: Array<{ tenantId: string; envelope: WebhookEnvelope }> = [];

  async publish(tenantId: string, envelope: WebhookEnvelope): Promise<void> {
    this.published.push({ tenantId, envelope });
  }
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => noopLogger,
} as unknown as FastifyBaseLogger;

// ---------------------------------------------------------------------------
// Sample Meta payload factories
// ---------------------------------------------------------------------------

function makePayload(phoneNumberId: string, messageId = 'wamid.test-001') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp' as const,
              metadata: {
                display_phone_number: '+1234567890',
                phone_number_id: phoneNumberId,
              },
              contacts: [{ profile: { name: 'Test User' }, wa_id: '5491155555555' }],
              messages: [
                {
                  from: '5491155555555',
                  id: messageId,
                  timestamp: '1716000000',
                  type: 'text' as const,
                  text: { body: 'Hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function makeStatusPayload(
  phoneNumberId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed' = 'delivered',
  timestamp = '1716000100',
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: 'whatsapp' as const,
              metadata: { phone_number_id: phoneNumberId },
              statuses: [
                {
                  id: 'wamid.status-001',
                  status,
                  timestamp,
                  recipient_id: '5491155555555',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessWebhookUseCase', () => {
  const PHONE_ID = 'PNID_0001';
  const TENANT_ID = 'tenant-uuid-0001';
  const RECEIVED_AT = '2026-05-16T12:00:00.000Z';

  test('happy path: enqueues with correct envelope shape', async () => {
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await useCase.execute(makePayload(PHONE_ID), RECEIVED_AT);

    expect(queue.published).toHaveLength(1);
    const { tenantId, envelope } = queue.published[0]!;
    expect(tenantId).toBe(TENANT_ID);
    expect(envelope.tenant_id).toBe(TENANT_ID);
    expect(envelope.phone_number_id).toBe(PHONE_ID);
    expect(envelope.received_at).toBe(RECEIVED_AT);
    expect(envelope.kind).toBe('message');
    expect(envelope.raw.messaging_product).toBe('whatsapp');
    expect(envelope.raw.messages?.[0]?.id).toBe('wamid.test-001');
  });

  test('uses Meta\'s own message id (wamid) as the idempotency key', async () => {
    // Regression guard for the duplicate-reply defect: the key used to be a
    // fresh random UUID per delivery, so a Meta retry produced a second reply.
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await useCase.execute(makePayload(PHONE_ID, 'wamid.ABC123'), RECEIVED_AT);

    const { envelope } = queue.published[0]!;
    expect(envelope.wamid).toBe('wamid.ABC123');
    // An internal trace id is still allocated, purely for log correlation.
    expect(envelope.message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(envelope.message_id).not.toBe(envelope.wamid);
  });

  test('two deliveries of the same Meta message share one wamid but differ in trace id', async () => {
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await useCase.execute(makePayload(PHONE_ID, 'wamid.DUP'), RECEIVED_AT);
    await useCase.execute(makePayload(PHONE_ID, 'wamid.DUP'), RECEIVED_AT);

    expect(queue.published).toHaveLength(2);
    expect(queue.published[0]!.envelope.wamid).toBe('wamid.DUP');
    expect(queue.published[1]!.envelope.wamid).toBe('wamid.DUP');
    expect(queue.published[0]!.envelope.message_id).not.toBe(
      queue.published[1]!.envelope.message_id,
    );
  });

  test('emits one envelope per message when Meta batches several', async () => {
    // Previously a whole `value` collapsed into a single envelope holding
    // messages[0], so every additional message in the batch was lost.
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    const payload = makePayload(PHONE_ID, 'wamid.first');
    payload.entry[0]!.changes[0]!.value.messages.push({
      from: '5491155555555',
      id: 'wamid.second',
      timestamp: '1716000001',
      type: 'text' as const,
      text: { body: 'Second' },
    });

    await useCase.execute(payload, RECEIVED_AT);

    expect(queue.published).toHaveLength(2);
    expect(queue.published.map((p) => p.envelope.wamid)).toEqual([
      'wamid.first',
      'wamid.second',
    ]);
    expect(queue.published.every((p) => p.envelope.kind === 'message')).toBe(true);
  });

  test('delivery status updates are enqueued as kind=status (previously dropped)', async () => {
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await useCase.execute(makeStatusPayload(PHONE_ID), RECEIVED_AT);

    expect(queue.published).toHaveLength(1);
    const { envelope } = queue.published[0]!;
    expect(envelope.kind).toBe('status');
    expect(envelope.raw.statuses?.[0]?.status).toBe('delivered');
    expect(envelope.raw.messages).toBeUndefined();
  });

  test('status wamid distinguishes transitions so none are de-duplicated away', async () => {
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await useCase.execute(makeStatusPayload(PHONE_ID, 'sent', '1716000100'), RECEIVED_AT);
    await useCase.execute(makeStatusPayload(PHONE_ID, 'delivered', '1716000200'), RECEIVED_AT);
    await useCase.execute(makeStatusPayload(PHONE_ID, 'read', '1716000300'), RECEIVED_AT);
    // A retry of the *same* transition must keep the same key.
    await useCase.execute(makeStatusPayload(PHONE_ID, 'read', '1716000300'), RECEIVED_AT);

    const wamids = queue.published.map((p) => p.envelope.wamid);
    expect(wamids).toEqual([
      'wamid.status-001:sent:1716000100',
      'wamid.status-001:delivered:1716000200',
      'wamid.status-001:read:1716000300',
      'wamid.status-001:read:1716000300',
    ]);
    expect(new Set(wamids).size).toBe(3);
  });

  test('a payload carrying both messages and statuses produces both kinds', async () => {
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    const payload = makePayload(PHONE_ID, 'wamid.both');
    Object.assign(payload.entry[0]!.changes[0]!.value, {
      statuses: [{ id: 'wamid.both', status: 'delivered', timestamp: '1716000002' }],
    });

    await useCase.execute(payload, RECEIVED_AT);

    expect(queue.published.map((p) => p.envelope.kind)).toEqual(['message', 'status']);
  });

  test('TenantNotFoundError: skips enqueue and logs warning (no throw)', async () => {
    const cache = new FakeTenantCache({}); // empty — nothing maps PHONE_ID
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await expect(useCase.execute(makePayload(PHONE_ID), RECEIVED_AT)).resolves.toBeUndefined();
    expect(queue.published).toHaveLength(0);
  });

  test('an unknown phone number also drops status events', async () => {
    const cache = new FakeTenantCache({});
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await useCase.execute(makeStatusPayload(PHONE_ID), RECEIVED_AT);
    expect(queue.published).toHaveLength(0);
  });

  test('empty payload (no entry) resolves without error', async () => {
    const cache = new FakeTenantCache({});
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    await expect(useCase.execute({}, RECEIVED_AT)).resolves.toBeUndefined();
    expect(queue.published).toHaveLength(0);
  });

  test('missing phone_number_id in metadata is skipped gracefully', async () => {
    const cache = new FakeTenantCache({ [PHONE_ID]: TENANT_ID });
    const queue = new FakeMessageQueue();
    const useCase = new ProcessWebhookUseCase({ tenantCache: cache, messageQueue: queue, logger: noopLogger });

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp' as const,
                metadata: { phone_number_id: '' }, // empty
                messages: [{ from: '123', id: 'wamid.x', timestamp: '1', type: 'text' as const }],
              },
            },
          ],
        },
      ],
    };

    // empty phone_number_id treated as falsy — skipped
    await expect(useCase.execute(payload, RECEIVED_AT)).resolves.toBeUndefined();
    expect(queue.published).toHaveLength(0);
  });
});
