import type { Sql } from 'postgres';
import {
  buildDisputeTransition,
  buildOpenDisputeCase,
  DisputeCaseError,
  type DisputeCase,
  type DisputeCaseStatus,
  type DisputeCaseStore,
  type DisputeQuery,
  type OpenDisputeCaseInput,
  type RailResolutionInput,
  type RailResolutionOutcome,
} from './dispute-case.js';
import type { ChargebackLedgerRefuse } from './chargeback-ledger-socket.js';

/**
 * Postgres `DisputeCaseStore`. Same operations as the memory store, so a
 * restart still lists, reads, and moves the case. Rail won/lost/closed
 * deliveries are applied once per rail event id.
 *
 * Callers that already hold a transaction (merchant respond) pass it in.
 * The case change then commits or rolls back with their journal row.
 */

const RAIL_STATUS: Record<RailResolutionOutcome, DisputeCaseStatus> = {
  won: 'won',
  lost: 'lost',
  closed: 'accepted',
};

interface CaseRow {
  dispute_id: string;
  payment_id: string;
  merchant_id: string;
  amount: string;
  asset_id: string;
  reason_code: string | null;
  status: DisputeCaseStatus;
  opened_at: Date;
  updated_at: Date;
  contested_at: Date | null;
  closed_at: Date | null;
  payment_marked_disputed: boolean;
  ledger_wire: 'posted' | 'refused';
  ledger_tx_id: string | null;
  ledger_refuse: ChargebackLedgerRefuse | null;
}

function toCase(row: CaseRow): DisputeCase {
  return {
    disputeId: row.dispute_id,
    paymentId: row.payment_id,
    merchantId: row.merchant_id,
    amount: row.amount,
    assetId: row.asset_id,
    reasonCode: row.reason_code,
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    contestedAt: row.contested_at ? row.contested_at.toISOString() : null,
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    paymentMarkedDisputed: row.payment_marked_disputed,
    ledgerWire: row.ledger_wire,
    ledgerRefuse: row.ledger_wire === 'posted' ? null : row.ledger_refuse,
    ledgerTxId: row.ledger_tx_id,
  };
}

export class PostgresDisputeCaseStore implements DisputeCaseStore {
  constructor(private readonly sql: Sql) {}

  async open(input: OpenDisputeCaseInput): Promise<DisputeCase> {
    const row = buildOpenDisputeCase(input);
    const inserted = await this.sql<CaseRow[]>`
      INSERT INTO pay.dispute_cases (
        dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
        opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
        ledger_wire, ledger_tx_id, ledger_refuse
      )
      VALUES (
        ${row.disputeId}, ${row.paymentId}, ${row.merchantId}, ${row.amount}, ${row.assetId}, ${row.reasonCode}, ${row.status},
        ${new Date(row.openedAt)}, ${new Date(row.updatedAt)}, ${null}, ${null}, ${row.paymentMarkedDisputed},
        ${row.ledgerWire}, ${row.ledgerTxId}, ${row.ledgerRefuse === null ? null : this.sql.json(row.ledgerRefuse as never)}
      )
      ON CONFLICT (dispute_id) DO NOTHING
      RETURNING dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
                opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
                ledger_wire, ledger_tx_id, ledger_refuse`;
    if (inserted[0]) return toCase(inserted[0]);
    const existing = await this.get(row.disputeId);
    if (!existing) throw new DisputeCaseError(`No dispute case ${row.disputeId}`, 'pay.dispute_not_found');
    return existing;
  }

  async get(disputeId: string): Promise<DisputeCase | null> {
    const rows = await this.sql<CaseRow[]>`
      SELECT dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
             opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
             ledger_wire, ledger_tx_id, ledger_refuse
        FROM pay.dispute_cases
       WHERE dispute_id = ${disputeId}`;
    return rows[0] ? toCase(rows[0]) : null;
  }

  async listForPayment(paymentId: string): Promise<readonly DisputeCase[]> {
    const rows = await this.sql<CaseRow[]>`
      SELECT dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
             opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
             ledger_wire, ledger_tx_id, ledger_refuse
        FROM pay.dispute_cases
       WHERE payment_id = ${paymentId}
       ORDER BY opened_at, dispute_id`;
    return rows.map(toCase);
  }

  async listForMerchant(merchantId: string): Promise<readonly DisputeCase[]> {
    const rows = await this.sql<CaseRow[]>`
      SELECT dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
             opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
             ledger_wire, ledger_tx_id, ledger_refuse
        FROM pay.dispute_cases
       WHERE merchant_id = ${merchantId}
       ORDER BY opened_at, dispute_id`;
    return rows.map(toCase);
  }

