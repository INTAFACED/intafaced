import { z } from 'zod';
import { payPricingSnapshotViewSchema, payMerchantFailureSchema } from './pay-merchant-reads.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-pay's records share, moved from the service so the records and every caller read one copy. */

export const assetIdSchema = z.string().min(1).max(16);

/**
 * svc-pay's internal tRPC surface (§2 — cross-service calls go through
 * packages/contracts).
 *
 * MONEY CROSSES THIS BOUNDARY AS A DECIMAL STRING, always, in both directions.
 * `amountSchema` rejects anything else, including a JSON number, so a caller
 * that has been doing float arithmetic finds out here rather than 18 decimal
 * places later.
 *
 * Every procedure that moves value carries a scope AND the jurisdiction guard
 * (`{ module: 'pay' }`). §22: pay is a custodial Fiat Plane module — value
 * lands in a ledger account we control — so the matrix applies. Lane A
 * (permissionless merchant contracts, §24) is a different service on the
 * Protocol Plane and does not route through here.
 */
export const amountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

export const depositView = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  assetId: assetIdSchema,
  amount: amountSchema,
  rail: z.string(),
  railRef: z.string(),
  status: z.enum(['pending', 'credited']),
  createdAt: z.string().datetime({ offset: true }),
});

export const paymentView = z.object({
  id: z.string().guid(),
  merchantId: z.string().guid(),
  profileId: z.string().guid().nullable(),
  amount: amountSchema,
  assetId: assetIdSchema,
  method: z.string(),
  railAdapter: z.string(),
  railRef: z.string().nullable(),
  status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
  capturedAmount: amountSchema,
  refundedAmount: amountSchema,
  createdAt: z.string().datetime({ offset: true }),
  /** Stored when the fee was decided. Null when no snapshot row exists. Never recomputed. */
  pricingSnapshot: payPricingSnapshotViewSchema.nullable(),
  /** Catalog code and sentence. Null when the payment has not failed. */
  failure: payMerchantFailureSchema.nullable(),
});

export const limit = z.number().int().min(1).max(200);

export const id = z.string().guid();

/** `limit` is optional here so an omitted bound reaches `withdrawal_approval.list_limit_unset` and not a parse error. */
export const listInputSchema = z.object({ limit: limit.optional(), after: id.optional() }).strict();

export const APPROVAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'expired', 'canceled', 'failed'] as const;

export const requestViewSchema = z.object({
  id,
  userId: id,
  assetId: z.string(),
  amount: z.string(),
  rail: z.string(),
  destination: z.object({ kind: z.string(), ref: z.string() }),
  clientRef: z.string(),
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  approvalCount: z.number().int(),
  /** Whether the viewer already approved. A viewer who is not the initiator never sees who else did. */
  approvedByMe: z.boolean(),
  holdAtSubmit: z.boolean(),
  status: z.enum(APPROVAL_STATUSES),
  failureCode: z.string().nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
});

export const getInputSchema = z.object({ requestId: id }).strict();

export const decideInputSchema = z.object({ requestId: id }).strict();

/**
 * A checkout session on the wire.
 *
 * NOTHING HERE IDENTIFIES ANYTHING BUT THIS SESSION. No merchantId, no linkId,
 * no paymentId, no railAdapter — the caller is anonymous, so the response
 * carries what one payer needs in order to pay and nothing they could use to
 * enumerate a merchant or correlate two links.
 */
export const checkoutSessionView = z.object({
  id: z.string().guid(),
  status: z.enum(['open', 'completed', 'expired', 'cancelled']),
  label: z.string(),
  amount: amountSchema,
  currency: assetIdSchema,
  method: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
  instruction: z.object({ reference: z.string(), amount: amountSchema, currency: assetIdSchema }).nullable(),
  /** RC-merchant-09: the bank transfer arrived and is held for a payer-name review; nothing more should be sent. */
  heldForReview: z.boolean().optional(),
});
