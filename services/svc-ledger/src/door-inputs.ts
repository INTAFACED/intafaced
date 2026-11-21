import { z } from 'zod';

/**
 * The inputs of the served doors that parse their body with a schema of this service's own, in one file so that what
 * each door accepts is read in one place: by `s2s-http.ts` and `operator-http.ts`, and by the Rust port's recorder
 * (`crates/svc-ledger/scripts/record-door.mjs`), which holds the Rust door's input checks to these.
 */

/** `balances`: one owner. */
export const balancesInput = z.object({
  ownerType: z.enum(['user', 'subaccount', 'module', 'house', 'treasury']),
  ownerId: z.string(),
});

/** `portfolio`: the same owner, and optionally the 0x account whose chain positions join the book's balances. */
export const portfolioS2sInput = balancesInput.extend({
  chainAccount: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

/** `txByKey`: one idempotency key. */
export const txByKeyInput = z.object({ idempotencyKey: z.string().min(1).max(512) });

/** `txById`: one transaction id, a UUID, refused before it reaches the database as a malformed-uuid error. */
export const txByIdInput = z.object({ txId: z.string().guid() });

/** `/operator/freeze`: why, and the approval it spends. */
export const freezeSchema = z.object({
  /**
   * Required, and required to be useful. The database's own check constraint
   * refuses an unattributed freeze; this refuses an unexplained one, because
   * `reason` is what the next operator reads before deciding whether to thaw.
   * Trim first so twelve spaces cannot satisfy `min(12)` with no readable text.
   */
  reason: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(12).max(500)),
  /** Display-only. Never authority. */
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});

/** `/operator/unfreeze`: the approval it spends. `confirmOperatorId` is display-only, never authority. */
export const thawSchema = z.object({
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});

/** `/operator/reconcile`: the approval it spends. */
export const reconcileSchema = z.object({
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
});
