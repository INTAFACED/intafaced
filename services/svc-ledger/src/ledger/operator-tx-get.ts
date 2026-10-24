import { z } from 'zod';
import { LedgerError, formatAmount, type LedgerTx } from '@intafaced/ledger-client';
import { recordLookup, type LookupActor, type LookupRecorder } from './operator-lookup.js';

/**
 * Operator transaction detail (OPS-ledger-desk-01, ops-console-ledger-desk-001): one booked transaction by id, for a
 * founder's `admin:read` with a second factor, or `admin:treasury` (`requireLookupAuthority`). A read, never a post.
 *
 * Returns each posting (account id, asset, direction, amount, balance after) as decimal strings, the business key,
 * module, reason, ledger time and hash links. The lookup writes an access row first and is refused if it cannot
 * (`operator-lookup.ts`). An unknown id is `ledger.tx_not_found`, never an empty row. Transaction
 * metadata is NOT returned here: it can hold personal data and needs scope-based masking first.
 */

export const LEDGER_TX_NOT_FOUND = 'ledger.tx_not_found' as const;

export const operatorTxGetInputSchema = z.object({ txId: z.string().guid() }).strict();
export type OperatorTxGetInput = z.infer<typeof operatorTxGetInputSchema>;

const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export const operatorTxGetOutputSchema = z.object({
  txId: z.string(),
  businessKey: z.string(),
  module: z.string(),
  reason: z.string(),
  postedAt: z.string().datetime(),
  hash: z.string(),
  previousHash: z.string().nullable(),
  postings: z.array(
    z.object({
      entryId: z.string(),
      accountId: z.string(),
      assetId: z.string(),
      direction: z.enum(['debit', 'credit']),
      amount: decimal,
      balanceAfter: decimal,
    }),
  ),
});
export type OperatorTxGetOutput = z.infer<typeof operatorTxGetOutputSchema>;

export interface TxReader extends LookupRecorder {
  getTx(txId: string): Promise<LedgerTx | null>;
}

export async function operatorTxGet(reader: TxReader, actor: LookupActor, input: OperatorTxGetInput): Promise<OperatorTxGetOutput> {
  const { txId } = operatorTxGetInputSchema.parse(input);
  await recordLookup(reader, actor, { ownerType: 'transaction', ownerId: txId, action: 'transaction.read' });
  const tx = await reader.getTx(txId);
  if (!tx) throw new LedgerError(`no transaction ${txId}`, LEDGER_TX_NOT_FOUND);
  return {
    txId: tx.id,
    businessKey: tx.idempotencyKey,
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
