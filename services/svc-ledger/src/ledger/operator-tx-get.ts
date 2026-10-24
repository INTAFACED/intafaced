import { z } from 'zod';
import { LedgerError, formatAmount, type LedgerTx } from '@intafaced/ledger-client';
import { recordLookup, type LookupActor, type LookupRecorder } from './operator-lookup.js';
import { bookingRecordSchema, type BookingRecord } from './operator-desk.js';

/**
 * Operator transaction detail (OPS-ledger-desk-01, ops-console-ledger-desk-001): one booked transaction by id, for a
 * founder's `admin:read` with a second factor, or `admin:treasury` (`requireLookupAuthority`). A read, never a post.
 *
 * Returns each posting (account id, asset, direction, amount, balance before and after, and whether value left the
 * account or arrived in it) as decimal strings, the business key, module, reason, hash links, and the booking record:
 * the log sequence, the reference, the request time (`postedAt`, the ledger process's clock the hash covers), the
 * database time of the booking (when its database transaction began), and the `tx.posted` event record (`operator-desk.ts`). The lookup writes an access row first and is refused if it cannot
 * (`operator-lookup.ts`). An unknown id is `ledger.tx_not_found`, never an empty row. Transaction
 * metadata is NOT returned here: it can hold personal data and needs scope-based masking first.
 */

export const LEDGER_TX_NOT_FOUND = 'ledger.tx_not_found' as const;

export const operatorTxGetInputSchema = z.object({ txId: z.string().guid() }).strict();
export type OperatorTxGetInput = z.infer<typeof operatorTxGetInputSchema>;

const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

/**
 * One posting as the desk shows it. A debit raises an account's balance in this book and a credit lowers it, so a
 * credited account is where the value came from (`source`) and a debited one is where it went (`destination`).
 */
export const operatorPostingSchema = z.object({
  entryId: z.string(),
  accountId: z.string(),
  assetId: z.string(),
  direction: z.enum(['debit', 'credit']),
  side: z.enum(['source', 'destination']),
  amount: decimal,
  balanceBefore: decimal,
  balanceAfter: decimal,
});
export type OperatorPosting = z.infer<typeof operatorPostingSchema>;

/** A booked entry as the desk shows it, with the balance before it derived from the one after. */
export function deskPosting(e: LedgerTx['entries'][number]): OperatorPosting {
  const delta = e.direction === 'debit' ? e.amount : -e.amount;
  return {
    entryId: e.id,
    accountId: e.accountId,
    assetId: e.assetId,
    direction: e.direction,
    side: e.direction === 'credit' ? 'source' : 'destination',
    amount: formatAmount(e.amount),
    balanceBefore: formatAmount(e.balanceAfter - delta),
    balanceAfter: formatAmount(e.balanceAfter),
  };
}

/** Thrown when a transaction the book returned has no row in the log: refuse rather than show it without one. */
export class BookingRecordMissingError extends Error {
  readonly code = 'ledger.booking_record_missing' as const;
  constructor(txId: string) {
    super(`transaction ${txId} has no row in the ledger log`);
    this.name = 'BookingRecordMissingError';
  }
}

export const operatorTxGetOutputSchema = z.object({
  txId: z.string(),
  businessKey: z.string(),
  module: z.string(),
  reason: z.string(),
  postedAt: z.string().datetime(),
  hash: z.string(),
  previousHash: z.string().nullable(),
  booking: bookingRecordSchema,
  postings: z.array(operatorPostingSchema),
});
export type OperatorTxGetOutput = z.infer<typeof operatorTxGetOutputSchema>;

export interface TxReader extends LookupRecorder {
  getTx(txId: string): Promise<LedgerTx | null>;
  readBookingRecord(txId: string): Promise<BookingRecord | null>;
}

export async function operatorTxGet(reader: TxReader, actor: LookupActor, input: OperatorTxGetInput): Promise<OperatorTxGetOutput> {
  const { txId } = operatorTxGetInputSchema.parse(input);
  await recordLookup(reader, actor, { ownerType: 'transaction', ownerId: txId, action: 'transaction.read' });
  const tx = await reader.getTx(txId);
  if (!tx) throw new LedgerError(`no transaction ${txId}`, LEDGER_TX_NOT_FOUND);
  const booking = await reader.readBookingRecord(tx.id);
  if (!booking) throw new BookingRecordMissingError(tx.id);
  return {
    txId: tx.id,
    businessKey: tx.idempotencyKey,
    module: tx.module,
    reason: tx.reason,
    postedAt: tx.postedAt.toISOString(),
    hash: tx.hash,
    previousHash: tx.previousHash,
    booking,
    postings: tx.entries.map(deskPosting),
  };
}
