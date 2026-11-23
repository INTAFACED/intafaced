import type { EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';

/**
 * AN OPERATOR'S CORRECTIVE REVERSAL OF A POSTED TRANSACTION (OPS-ledger-desk-02, journey J-ops-console-05 steps 1-3).
 *
 * A posted transaction is never edited or deleted. When two founders approve a correction on the ops desk, the ledger
 * books one linked compensating transaction: every leg of the original with its direction flipped and the same amount,
 * so the pair nets to zero per account and so per asset. The original stays in the append-only journal.
 *
 * EVERY LEG COMES FROM THE STORED ORIGINAL. svc-ledger's `operatorReverse` door reads the original by id and builds the
 * post with this recipe (the Rust ledger holds the same recipe case for case, `crates/svc-ledger/src/reversal.rs`); a
 * caller names the original, never its legs. That is why this is not in `recipes` and holds no grant on `/trpc/post`:
 * the recipe gate judges a post by fixed leg shapes, and a reversal's legs are whatever the original's were, so a
 * hand-assembled reversal must never pass that door.
 *
 * The key is `ops:reversal:<originalTxId>:<n>`, `n` the desk's own stored ordinal for the approved correction, so a
 * retried approval resolves to the same booking. One original has at most one reversal: the database holds that
 * (`ledger_tx_one_operator_reversal_idx`), and the door refuses a second key with `ledger.reversal_already_reversed`.
 */

export const OPERATOR_REVERSAL_MODULE = 'ops';
export const OPERATOR_REVERSAL_REASON = 'operator.reversal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A whole number from one, as a decimal string: never a JS number. */
const ORDINAL = /^[1-9][0-9]{0,18}$/;

export interface OperatorReverseInput {
  /** The original transaction's id, from the book. */
  readonly originalTxId: string;
  /** The original's legs as the book stored them. */
  readonly entries: readonly EntryInput[];
  /** The desk's stored ordinal for this correction: a whole number from one, as a decimal string. */
  readonly ordinal: string;
  /** Why the operators reverse it, as approved. */
  readonly why: string;
  /** The desk's case reference for the approval. */
  readonly caseRef: string;
}

/** `ops:reversal:<originalTxId lower-cased>:<n>`. */
export function operatorReversalKey(originalTxId: string, ordinal: string): string {
  if (typeof originalTxId !== 'string' || !UUID.test(originalTxId)) {
    throw new InvalidEntryError('A reversal names the original transaction by its id (a UUID)');
  }
  if (typeof ordinal !== 'string' || !ORDINAL.test(ordinal)) {
    throw new InvalidEntryError('A reversal ordinal is a whole number from one, as a decimal string');
  }
  return `ops:reversal:${originalTxId.toLowerCase()}:${ordinal}`;
}

export function operatorReverse(input: OperatorReverseInput): PostRequest {
  const idempotencyKey = operatorReversalKey(input.originalTxId, input.ordinal);
  const why = typeof input.why === 'string' ? input.why.trim() : '';
  if (why === '') throw new InvalidEntryError('A reversal needs the reason the operators approved');
  const caseRef = typeof input.caseRef === 'string' ? input.caseRef.trim() : '';
  if (caseRef === '') throw new InvalidEntryError('A reversal needs the case reference of its approval');
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new InvalidEntryError('A reversal needs the original transaction legs');
  }
  return {
    idempotencyKey,
    module: OPERATOR_REVERSAL_MODULE,
    reason: OPERATOR_REVERSAL_REASON,
    meta: { reverses: input.originalTxId.toLowerCase(), caseRef, why },
    entries: input.entries.map((e) => ({
      account: e.account,
      direction: e.direction === 'debit' ? 'credit' : 'debit',
      amount: e.amount,
    })),
  };
}
