// Schemas only the payments pages read. A package that reads a procedure not yet on main mirrors its branch contract here:
//   // mirrors <branch>:<path>; import from @intafaced/contracts after merge
// and parses tolerantly (unknown keys ignored, an array and a page both accepted).
import { z } from 'zod';
import { amount, asset, id } from '../../schemas';
import * as shared from '../schemas';

const timestamp = z.string().datetime({ offset: true });

export const invoiceStatuses = ['draft', 'sent', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

/** `merchantOps.invoices.*` on main (services/svc-pay/src/merchant-ops/invoices.ts, #4828). One amount and a description: no line items, no due date. */
export const invoiceSchema = z.object({
  id,
  status: z.enum(invoiceStatuses),
  assetId: asset,
  amount,
  customerRef: z.string().nullable(),
  description: z.string().nullable(),
  paymentLinkId: z.string().nullable(),
  paymentId: z.string().nullable(),
  sentAt: timestamp.nullable(),
  voidedAt: timestamp.nullable(),
  paidAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Invoice = z.infer<typeof invoiceSchema>;

/** What the payment link looks like after a send or a re-issue. The token is shown once, on the call that minted it. */
export const invoiceLinkSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  expiresAt: timestamp.nullable(),
  maxUses: z.number().int().nullable(),
  token: z.string().nullable(),
  alreadyIssued: z.boolean(),
});
export type InvoiceLink = z.infer<typeof invoiceLinkSchema>;

export const invoiceSentSchema = z.object({ invoice: invoiceSchema, paymentLink: invoiceLinkSchema.nullable() });
export type InvoiceSent = z.infer<typeof invoiceSentSchema>;

// mirrors origin/feat/pay-portal-be-reads-money:packages/contracts/src/pay-portal-reads.ts (payment.refunds.list); import from @intafaced/contracts after merge
export const paymentRefundRowSchema = z.object({
  id,
  refundId: z.string(),
  paymentId: id,
  amount,
  assetId: asset,
  status: z.enum(['posted', 'settled', 'reversed']),
  createdAt: timestamp,
  settledAt: timestamp.nullable().optional(),
});
export type PaymentRefundRow = z.infer<typeof paymentRefundRowSchema>;

/** `merchantOps.activity.list` on main (#4826). Details are an allowlist of short labels and amounts. */
export const activityItemSchema = z.object({
  id: z.string(),
  occurredAt: timestamp,
  actorId: z.string(),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  detail: z.record(z.string()),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

/** `merchantControl.tiers.list` on main: this merchant's own tier, or "not configured". Only the name is read here. */
export const ownTierSchema = z.union([
  z.object({ status: z.literal('not_configured') }),
  z.object({ status: z.literal('configured'), ownTierId: z.string(), tiers: z.array(z.object({ id: z.string(), name: z.string() })) }),
]);
export type OwnTier = z.infer<typeof ownTierSchema>;

/** `merchantOps.disputes.getEvidence` on main: the evidence row plus its bytes, for a signed-in session only. */
export const evidenceFileSchema = shared.evidenceSchema.extend({ contentBase64: z.string() });
export type EvidenceFile = z.infer<typeof evidenceFileSchema>;

/** `merchantOps.customers.series` on main (#4833): captured count and volume per day and asset. */
export const customerSeriesSchema = z.object({
  customerRef: z.string(),
  bucket: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(z.object({ period: z.string(), assetCode: asset, count: z.number().int(), volume: amount })),
  nextCursor: z.string().nullable(),
});
export type CustomerSeries = z.infer<typeof customerSeriesSchema>;
