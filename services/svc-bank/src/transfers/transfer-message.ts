import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { bankTransferKey, type BankTransferKeySpace } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/**
 * The note and payment reference on one transfer, stored before the ledger
 * post so a retry cannot swap the words after the money has moved.
 * Both parties may read them. They are not a balance.
 */

export interface TransferMessageInput {
  readonly transferId: string;
  /** The key space the transfer posts under, so the "already booked" read looks at the right key. Defaults to `own`. */
  readonly keySpace?: BankTransferKeySpace;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly note: string | null;
  readonly reference: string | null;
}

interface LedgerKey {
  getTxByKey(idempotencyKey: string): Promise<{ id: string } | null>;
}

function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function sameWords(row: { note: string | null; reference: string | null }, input: TransferMessageInput): boolean {
  return (row.note ?? null) === input.note && (row.reference ?? null) === input.reference;
}

export async function bindTransferMessage(sql: Sql, ledger: LedgerKey, input: TransferMessageInput): Promise<void> {
  if (input.note === null && input.reference === null) return;
  const write = async () =>
    transaction(sql, async (tx) => {
      const rows = await tx<Array<{ note: string | null; reference: string | null }>>`
        SELECT note, reference FROM bank.transfer_messages WHERE transfer_id = ${input.transferId} FOR UPDATE
      `;
      if (rows[0]) {
        if (!sameWords(rows[0], input)) {
          throw new BankError('A retry of this transfer used a different note or reference', 'bank.transfer_message_conflict');
        }
        return;
      }
      const posted = await ledger.getTxByKey(bankTransferKey(input.keySpace ?? 'own', input.transferId, 0));
      if (posted) {
        throw new BankError('This transfer already completed without this note or reference', 'bank.transfer_message_conflict');
      }
      await tx`
        INSERT INTO bank.transfer_messages (transfer_id, from_user_id, to_user_id, note, reference)
        VALUES (${input.transferId}, ${input.fromUserId}, ${input.toUserId}, ${input.note}, ${input.reference})
      `;
    });
  try {
    await write();
  } catch (err) {
    if (err instanceof BankError) throw err;
    if (!isUnique(err)) throw err;
    const rows = await sql<Array<{ note: string | null; reference: string | null }>>`
      SELECT note, reference FROM bank.transfer_messages WHERE transfer_id = ${input.transferId}
    `;
    if (rows[0] && sameWords(rows[0], input)) return;
    throw new BankError('A retry of this transfer used a different note or reference', 'bank.transfer_message_conflict');
  }
}

export async function attachTransferMessageTx(sql: Sql, transferId: string, ledgerTxId: string): Promise<void> {
  await sql`
    UPDATE bank.transfer_messages
       SET ledger_tx_id = ${ledgerTxId}
     WHERE transfer_id = ${transferId} AND ledger_tx_id IS NULL
  `;
}
