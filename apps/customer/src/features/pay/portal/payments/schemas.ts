// Schemas only the payments pages read. A package that reads a procedure not yet on main mirrors its branch contract here:
//   // mirrors <branch>:<path>; import from @intafaced/contracts after merge
// and parses tolerantly (unknown keys ignored, an array and a page both accepted).
import { z } from 'zod';
import { amount, asset, id, linkSchema } from '../../schemas';
import * as shared from '../schemas';

const timestamp = z.string().datetime({ offset: true });

export const invoiceStatuses = ['draft', 'sent', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];
/** What a list and a filter can say. Overdue is not stored: it is a sent invoice whose due date has passed. */
export const invoiceDisplayStatuses = ['draft', 'sent', 'overdue', 'paid', 'void'] as const;
export type InvoiceDisplayStatus = (typeof invoiceDisplayStatuses)[number];

const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/);
/** One line of an invoice. A credit is stored with a negative `amount`; quantity and unit price are positive. */
export const invoiceLineSchema = z.object({
  kind: z.enum(['charge', 'credit']),
  description: z.string(),
  quantity: amount,
  unitAmount: amount,
  amount: signedDecimal,
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/**
 * `merchantOps.invoices.*` on main (services/svc-pay/src/merchant-ops/invoices.ts, #4828; due date, customer email and
 * line items #4919). The customer email arrives masked unless the signed-in person is the owner.
 */
export const invoiceSchema = z.object({
  id,
  status: z.enum(invoiceStatuses),
  assetId: asset,
  amount,
  customerRef: z.string().nullable(),
  customerEmail: z.string().nullable(),
  description: z.string().nullable(),
  dueAt: timestamp.nullable(),
  lineItems: z.array(invoiceLineSchema),
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
  detail: z.record(z.string(), z.string()),
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

/**
 * A payment link as the list returns it. `checkoutUrl` is read when the service sends one (the owner's own checkout
 * address, so the link can be copied, opened and scanned again later); an older service omits it and the page says so.
 * Only an http or https address is accepted.
 */
export const linkRowSchema = linkSchema.extend({
  // `prefix` (on linkSchema) is the short non-secret start of the token; `token` is the whole secret, only ever sent when the
  // service chooses to. Both are declared here so a parse never strips them.
  token: z.string().min(1).nullish(),
  // A full web address, or a path from the service's public base ("/api/pay/checkout?token=…"). The schema takes any string
  // so one odd row never fails the whole list; `addressOf` (Links.tsx) shows only an http(s) address or a path, else none.
  checkoutUrl: z.string().max(2048).nullish(),
  /** The catalogue price the link was made from (M-catalogue-03); null or absent when it was made without one. */
  priceId: z.string().nullish(),
});
export type LinkRow = z.infer<typeof linkRowSchema>;

/**
 * `merchant.checkoutSettings.get` on main (packages/contracts/src/pay-portal-reads.ts, #4871): the newest checkout
 * profile, or `not_configured`. `feeRouting` is null when this role may not see it. Nothing is filled in on the page.
 */
export const checkoutSettingsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured') }),
  z.object({
    status: z.literal('configured'),
    profileId: z.string(),
    checkoutConfig: z.record(z.string(), z.unknown()),
    feeRouting: z.record(z.string(), z.unknown()).nullable(),
    domains: z.array(z.string()),
    createdAt: timestamp,
  }),
]);
export type CheckoutSettings = z.infer<typeof checkoutSettingsSchema>;
