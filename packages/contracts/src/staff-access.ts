/**
 * A customer's own access list (J-cex-spot-18 #5, row d115: every read logged where the customer sees it): each trading
 * operator's read or act that named the signed-in person's account, with the operator and the time, newest first.
 * svc-trade `staffAccess.mine` (its `trade.operator_audit` rows). An operator's written reason is internal and is not in it.
 *
 * Browser-safe: zod only.
 */
import { z } from 'zod';

/** The most rows one read returns. */
export const STAFF_ACCESS_LIMIT_MAX = 200;

export const staffAccessMineInputSchema = z.object({ limit: z.number().int().min(1).max(STAFF_ACCESS_LIMIT_MAX) }).strict();

export const staffAccessRowSchema = z.object({
  id: z.string(),
  /** What was done, the operator record's own kind: `venue_orders.get` is a look at one of the person's routed orders. */
  kind: z.string(),
  operatorId: z.string(),
  /** What it was done to: an order id, a request id. */
  objectId: z.string(),
  occurredAt: z.string(),
});

export const staffAccessMineOutputSchema = z.object({ rows: z.array(staffAccessRowSchema) });

export type StaffAccessRow = z.infer<typeof staffAccessRowSchema>;
export type StaffAccessMineOutput = z.infer<typeof staffAccessMineOutputSchema>;
