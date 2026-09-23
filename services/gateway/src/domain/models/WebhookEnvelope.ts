/**
 * Domain model representing an inbound Meta webhook event after it has been
 * verified and enriched with tenant context. This is the shape written to the
 * Redis Stream "flow-engine:{tenantId}" and must match
 * contracts/flow-engine-message.schema.json exactly.
 */
export interface MetaMessageItem {
  from: string;
  id: string;
  timestamp: string;
  type:
    | 'text'
    | 'interactive'
    | 'image'
    | 'document'
    | 'audio'
    | 'video'
    | 'sticker'
    | 'location'
    | 'contacts'
    | 'reaction'
    | 'order'
    | 'system'
    | 'unknown';
  text?: { body: string };
  interactive?: Record<string, unknown>;
}

export interface MetaStatusItem {
  /** Meta message id (wamid) of the message this status refers to. */
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted' | 'warning' | string;
  timestamp: string;
  recipient_id?: string;
  conversation?: {
    id?: string;
    expiration_timestamp?: string;
    origin?: { type?: string };
  };
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
  };
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
}

export interface MetaWebhookValue {
  messaging_product: 'whatsapp';
  metadata: {
    display_phone_number?: string;
    phone_number_id: string;
  };
  contacts?: Array<{
    profile?: { name?: string };
    wa_id?: string;
  }>;
  messages?: MetaMessageItem[];
  statuses?: MetaStatusItem[];
}

/**
 * `message` envelopes carry one inbound message; `status` envelopes carry one
 * delivery/read/failure callback. The gateway emits one envelope per item so a
 * batched Meta payload cannot silently drop anything.
 */
export type WebhookEnvelopeKind = 'message' | 'status';

export interface WebhookEnvelope {
  /**
   * Internal UUIDv4 trace id allocated by the gateway. Used for log
   * correlation only — NOT as the idempotency key (see `wamid`).
   */
  message_id: string;
  /**
   * Idempotency key. For messages this is Meta's own message id (`wamid...`);
   * for statuses it is `wamid:status:timestamp`. Using Meta's identifier means
   * Meta's own webhook re-deliveries are correctly de-duplicated.
   */
  wamid: string;
  /** Discriminator so consumers can dispatch without parsing `raw`. */
  kind: WebhookEnvelopeKind;
  /** ISO 8601 timestamp at which the gateway received the webhook. */
  received_at: string;
  /** Tenant UUID resolved from phone_number_id. */
  tenant_id: string;
  /** Meta phone number ID from webhook metadata. */
  phone_number_id: string;
  /** The single Meta item this envelope represents. */
  raw: MetaWebhookValue;
}
