import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { BankError } from '../errors.js';

/**
 * Words on a transaction that the ledger does not store.
 *
 * A transfer message is shown to both parties. A private note and a dispute
 * belong to the customer who wrote them. A dispute stays `open`: nothing here
 * refunds, reverses, or decides an outcome.
 */

export interface ActivityAnnotation {
  readonly note: string | null;
  readonly reference: string | null;
  readonly privateNote: string | null;
  readonly dispute: { readonly id: string; readonly status: 'open'; readonly reason: string } | null;
}

export interface ActivityRecordRef {
  readonly id: string;
  readonly txId: string;
}

function isUnique(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export class ActivityRecordService {
  constructor(private readonly sql: Sql) {}

  async forItems(userId: string, items: readonly ActivityRecordRef[]): Promise<ReadonlyMap<string, ActivityAnnotation>> {
    const out = new Map<string, ActivityAnnotation>();
    if (items.length === 0) return out;
    const txIds = [...new Set(items.map((item) => item.txId))];
    const ids = items.map((item) => item.id);
    const messages = await this.sql<Array<{ ledger_tx_id: string | null; note: string | null; reference: string | null }>>`
      SELECT ledger_tx_id, note, reference
        FROM bank.transfer_messages
       WHERE ledger_tx_id = ANY(${this.sql.array(txIds)}::text[])
         AND (from_user_id = ${userId} OR to_user_id = ${userId})
    `;
    const byTx = new Map(messages.filter((row) => row.ledger_tx_id !== null).map((row) => [row.ledger_tx_id as string, row]));
    const notes = await this.sql<Array<{ activity_id: string; text: string }>>`
      SELECT activity_id, text FROM bank.activity_notes
       WHERE user_id = ${userId} AND activity_id = ANY(${this.sql.array(ids)}::text[])
    `;
    const byNote = new Map(notes.map((row) => [row.activity_id, row.text]));
    const disputes = await this.sql<Array<{ id: string; activity_id: string; reason: string }>>`
      SELECT id, activity_id, reason FROM bank.activity_disputes
       WHERE user_id = ${userId} AND activity_id = ANY(${this.sql.array(ids)}::text[])
    `;
    const byDispute = new Map(disputes.map((row) => [row.activity_id, row]));
    for (const item of items) {
      const message = byTx.get(item.txId);
      const privateNote = byNote.get(item.id) ?? null;
      const dispute = byDispute.get(item.id);
      if (!message && privateNote === null && !dispute) continue;
      out.set(item.id, {
        note: message?.note ?? null,
        reference: message?.reference ?? null,
        privateNote,
        dispute: dispute ? { id: dispute.id, status: 'open', reason: dispute.reason } : null,
      });
    }
    return out;
  }

  /**
   * The crypto address a withdrawal went to, by ledger tx id, for this customer's own off-ramps only. The hold, the
   * settlement and the release are three ledger transactions of one withdrawal, and each shows the same address.
   * A fiat destination (an IBAN) is not an address and is never returned. Deposits record no address against their
   * ledger transaction, so they are absent here; nothing is guessed from the deposit address table.
   */
  async addressesFor(userId: string, txIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (txIds.length === 0) return out;
    const wanted = this.sql.array([...new Set(txIds)]);
    const rows = await this.sql<
      Array<{
        destination_ref: string;
        hold_ledger_tx_id: string | null;
        settle_ledger_tx_id: string | null;
        release_ledger_tx_id: string | null;
      }>
    >`
      SELECT destination_ref, hold_ledger_tx_id, settle_ledger_tx_id, release_ledger_tx_id
        FROM bank.ramp_offramps
       WHERE user_id = ${userId}
         AND kind = 'crypto'
         AND (hold_ledger_tx_id = ANY(${wanted}::text[])
           OR settle_ledger_tx_id = ANY(${wanted}::text[])
           OR release_ledger_tx_id = ANY(${wanted}::text[]))
    `;
    for (const row of rows) {
      for (const txId of [row.hold_ledger_tx_id, row.settle_ledger_tx_id, row.release_ledger_tx_id]) {
        if (txId !== null) out.set(txId, row.destination_ref);
      }
    }
    return out;
  }

  async setNote(
    userId: string,
    input: { activityId: string; text: string; commandId: string },
  ): Promise<{ activityId: string; text: string; updatedAt: string }> {
    const prior = await this.sql<Array<{ user_id: string; activity_id: string; text: string; updated_at: Date }>>`
      SELECT user_id, activity_id, text, updated_at FROM bank.activity_note_commands WHERE command_id = ${input.commandId}
    `;
    if (prior[0]) {
      if (prior[0].user_id !== userId || prior[0].activity_id !== input.activityId || prior[0].text !== input.text) {
        throw new BankError('That command id was already used for a different note', 'bank.activity_note_conflict');
      }
      return { activityId: input.activityId, text: input.text, updatedAt: prior[0].updated_at.toISOString() };
    }
    try {
      const updatedAt = await transaction(this.sql, async (tx) => {
        const rows = await tx<Array<{ updated_at: Date }>>`
          INSERT INTO bank.activity_notes (user_id, activity_id, text)
          VALUES (${userId}, ${input.activityId}, ${input.text})
          ON CONFLICT (user_id, activity_id)
          DO UPDATE SET text = EXCLUDED.text, updated_at = now()
          RETURNING updated_at
        `;
        const at = rows[0]!.updated_at;
        await tx`
          INSERT INTO bank.activity_note_commands (command_id, user_id, activity_id, text, updated_at)
          VALUES (${input.commandId}, ${userId}, ${input.activityId}, ${input.text}, ${at})
        `;
        return at;
      });
      return { activityId: input.activityId, text: input.text, updatedAt: updatedAt.toISOString() };
    } catch (err) {
      if (err instanceof BankError) throw err;
      if (!isUnique(err)) throw err;
      const again = await this.sql<Array<{ user_id: string; activity_id: string; text: string; updated_at: Date }>>`
        SELECT user_id, activity_id, text, updated_at FROM bank.activity_note_commands WHERE command_id = ${input.commandId}
      `;
      if (again[0] && again[0].user_id === userId && again[0].activity_id === input.activityId && again[0].text === input.text) {
        return { activityId: input.activityId, text: input.text, updatedAt: again[0].updated_at.toISOString() };
      }
      throw new BankError('That command id was already used for a different note', 'bank.activity_note_conflict');
    }
  }

  async openDispute(
    userId: string,
    input: { activityId: string; reason: string; disputeId: string },
  ): Promise<{ disputeId: string; activityId: string; status: 'open'; reason: string; createdAt: string }> {
    const prior = await this.sql<Array<{ id: string; user_id: string; activity_id: string; reason: string; created_at: Date }>>`
      SELECT id, user_id, activity_id, reason, created_at FROM bank.activity_disputes WHERE id = ${input.disputeId}
    `;
    if (prior[0]) {
      if (prior[0].user_id !== userId || prior[0].activity_id !== input.activityId || prior[0].reason !== input.reason) {
        throw new BankError('That dispute id was already used for a different case', 'bank.activity_dispute_conflict');
      }
      return {
        disputeId: prior[0].id,
        activityId: prior[0].activity_id,
        status: 'open',
        reason: prior[0].reason,
        createdAt: prior[0].created_at.toISOString(),
      };
    }
    const open = await this.sql<Array<{ id: string }>>`
      SELECT id FROM bank.activity_disputes WHERE user_id = ${userId} AND activity_id = ${input.activityId}
    `;
    if (open[0]) {
      throw new BankError('This transaction already has an open dispute', 'bank.activity_dispute_exists');
    }
    try {
      const rows = await this.sql<Array<{ id: string; created_at: Date }>>`
        INSERT INTO bank.activity_disputes (id, user_id, activity_id, reason)
        VALUES (${input.disputeId}, ${userId}, ${input.activityId}, ${input.reason})
        RETURNING id, created_at
      `;
      return {
        disputeId: rows[0]!.id,
        activityId: input.activityId,
        status: 'open',
        reason: input.reason,
        createdAt: rows[0]!.created_at.toISOString(),
      };
    } catch (err) {
      if (!isUnique(err)) throw err;
      const again = await this.sql<Array<{ id: string; user_id: string; activity_id: string; reason: string; created_at: Date }>>`
        SELECT id, user_id, activity_id, reason, created_at FROM bank.activity_disputes WHERE id = ${input.disputeId}
      `;
      if (again[0] && again[0].user_id === userId && again[0].activity_id === input.activityId && again[0].reason === input.reason) {
        return {
          disputeId: again[0].id,
          activityId: again[0].activity_id,
          status: 'open',
          reason: again[0].reason,
          createdAt: again[0].created_at.toISOString(),
        };
      }
      throw new BankError('This transaction already has an open dispute', 'bank.activity_dispute_exists');
    }
  }
}
