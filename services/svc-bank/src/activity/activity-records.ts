import { SavedFilterService } from './saved-filters.js';
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
  /** A second free-text field, used in reports and exports. The caller's own. */
  readonly reportDescription: string | null;
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
  /** Saved `activity.list` filters (BK-acct-07). Same connection; no money. */
  readonly savedFilters: SavedFilterService;

  constructor(private readonly sql: Sql) {
    this.savedFilters = new SavedFilterService(sql);
  }

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
    const notes = await this.sql<Array<{ activity_id: string; text: string | null; report_description: string | null }>>`
      SELECT activity_id, text, report_description FROM bank.activity_notes
       WHERE user_id = ${userId} AND activity_id = ANY(${this.sql.array(ids)}::text[])
    `;
    const byNote = new Map(notes.map((row) => [row.activity_id, row]));
    const disputes = await this.sql<Array<{ id: string; activity_id: string; reason: string }>>`
      SELECT id, activity_id, reason FROM bank.activity_disputes
       WHERE user_id = ${userId} AND activity_id = ANY(${this.sql.array(ids)}::text[])
    `;
    const byDispute = new Map(disputes.map((row) => [row.activity_id, row]));
    for (const item of items) {
      const message = byTx.get(item.txId);
      const written = byNote.get(item.id);
      const privateNote = written?.text ?? null;
      const reportDescription = written?.report_description ?? null;
      const dispute = byDispute.get(item.id);
      if (!message && privateNote === null && reportDescription === null && !dispute) continue;
      out.set(item.id, {
        note: message?.note ?? null,
        reference: message?.reference ?? null,
        privateNote,
        reportDescription,
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

  /**
   * Write the caller's private note and/or report description on one line. A field that is left out keeps what it
   * had. The command id makes a repeat of the same press one write: the same command returns the same answer, and the
   * same id with different words is refused.
   */
  async setNote(
    userId: string,
    input: { activityId: string; text?: string; reportDescription?: string; commandId: string },
  ): Promise<{ activityId: string; text: string | null; reportDescription: string | null; updatedAt: string }> {
    if (input.text === undefined && input.reportDescription === undefined) {
      throw new BankError('Write a note, a report description, or both', 'bank.activity_note_empty');
    }
    const text = input.text ?? null;
    const description = input.reportDescription ?? null;
    type Stored = {
      user_id: string;
      activity_id: string;
      text: string | null;
      report_description: string | null;
      updated_at: Date;
    };
    const sameCommand = (row: Stored) =>
      row.user_id === userId && row.activity_id === input.activityId && row.text === text && row.report_description === description;
    const current = async (): Promise<{ text: string | null; reportDescription: string | null }> => {
      const rows = await this.sql<Array<{ text: string | null; report_description: string | null }>>`
        SELECT text, report_description FROM bank.activity_notes WHERE user_id = ${userId} AND activity_id = ${input.activityId}
      `;
      return { text: rows[0]?.text ?? null, reportDescription: rows[0]?.report_description ?? null };
    };
    const priorRows = () => this.sql<Stored[]>`
      SELECT user_id, activity_id, text, report_description, updated_at
        FROM bank.activity_note_commands WHERE command_id = ${input.commandId}
    `;
    const conflict = () => new BankError('That command id was already used for a different note', 'bank.activity_note_conflict');

    const prior = await priorRows();
    if (prior[0]) {
      if (!sameCommand(prior[0])) throw conflict();
      return { activityId: input.activityId, ...(await current()), updatedAt: prior[0].updated_at.toISOString() };
    }
    try {
      const result = await transaction(this.sql, async (tx) => {
        const rows = await tx<Array<{ updated_at: Date; text: string | null; report_description: string | null }>>`
          INSERT INTO bank.activity_notes (user_id, activity_id, text, report_description)
          VALUES (${userId}, ${input.activityId}, ${text}, ${description})
          ON CONFLICT (user_id, activity_id)
          DO UPDATE SET text = COALESCE(EXCLUDED.text, bank.activity_notes.text),
                        report_description = COALESCE(EXCLUDED.report_description, bank.activity_notes.report_description),
                        updated_at = now()
          RETURNING updated_at, text, report_description
        `;
        const row = rows[0]!;
        await tx`
          INSERT INTO bank.activity_note_commands (command_id, user_id, activity_id, text, report_description, updated_at)
          VALUES (${input.commandId}, ${userId}, ${input.activityId}, ${text}, ${description}, ${row.updated_at})
        `;
        return row;
      });
      return {
        activityId: input.activityId,
        text: result.text,
        reportDescription: result.report_description,
        updatedAt: result.updated_at.toISOString(),
      };
    } catch (err) {
      if (err instanceof BankError) throw err;
      if (!isUnique(err)) throw err;
      const again = await priorRows();
      if (again[0] && sameCommand(again[0])) {
        return { activityId: input.activityId, ...(await current()), updatedAt: again[0].updated_at.toISOString() };
      }
      throw conflict();
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
