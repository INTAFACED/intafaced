import { z } from 'zod';
import type { LedgerTx } from '@intafaced/ledger-client';
import { recordLookup, type LookupActor, type LookupRecorder } from './operator-lookup.js';
import { bookingRecordSchema, type BookingRecord } from './operator-desk.js';
import { BookingRecordMissingError, deskPosting, operatorPostingSchema } from './operator-tx-get.js';

/**
 * OPERATOR TRACE: a business key to the transaction it booked (OPS-ledger-desk-01, ops-console-ledger-desk-005).
 *
 * The service doors `txByKey` / `txById` answer services. An operator investigating "did this withdrawal book?" had no
 * read at all. This is that read, for `admin:read` with a second factor (`requireLookupAuthority`).
 *
 * A read, never a post. Business keys are shown, never minted here. Amounts leave as decimal strings. A key with no
 * transaction is an honest `found: false`, never an invented row. The lookup writes an access row first and is refused
 * if it cannot (`operator-lookup.ts`). Entries name opaque account ids only: no customer
 * profile data is returned. A found key also answers its place in the log and its audit entry: the booking record's
 * sequence and the `tx.posted` event record written in the same commit. The ledger keeps no record of a write it
 * refused, so a key that never booked has nothing more to show than `found: false`.
 */

export const operatorTraceInputSchema = z.object({ businessKey: z.string().trim().min(1).max(512) }).strict();
export type OperatorTraceInput = z.infer<typeof operatorTraceInputSchema>;

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
    booking: bookingRecordSchema,
    postings: z.array(operatorPostingSchema),
  }),
]);
export type OperatorTraceOutput = z.infer<typeof operatorTraceOutputSchema>;

export interface TraceReader extends LookupRecorder {
  getTxByKey(idempotencyKey: string): Promise<LedgerTx | null>;
  readBookingRecord(txId: string): Promise<BookingRecord | null>;
}

/** Thrown when the book answers with a transaction booked under a different key: refuse rather than show it. */
export class TraceInconsistentError extends Error {
  readonly code = 'ledger.trace_inconsistent' as const;
  constructor(businessKey: string, txId: string) {
    super(`ledger answered tx ${txId} for key ${businessKey}, but it was booked under another key`);
    this.name = 'TraceInconsistentError';
  }
}

export async function traceBusinessKey(reader: TraceReader, actor: LookupActor, input: OperatorTraceInput): Promise<OperatorTraceOutput> {
  const { businessKey } = operatorTraceInputSchema.parse(input);
  await recordLookup(reader, actor, { ownerType: 'business_key', ownerId: businessKey, action: 'trace.read' });
  const tx = await reader.getTxByKey(businessKey);
  if (!tx) return { found: false, businessKey };
  if (tx.idempotencyKey !== businessKey) throw new TraceInconsistentError(businessKey, tx.id);
  const booking = await reader.readBookingRecord(tx.id);
  if (!booking) throw new BookingRecordMissingError(tx.id);
  return {
    found: true,
    businessKey,
    txId: tx.id,
    module: tx.module,
    reason: tx.reason,
    postedAt: tx.postedAt.toISOString(),
    hash: tx.hash,
    previousHash: tx.previousHash,
    booking,
    postings: tx.entries.map(deskPosting),
  };
}
