import { z } from 'zod';

/**
 * J-merchant-06: the browser-safe answers of svc-pay's refund controls (`payment.refundCheck`, `payment.refundRequests.*`,
 * `payment.reverse`, `payment.bulkRefund`). Amounts are decimal strings; nothing here is a balance the browser computes.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

export const payRefundRequestStatusSchema = z.enum(['queued', 'approved', 'refunded', 'failed', 'rejected', 'cancelled', 'voided']);

/** A refund that waits for approval, and what became of it. */
export const payRefundRequestSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  paymentId: z.string(),
  assetId: z.string(),
  amount,
  refundId: z.string(),
  status: payRefundRequestStatusSchema,
  makerUserId: z.string(),
  checkerUserId: z.string().nullable(),
  checkerReason: z.string().nullable(),
  failureCode: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type PayRefundRequest = z.infer<typeof payRefundRequestSchema>;

/** What a refund of one payment would do now: the most it can refund, the balance that funds it, what blocks it. */
export const payRefundCheckSchema = z.object({
  paymentId: z.string(),
  assetId: z.string(),
  maxRefundable: amount,
  source: z.enum(['clearing', 'settled']),
  fundingBalance: amount,
  blockedBy: z.enum(['pay.refund_open_dispute', 'pay.nothing_captured', 'pay.refund_nothing_left']).nullable(),
  approvalThreshold: amount.nullable(),
});
export type PayRefundCheck = z.infer<typeof payRefundCheckSchema>;

/** The payment as a refund-control door answers it: only the fields the portal reads. */
export const payRefundControlPaymentSchema = z.object({ id: z.string(), status: z.string(), refundedAmount: amount, assetId: z.string() });

/** `payment.reverse`: which way the server undid the payment, and how much went back. */
export const payReverseOutSchema = z.object({ used: z.enum(['void', 'refund']), amount, payment: payRefundControlPaymentSchema });

/** `payment.bulkRefund`: each row's outcome under its own refund key. */
export const payBulkRefundRowSchema = z.object({
  row: z.number().int(),
  paymentId: z.string(),
  amount: amount.nullable(),
  refundId: z.string(),
  outcome: z.enum(['pending', 'refunded', 'refused', 'unknown']),
  refusalCode: z.string().nullable(),
});
export const payBulkRefundOutSchema = z.object({ batchId: z.string(), rows: z.array(payBulkRefundRowSchema) });
