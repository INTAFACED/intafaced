import { z } from 'zod';

/**
 * Every event on the bus is wrapped in this envelope. Consumers can be written
 * generically against it; nothing is ever published as a bare payload.
 *
 * §10: "versioned payloads in packages/events, consumers idempotent".
 *  - `version` is per-subject and monotonic. Breaking a payload means bumping it
 *    and running both versions until consumers migrate.
 *  - `idempotencyKey` is what a consumer dedupes on. It is REQUIRED, because
 *    at-least-once delivery is the only delivery we get.
 *  - `traceparent` carries the W3C trace context so a ledger post initiated by
 *    an HTTP request stays on one trace (§9).
 */

export const envelopeSchema = z.object({
  /** Unique per publish attempt. */
  id: z.string().guid(),
  subject: z.string(),
  version: z.number().int().min(1),
  /** When the fact happened — not when it was published. */
  occurredAt: z.string().datetime({ offset: true }),
  /** Service that produced it. */
  producer: z.string().min(1),
  /**
   * Consumer dedupe key. Two envelopes with the same key describe the same
   * fact and must be processed at most once.
   */
  idempotencyKey: z.string().min(1),
  /** W3C traceparent, when the producer was inside a trace. */
  traceparent: z.string().optional(),
  /** The event/command that caused this one. */
  causationId: z.string().optional(),
  /** Stable across a whole business flow (an order, a payment, a trade). */
  correlationId: z.string().optional(),
  payload: z.unknown(),
});

export type Envelope<T = unknown> = Omit<z.infer<typeof envelopeSchema>, 'payload'> & { payload: T };

export interface EnvelopeInit<T> {
  subject: string;
  version: number;
  producer: string;
  idempotencyKey: string;
  payload: T;
  occurredAt?: Date;
  traceparent?: string;
  causationId?: string;
  correlationId?: string;
}

export function createEnvelope<T>(init: EnvelopeInit<T>): Envelope<T> {
  return {
    id: crypto.randomUUID(),
    subject: init.subject,
    version: init.version,
    occurredAt: (init.occurredAt ?? new Date()).toISOString(),
    producer: init.producer,
    idempotencyKey: init.idempotencyKey,
    ...(init.traceparent ? { traceparent: init.traceparent } : {}),
    ...(init.causationId ? { causationId: init.causationId } : {}),
    ...(init.correlationId ? { correlationId: init.correlationId } : {}),
    payload: init.payload,
  };
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env));
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Malformed event envelope: ${result.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
  }
  return result.data as Envelope;
}
