import { z } from 'zod';
import { formatAmount, type LedgerTx } from '@intafaced/ledger-client';

/**
 * OPERATOR TRACE: a business key to the transaction it booked (OPS-ledger-desk-01, ops-console-ledger-desk-005).
 *
 * The service doors `txByKey` / `txById` answer services. An operator investigating "did this withdrawal book?" had no
 * read at all. This is that read, for a founder session holding `admin:treasury` (which requires a second factor).
 *
 * A read, never a post. Business keys are shown, never minted here. Amounts leave as decimal strings. A key with no
 * transaction is an honest `found: false`, never an invented row. Entries name opaque account ids only: no customer
 * profile data is returned.
 */

export const operatorTraceInputSchema = z.object({ businessKey: z.string().trim().min(1).max(512) }).strict();
export type OperatorTraceInput = z.infer<typeof operatorTraceInputSchema>;

const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export const operatorTracePostingSchema = z.object({
  entryId: z.string(),
  accountId: z.string(),
  assetId: z.string(),
  direction: z.enum(['debit', 'credit']),
  amount: decimal,
  balanceAfter: decimal,
});

export const operatorTraceOutputSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false), businessKey: z.string() }),
  z.object({
    found: z.literal(true),
    businessKey: z.string(),
    txId: z.string(),
    module: z.string(),
    reason: z.string(),
    postedAt: z.string().datetime(),
    hash: z.string(),
    previousHash: z.string().nullable(),
    postings: z.array(operatorTracePostingSchema),
  }),
]);
export type OperatorTraceOutput = z.infer<typeof operatorTraceOutputSchema>;

export interface TraceReader {
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
}

/** Thrown when the book answers with a transaction booked under a different key: refuse rather than show it. */
export class TraceInconsistentError extends Error {
  readonly code = 'ledger.trace_inconsistent' as const;
  constructor(businessKey: string, txId: string) {
    super(`ledger answered tx ${txId} for key ${businessKey}, but it was booked under another key`);
    this.name = 'TraceInconsistentError';
  }
}

export async function traceBusinessKey(reader: TraceReader, input: OperatorTraceInput): Promise<OperatorTraceOutput> {
  const { businessKey } = operatorTraceInputSchema.parse(input);
  const tx = await reader.getTxByKey(businessKey);
  if (!tx) return { found: false, businessKey };
  if (tx.idempotencyKey !== businessKey) throw new TraceInconsistentError(businessKey, tx.id);
  return {
    found: true,
    businessKey,
    txId: tx.id,
    module: tx.module,
    reason: tx.reason,
    postedAt: tx.postedAt.toISOString(),
    hash: tx.hash,
    previousHash: tx.previousHash,
    postings: tx.entries.map((e) => ({
      entryId: e.id,
      accountId: e.accountId,
      assetId: e.assetId,
      direction: e.direction,
      amount: formatAmount(e.amount),
      balanceAfter: formatAmount(e.balanceAfter),
    })),
  };
}
