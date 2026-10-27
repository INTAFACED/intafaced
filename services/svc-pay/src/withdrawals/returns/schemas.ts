import { z } from 'zod';

/**
 * Wire shapes for `founderAdmin.withdrawalReturns.*` (W-withdraw-07). Every input object is `.strict()`. Amounts are
 * decimal strings, never numbers. A blank reference or reason is a parse error, never a default.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const withdrawalId = z.string().guid();
const returnRef = z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/, "a return reference is the caller's own business key");
const reason = z.string().trim().min(1).max(500);
const limit = z.number().int().min(1).max(200);

/**
 * What a recorded return waits for before its funds are back in available: a second founder's approval. Returns recorded
 * before the returned-funds recipe existed carry `ledger.recipe_missing:userWithdrawReturned` as stored; the same approval
 * now credits them too.
 */
export const RETURN_BLOCKER = 'withdrawal_return.second_founder_required';

/** Why it came back, in words the customer may read. The free-text `reason` is the founders' own note. */
export const RETURN_REASON_CODES = ['destination_rejected', 'network_returned', 'other'] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];
const reasonCode = z.enum(RETURN_REASON_CODES);

export const recordInputSchema = z.object({ withdrawalId, returnRef, amount, reason, reasonCode }).strict();
export type RecordInput = z.infer<typeof recordInputSchema>;

export const getInputSchema = z.object({ withdrawalId }).strict();
export const listInputSchema = z.object({ limit, after: withdrawalId.optional() }).strict();
export type ListInput = z.infer<typeof listInputSchema>;

/** A second founder, never the one who recorded the return, puts the funds back in the person's available balance. */
export const recreditInputSchema = z.object({ withdrawalId, reason }).strict();
export type RecreditInput = z.infer<typeof recreditInputSchema>;

export const returnViewSchema = z.object({
  withdrawalId,
  returnRef: z.string(),
  userId: z.string().guid(),
  assetId: z.string(),
  amount: z.string(),
  reason: z.string(),
  /** Null on a return recorded before the code existed. */
  reasonCode: reasonCode.nullable(),
  /**
   * `parked`: recorded, nothing booked. `crediting`: a second founder approved it and the ledger's answer is not recorded
   * yet (the same approval again posts the same key). `credited`: the amount is back in the person's available balance.
   */
  state: z.enum(['parked', 'crediting', 'credited']),
  /** What it waits for while parked; null once approved. */
  blocker: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.string().datetime({ offset: true }),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().datetime({ offset: true }).nullable(),
  ledgerTxId: z.string().nullable(),
  creditedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ReturnView = z.infer<typeof returnViewSchema>;
