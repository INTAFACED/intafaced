// Schemas only the payments pages read. A package that reads a procedure not yet on main mirrors its branch contract here:
//   // mirrors <branch>:<path>; import from @intafaced/contracts after merge
// and parses tolerantly (unknown keys ignored, an array and a page both accepted).
import { z } from 'zod';
import { amount, asset, id } from '../../schemas';

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
