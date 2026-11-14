import { MERCHANT_WEBHOOK_EVENT_TYPES, buildSignedHeaders, type MerchantWebhookEventType } from '../merchant-webhooks.js';

/**
 * The public webhook event catalogue and the receiver guide (J-developer-10 #4, #6).
 *
 * Only what a merchant's receiver sees: the public type names, the body's shape, and how to check a delivery. No
 * internal subject, queue or service name appears here; the catalogue is written for the receiver, not copied from the
 * event bus. The body is the payment's STATE at the time of the event (merchant-webhooks.ts `paymentStateBody`).
 */

const DECIMAL = { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$', description: 'An exact decimal amount, as a string.' } as const;
const TIME = { type: 'string', format: 'date-time' } as const;

/** JSON Schema (draft 2020-12) for `data.payment`, the same for every payment event. */
const PAYMENT_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'merchantId',
    'profileId',
    'amount',
    'assetId',
    'method',
    'railAdapter',
    'railRef',
    'status',
    'mode',
    'capturedAmount',
    'refundedAmount',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', description: 'The payment id.' },
    merchantId: { type: 'string', description: 'Your merchant account id.' },
    profileId: { type: ['string', 'null'], description: 'The checkout profile that took it, if any.' },
    amount: DECIMAL,
    assetId: { type: 'string', description: 'The asset the amount is in, such as USDT.' },
    method: { type: 'string', description: 'How the payer paid: card, crypto or bank_transfer.' },
    railAdapter: { type: 'string', description: 'The payment rail that carried it.' },
    railRef: { type: ['string', 'null'], description: "The rail's own reference." },
    status: { type: 'string', description: 'The payment status when the event was written.' },
    mode: { type: 'string', enum: ['live', 'sandbox'], description: 'Live money, or sandbox test money.' },
    capturedAmount: DECIMAL,
    refundedAmount: DECIMAL,
    createdAt: TIME,
  },
} as const;

const envelope = (type: MerchantWebhookEventType) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'type', 'createdAt', 'data'],
  properties: {
    id: { type: 'string', description: 'The event id. The same event always carries the same id: use it to drop duplicates.' },
    type: { const: type },
    createdAt: { ...TIME, description: 'When the event was written. Use it, not arrival order, to order events.' },
    data: { type: 'object', required: ['payment'], properties: { payment: PAYMENT_SCHEMA } },
  },
});

const SUMMARY: Record<MerchantWebhookEventType, string> = {
  'payment.authorized': 'A payment was authorised: the payer approved it and the funds are held, not yet taken.',
  'payment.captured': 'A payment was captured: the funds were taken.',
  'payment.refunded': 'A payment was refunded, in full or in part. Each refunded total is its own event.',
  'payment.failed': 'A payment failed: the payer was declined or the rail refused it.',
};

export interface CatalogueEntry {
  readonly type: MerchantWebhookEventType;
  readonly summary: string;
  readonly payloadSchema: unknown;
}

export const webhookCatalogue = (): { events: CatalogueEntry[]; ordering: string; duplicates: string } => ({
  events: MERCHANT_WEBHOOK_EVENT_TYPES.map((type) => ({ type, summary: SUMMARY[type], payloadSchema: envelope(type) })),
  ordering:
    'Events can arrive out of order, and a retry can arrive after a later event. Order them by createdAt and the payment status in the body, never by arrival.',
  duplicates:
    'The same event can arrive more than once. Each delivery of one event has the same id and the same body: keep the ids you have handled and answer 2xx to a repeat without acting on it again.',
});

/** The published test vector: an example secret, never one of yours. Its signature is made by the delivery code itself. */
const VECTOR_SECRET = 'whsec_TEST_published_example_0123456789abcdef';
const VECTOR_TIMESTAMP = '1767225600';
const VECTOR_BODY =
  '{"id":"payment.captured:TEST-payment-1","type":"payment.captured","createdAt":"2026-01-01T00:00:00.000Z","data":{"payment":{"id":"TEST-payment-1","amount":"10.00","assetId":"USDT","status":"captured","mode":"sandbox"}}}';

export interface ReceiverGuide {
  readonly headers: { readonly timestamp: string; readonly signature: string; readonly eventId: string };
  readonly algorithm: string;
  /** Seconds a receiver should accept between our timestamp and its clock. Null: the owner has not set it. */
  readonly toleranceSeconds: number | null;
  /** Where deliveries come from. Null: not published yet. */
  readonly senderIps: readonly string[] | null;
  readonly vector: { readonly secret: string; readonly timestamp: string; readonly body: string; readonly signature: string };
}

export function receiverGuide(settings: { toleranceSeconds?: number; senderIps?: readonly string[] }): ReceiverGuide {
  const signature = buildSignedHeaders(VECTOR_SECRET, VECTOR_TIMESTAMP, VECTOR_BODY)['x-intafaced-signature']!;
  return {
    headers: { timestamp: 'X-Intafaced-Timestamp', signature: 'X-Intafaced-Signature', eventId: 'X-Intafaced-Event-Id' },
    algorithm:
      'HMAC-SHA256 with your endpoint secret over the timestamp header, a full stop, and the raw request body exactly as received, as lowercase hex. The signature header can hold several signatures separated by commas (while an old secret still overlaps a new one): accept the delivery if any one matches.',
    toleranceSeconds: settings.toleranceSeconds ?? null,
    senderIps: settings.senderIps && settings.senderIps.length > 0 ? [...settings.senderIps] : null,
    vector: { secret: VECTOR_SECRET, timestamp: VECTOR_TIMESTAMP, body: VECTOR_BODY, signature },
  };
}