  contest(disputeId: string, now?: Date, query?: DisputeQuery): Promise<DisputeCase> {
    return this.transition(disputeId, 'contested', ['open'], now, { contested: true }, query);
  }

  accept(disputeId: string, now?: Date, query?: DisputeQuery): Promise<DisputeCase> {
    return this.transition(disputeId, 'accepted', ['open', 'contested'], now, { close: true }, query);
  }

  markWon(disputeId: string, now?: Date): Promise<DisputeCase> {
    return this.transition(disputeId, 'won', ['open', 'contested'], now, { close: true });
  }

  markLost(disputeId: string, now?: Date): Promise<DisputeCase> {
    return this.transition(disputeId, 'lost', ['open', 'contested'], now, { close: true });
  }

  async applyRailResolution(input: RailResolutionInput): Promise<DisputeCase | null> {
    const disputeId = input.disputeId?.trim() ?? '';
    const railEventId = input.railEventId?.trim() ?? '';
    if (!disputeId || !railEventId) return null;
    const next = RAIL_STATUS[input.outcome];
    return this.sql.begin(async (tx) => {
      const locked = await this.lock(tx, disputeId);
      if (!locked) return null;
      const seen = await tx<Array<{ dispute_id: string }>>`
        SELECT dispute_id FROM pay.dispute_case_rail_events WHERE rail_event_id = ${railEventId}`;
      if (seen[0]) {
        if (seen[0].dispute_id !== disputeId) {
          throw new DisputeCaseError('a rail event id cannot move a different dispute', 'pay.dispute_invalid_transition');
        }
        return locked;
      }
      const row =
        locked.status === next ? locked : await this.writeMove(tx, locked, next, ['open', 'contested'], input.now, { close: true });
      await tx`
        INSERT INTO pay.dispute_case_rail_events (rail_event_id, dispute_id, outcome)
        VALUES (${railEventId}, ${disputeId}, ${input.outcome})`;
      return row;
    });
  }

  private async transition(
    disputeId: string,
    next: DisputeCaseStatus,
    from: readonly DisputeCaseStatus[],
    now: Date | undefined,
    flags: { contested?: boolean; close?: boolean },
    query?: DisputeQuery,
  ): Promise<DisputeCase> {
    const run = (db: DisputeQuery) => this.writeMove(db, undefined, next, from, now, flags, disputeId);
    if (query) return run(query);
    return this.sql.begin((tx) => run(tx));
  }

  private async lock(query: DisputeQuery, disputeId: string): Promise<DisputeCase | null> {
    const rows = await query<CaseRow[]>`
      SELECT dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
             opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
             ledger_wire, ledger_tx_id, ledger_refuse
        FROM pay.dispute_cases
       WHERE dispute_id = ${disputeId}
       FOR UPDATE`;
    return rows[0] ? toCase(rows[0]) : null;
  }

  private async writeMove(
    query: DisputeQuery,
    current: DisputeCase | undefined,
    next: DisputeCaseStatus,
    from: readonly DisputeCaseStatus[],
    now: Date | undefined,
    flags: { contested?: boolean; close?: boolean },
    disputeId = current?.disputeId ?? '',
  ): Promise<DisputeCase> {
    const locked = current ?? (await this.lock(query, disputeId));
    if (!locked) throw new DisputeCaseError(`No dispute case ${disputeId}`, 'pay.dispute_not_found');
    const moved = buildDisputeTransition(locked, next, from, now, flags);
    const rows = await query<CaseRow[]>`
      UPDATE pay.dispute_cases
         SET status = ${moved.status},
             updated_at = ${new Date(moved.updatedAt)},
             contested_at = COALESCE(contested_at, ${moved.contestedAt ? new Date(moved.contestedAt) : null}),
             closed_at = COALESCE(closed_at, ${moved.closedAt ? new Date(moved.closedAt) : null})
       WHERE dispute_id = ${moved.disputeId}
         AND status = ${locked.status}
       RETURNING dispute_id, payment_id, merchant_id, amount, asset_id, reason_code, status,
                 opened_at, updated_at, contested_at, closed_at, payment_marked_disputed,
                 ledger_wire, ledger_tx_id, ledger_refuse`;
    const saved = rows[0];
    if (!saved) {
      const again = await this.lock(query, moved.disputeId);
      if (!again) throw new DisputeCaseError(`No dispute case ${moved.disputeId}`, 'pay.dispute_not_found');
      buildDisputeTransition(again, next, from, now, flags);
      throw new DisputeCaseError(`Dispute ${moved.disputeId} is already ${again.status}`, 'pay.dispute_closed');
    }
    return toCase(saved);
  }
}
