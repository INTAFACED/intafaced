import { z } from 'zod';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { identitySecretSet } from './identity-grounding-honesty.js';

/**
 * SUPPORT READ OF ONE ORDER (SUP-0007).
 *
 * The order row lives in svc-trade. This desk does not copy it, and it does
 * not cancel, amend, delete, or post. The only method on the port is `read`.
 * A dark plane, a silent trade process, and a matcher that is down all answer
 * `unknown` with `cancelled: false`. They never invent `cancelled`.
 *
 * Amounts stay decimal strings. The regex is the contracts wire rule
 * (`packages/contracts/src/instruments.ts` decimalString): a JSON number is
 * refused, not coerced.
 */

/** Statuses svc-trade already stores. `recovery_required` is one of them. */
export const SUPPORT_ORDER_STATUSES = [
  'pending',
  'open',
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'recovery_required',
  'hold_unknown',
] as const;

export type SupportOrderStatus = (typeof SUPPORT_ORDER_STATUSES)[number];

const decimalString = z
  .string({ invalid_type_error: 'JS number refused — amounts are decimal strings' })
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

export const supportOrderSnapshotSchema = z
  .object({
    orderId: z.string().uuid(),
    userId: z.string().uuid(),
    status: z.enum(SUPPORT_ORDER_STATUSES),
    symbol: z.string().regex(/^[A-Z0-9][A-Z0-9./_-]{0,40}$/),
    side: z.enum(['buy', 'sell']),
    filledQuantity: decimalString,
    feeAsset: z.string().regex(/^[A-Z0-9]{1,16}$/),
    feeAmount: decimalString,
  })
  .strict();

export type SupportOrderSnapshot = z.infer<typeof supportOrderSnapshotSchema>;

export type TicketOrderUnknownReason = 'trade_silent' | 'matcher_down';

export type TicketOrderReadResult = { kind: 'order'; order: SupportOrderSnapshot } | { kind: 'unknown'; reason: TicketOrderUnknownReason };

export interface TicketOrderSource {
  read(orderId: string): Promise<TicketOrderReadResult>;
}

export const ticketOrderReadSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('read'),
      orderId: z.string().uuid(),
      status: z.enum(SUPPORT_ORDER_STATUSES),
      symbol: z.string(),
      side: z.enum(['buy', 'sell']),
      filledQuantity: decimalString,
      feeAsset: z.string(),
      feeAmount: decimalString,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('unknown'),
      orderId: z.string().uuid(),
      reason: z.enum(['trade_silent', 'matcher_down']),
      cancelled: z.literal(false),
    })
    .strict(),
]);

export type TicketOrderRead = z.infer<typeof ticketOrderReadSchema>;

export const SUPPORT_ORDER_USER_MISMATCH = 'support.order.user_mismatch' as const;

/** No trade dependency. Every read is unknown, and nothing is cancelled. */
export class DarkTicketOrderSource implements TicketOrderSource {
  async read(_orderId: string): Promise<TicketOrderReadResult> {
    return { kind: 'unknown', reason: 'trade_silent' };
  }
}

export const SUPPORT_ORDER_READ_PATH = '/internal/orders/';

/**
 * GET one order from svc-trade. Never POST, PATCH, or DELETE.
 *
 * The route is the consumer contract. Until trade serves it, a configured URL
 * that does not answer is `trade_silent`, which the desk shows as unknown.
 */
export function createTicketOrderClient(
  baseUrl: string,
  internalSecret: string,
  /** svc-support's own key. With it the call is key-signed for svc-trade; `dual` also sends the shared-secret form. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): TicketOrderSource {
  if (!identitySecretSet(internalSecret)) return new DarkTicketOrderSource();

  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-trade', legacySecret: internalSecret, s2s });

  return {
    async read(orderId: string): Promise<TicketOrderReadResult> {
      let response: Response;
      try {
        const target = `${url}${SUPPORT_ORDER_READ_PATH}${encodeURIComponent(orderId)}`;
        response = await fetch(target, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            // No content-type is sent on this read, so none is signed: the signature commits to the headers as they go out.
            ...sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          },
        });
      } catch {
        return { kind: 'unknown', reason: 'trade_silent' };
      }

      if (response.status === 503) return { kind: 'unknown', reason: 'matcher_down' };

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'unknown', reason: 'trade_silent' };
      }

      if (!response.ok) {
        const code = typeof body === 'object' && body !== null && 'code' in body ? (body as { code?: unknown }).code : undefined;
        if (code === 'matcher_down') return { kind: 'unknown', reason: 'matcher_down' };
        return { kind: 'unknown', reason: 'trade_silent' };
      }

      const parsed = supportOrderSnapshotSchema.safeParse(body);
      if (!parsed.success || parsed.data.orderId !== orderId) return { kind: 'unknown', reason: 'trade_silent' };
      return { kind: 'order', order: parsed.data };
    },
  };
}
