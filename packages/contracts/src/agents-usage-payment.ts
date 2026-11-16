import { z } from 'zod';

/**
 * AGENTS USAGE PAYMENT: the S2S door svc-agents uses to learn how a person pays for agent usage, and to collect one
 * sealed usage window from them (J-agents-01; launch money model, docs/adr/2026-11-10-launch-money-model.md).
 *
 * At launch INTAFACED holds no customer money (OWNER 226). A usage window is earned in our ledger as owed by the person
 * (`chargeEarn`), and collected from their payment method by their partner, which carries the payment out for them; the
 * partner's payment id is the one fact the ledger's `chargeCollect` is keyed on. svc-agents never reads svc-bank's
 * tables or the partner; it asks this route, signed as `svc-agents`.
 *
 *   read     where the person's money is held, and, at the partner, what it reports as available in that asset.
 *   collect  one payment from the person's main balance at the partner to INTAFACED's own account there, under the
 *            window's business key: the same key is the same payment, once, however many times it is asked.
 *
 * A business team's run (J-agents-11) is paid by the business: the request names `businessId`, the member is still
 * `userId`, and svc-bank answers for the business's payment method (its first administrator's main balance at the
 * partner; a business account holds no money of its own), never the member's.
 *
 * `heldBy: 'ledger'` is the custodial layer (the journeys marked Later): the window is charged on the ledger as before.
 * `heldBy: 'none'` is a person with no payment method: nothing can be collected, and a run refuses before it starts.
 * Amounts are decimal strings, never numbers.
 */

export const AGENTS_USAGE_PAYMENT_PATH = '/internal/agents/usage-payment' as const;

const decimal = z.string().regex(/^\d{1,30}(\.\d{1,18})?$/);
const asset = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const agentsUsagePaymentRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('read'),
      userId: z.string().uuid(),
      assetId: asset,
      /** A team run's business: the business pays, not the member (`userId`). */
      businessId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('collect'),
      userId: z.string().uuid(),
      assetId: asset,
      amount: decimal,
      /** The window's business key (`agent.usage:<session>:<window>`): one key is one payment. */
      chargeKey: z.string().regex(/^agent\.usage:[^\s]{1,160}$/),
      /** A team run's business: the business pays, not the member (`userId`). */
      businessId: z.string().uuid().optional(),
    })
    .strict(),
]);
export type AgentsUsagePaymentRequest = z.infer<typeof agentsUsagePaymentRequestSchema>;

/** Why a collect made no payment. Nothing moved at the partner for any of them, except `reply_lost` (not known). */
export const AGENTS_USAGE_PAYMENT_REFUSALS = [
  /** The partner reports less than the amount in the person's main balance. */
  'insufficient_funds',
  /** The partner is not answering. */
  'partner_unavailable',
  /** The partner's answer was lost: the payment may have been made. Ask again under the same key. */
  'reply_lost',
  /** svc-ledger's posting freeze is on, or could not be read. */
  'posting_frozen',
  /** An operator's stop on this partner's moves is on, or could not be read. */
  'partner_stopped',
  /** The person's money is not at a partner (custodial, or no payment method): nothing to collect from there. */
  'not_partner_held',
] as const;
export type AgentsUsagePaymentRefusal = (typeof AGENTS_USAGE_PAYMENT_REFUSALS)[number];

export const agentsUsagePaymentReadSchema = z.discriminatedUnion('heldBy', [
  z.object({ heldBy: z.literal('ledger') }).strict(),
  z.object({ heldBy: z.literal('none') }).strict(),
  z
    .object({
      heldBy: z.literal('partner'),
      /** The partner's name for itself on this stack (`TEST partner bank`). */
      label: z.string().min(1).max(64),
      /** What the partner reports in the person's main balance; null is "not known", never 0. */
      available: decimal.nullable(),
      asOf: z.string().datetime().nullable(),
    })
    .strict(),
]);
export type AgentsUsagePaymentRead = z.infer<typeof agentsUsagePaymentReadSchema>;

export const agentsUsagePaymentCollectSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      /** The partner's own id for the payment: what the ledger's collect is keyed on. */
      paymentId: z.string().regex(/^[^\s:]{1,128}$/),
      /** The partner that carried it out, by the id our ledger names its reserve with (`partner-reserve:<id>`). */
      partnerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      label: z.string().min(1).max(64),
      amount: decimal,
      paidAt: z.string().datetime(),
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.enum(AGENTS_USAGE_PAYMENT_REFUSALS) }).strict(),
]);
export type AgentsUsagePaymentCollect = z.infer<typeof agentsUsagePaymentCollectSchema>;
