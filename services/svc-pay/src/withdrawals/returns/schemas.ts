import { z } from 'zod';

/**
 * Wire shapes for `founderAdmin.withdrawalReturns.*` (W-withdraw-07). Every input object is `.strict()`. Amounts are
 * decimal strings, never numbers. A blank reference or reason is a parse error, never a default.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const withdrawalId = z.string().uuid();
const returnRef = z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/, "a return reference is the caller's own business key");
const reason = z.string().trim().min(1).max(500);
const limit = z.number().int().min(1).max(200);

/** The named blocker every recorded return carries until the returned-funds ledger recipe exists. */
export const RETURN_BLOCKER = 'ledger.recipe_missing:userWithdrawReturned';

export const recordInputSchema = z.object({ withdrawalId, returnRef, amount, reason }).strict();
export type RecordInput = z.infer<typeof recordInputSchema>;

export const getInputSchema = z.object({ withdrawalId }).strict();
export const listInputSchema = z.object({ limit, after: withdrawalId.optional() }).strict();
export type ListInput = z.infer<typeof listInputSchema>;

/** Re-crediting the customer needs the returned-funds recipe and a second person; both are named, neither is faked. */
export const recreditInputSchema = z.object({ withdrawalId, reason }).strict();

export const returnViewSchema = z.object({
  withdrawalId,
  returnRef: z.string(),
  userId: z.string().uuid(),
  assetId: z.string(),
  amount: z.string(),
  reason: z.string(),
  state: z.literal('parked'),
  /** What must exist before the funds can be re-credited. Nothing has been booked. */
  blocker: z.string(),
  recordedBy: z.string(),
  recordedAt: z.string().datetime({ offset: true }),
});
export type ReturnView = z.infer<typeof returnViewSchema>;
