import type { Sql, TransactionSql } from 'postgres';
import {
  CHARGEBACK_LEDGER_REFUSE_CODE,
  CHARGEBACK_LEDGER_SOCKET_ID,
  CHARGEBACK_LEDGER_UNCOVERED_CODE,
  refuseChargebackLedgerPost,
  refuseChargebackPlanConflict,
  refuseChargebackUncovered,
  type ChargebackLedgerRefuse,
} from './chargeback-ledger-socket.js';

/**
 * pay.fraud — chargeback **case** mechanism (D26-P1-P5).
 *
 * Records dispute lifecycle (open → contested | accepted | won | lost) so the
 * `disputed` payment status is no longer a dead end with no writer.
 *
 * `ledgerWire: 'posted'` only when the caller supplies a ledger tx id from
 * `postDisputeOpening`. Anything else is a named refuse — never a silent book
 * entry. Shortfall / won recipes stay unwired. Blocklist content is Class X.
 */

export type DisputeCaseStatus = 'open' | 'contested' | 'accepted' | 'won' | 'lost';

export interface DisputeCase {
  readonly disputeId: string;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly amount: string;
  readonly assetId: string;
  /** Scheme reason code — never translated; may be empty when rail omitted it. */
  readonly reasonCode: string | null;
  readonly status: DisputeCaseStatus;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly contestedAt: string | null;
  readonly closedAt: string | null;
  /** True when payment status was moved to disputed by this open. */
  readonly paymentMarkedDisputed: boolean;
  /**
   * Posted only with a real ledger tx id. Fixture / cover-fail stay refuse-closed
   * so HTTP cannot claim value moved.
   */
  readonly ledgerWire: 'posted' | 'refused';
  readonly ledgerRefuse: ChargebackLedgerRefuse | null;
  readonly ledgerTxId: string | null;
}

export class DisputeCaseError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'pay.dispute_id_required'
      | 'pay.dispute_not_found'
      | 'pay.dispute_closed'
      | 'pay.dispute_invalid_transition'
      | 'pay.dispute_amount_required',
  ) {
    super(message);
    this.name = 'DisputeCaseError';
  }
}

export interface OpenDisputeCaseInput {
  readonly disputeId: string;
  readonly paymentId: string;
  readonly merchantId: string;
  readonly amount: string;
  readonly assetId: string;
  readonly reasonCode?: string | null;
  readonly paymentMarkedDisputed?: boolean;
  readonly now?: Date;
  /** Supplied only after ledger-client opening recipe returns a tx id. */
  readonly ledgerPost?: { readonly txId: string };
  /** Cover-fail or other named refuse; absent without ledgerPost → unwired socket. */
  readonly ledgerRefuse?: ChargebackLedgerRefuse;
}

/** Sync memory store or async Postgres store. Callers that share the interface await. */
type Awaitable<T> = T | Promise<T>;

/** A pool query or the caller's open transaction. Both are template tags. */
export type DisputeQuery = Sql | TransactionSql;

export type RailResolutionOutcome = 'won' | 'lost' | 'closed';

export interface RailResolutionInput {
  readonly disputeId: string;
  readonly railEventId: string;
  readonly outcome: RailResolutionOutcome;
  readonly now?: Date;
}

export interface DisputeCaseStore {
  open(input: OpenDisputeCaseInput): Awaitable<DisputeCase>;
  get(disputeId: string): Awaitable<DisputeCase | null>;
  listForPayment(paymentId: string): Awaitable<readonly DisputeCase[]>;
  /** Every case owned by one merchant, oldest first. Merchant-scoped reads (W15) start here, never from `get`. */
  listForMerchant(merchantId: string): Awaitable<readonly DisputeCase[]>;
  /** `query`, when passed, is the caller's open transaction. The memory store ignores it. */
  contest(disputeId: string, now?: Date, query?: DisputeQuery): Awaitable<DisputeCase>;
  accept(disputeId: string, now?: Date, query?: DisputeQuery): Awaitable<DisputeCase>;
  markWon(disputeId: string, now?: Date): Awaitable<DisputeCase>;
  markLost(disputeId: string, now?: Date): Awaitable<DisputeCase>;
  /**
   * Move a case from a rail won/lost/closed delivery. The same rail event id
   * returns the case unchanged. A missing case returns null.
   */
  applyRailResolution(input: RailResolutionInput): Awaitable<DisputeCase | null>;
}

const TERMINAL: ReadonlySet<DisputeCaseStatus> = new Set(['accepted', 'won', 'lost']);

const RAIL_OUTCOME_STATUS: Record<RailResolutionOutcome, DisputeCaseStatus> = {
  won: 'won',
  lost: 'lost',
  closed: 'accepted',
};

/** Accepted, won, and lost do not move again. */
export function isTerminalDisputeStatus(status: DisputeCaseStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * A rail delivery names a different close than the one already stored.
 * The same outcome (`closed` is `accepted`) is not a conflict.
 */
export function railOutcomeConflicts(status: DisputeCaseStatus, outcome: RailResolutionOutcome): boolean {
  return TERMINAL.has(status) && status !== RAIL_OUTCOME_STATUS[outcome];
}

/** Validate an open and build the row. Does not read or write a store. */
export function buildOpenDisputeCase(input: OpenDisputeCaseInput): DisputeCase {
  const disputeId = input.disputeId?.trim();
  if (!disputeId) {
    throw new DisputeCaseError('disputeId is required (separate from payment/railRef)', 'pay.dispute_id_required');
  }
  const amount = input.amount?.trim();
  if (!amount || !/^\d+(\.\d{1,18})?$/.test(amount)) {
    throw new DisputeCaseError('dispute amount must be an unsigned decimal string', 'pay.dispute_amount_required');
  }
  const now = (input.now ?? new Date()).toISOString();
  const txId = input.ledgerPost?.txId?.trim() ?? '';
  const posted = txId.length > 0;
  const ledgerRefuse = posted ? null : (input.ledgerRefuse ?? refuseChargebackLedgerPost({ disputeId, paymentId: input.paymentId }));
  return {
    disputeId,
    paymentId: input.paymentId,
    merchantId: input.merchantId,
    amount,
    assetId: input.assetId,
    reasonCode: input.reasonCode?.trim() ? input.reasonCode.trim() : null,
    status: 'open',
    openedAt: now,
    updatedAt: now,
    contestedAt: null,
    closedAt: null,
    paymentMarkedDisputed: input.paymentMarkedDisputed === true,
    ledgerWire: posted ? 'posted' : 'refused',
    ledgerRefuse,
    ledgerTxId: posted ? txId : null,
  };
}

/** The next row, or a typed refusal. Does not write a store. */
export function buildDisputeTransition(
  current: DisputeCase,
  next: DisputeCaseStatus,
  from: readonly DisputeCaseStatus[],
  now: Date | undefined,
  flags: { contested?: boolean; close?: boolean },
): DisputeCase {
  if (TERMINAL.has(current.status)) {
    throw new DisputeCaseError(`Dispute ${current.disputeId} is already ${current.status}`, 'pay.dispute_closed');
  }
  if (!from.includes(current.status)) {
    throw new DisputeCaseError(
      `Cannot move dispute ${current.disputeId} from ${current.status} to ${next}`,
      'pay.dispute_invalid_transition',
    );
  }
  const ts = (now ?? new Date()).toISOString();
  return {
    ...current,
    status: next,
    updatedAt: ts,
    contestedAt: flags.contested ? ts : current.contestedAt,
    closedAt: flags.close ? ts : current.closedAt,
    ledgerWire: current.ledgerWire,
    ledgerRefuse: current.ledgerRefuse,
    ledgerTxId: current.ledgerTxId,
  };
}

export class MemoryDisputeCaseStore implements DisputeCaseStore {
  private readonly cases = new Map<string, DisputeCase>();
  private readonly railEvents = new Map<string, { disputeId: string; outcome: RailResolutionOutcome }>();

  open(input: OpenDisputeCaseInput): DisputeCase {
    const row = buildOpenDisputeCase(input);
    const existing = this.cases.get(row.disputeId);
    if (existing) return existing;
    this.cases.set(row.disputeId, row);
    return row;
  }

  get(disputeId: string): DisputeCase | null {
    return this.cases.get(disputeId) ?? null;
  }

  listForPayment(paymentId: string): readonly DisputeCase[] {
    return [...this.cases.values()].filter((c) => c.paymentId === paymentId).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  listForMerchant(merchantId: string): readonly DisputeCase[] {
    return [...this.cases.values()]
      .filter((c) => c.merchantId === merchantId)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.disputeId.localeCompare(b.disputeId));
  }

  contest(disputeId: string, now?: Date, _query?: DisputeQuery): DisputeCase {
    return this.transition(disputeId, 'contested', ['open'], now, { contested: true });
  }

  accept(disputeId: string, now?: Date, _query?: DisputeQuery): DisputeCase {
    return this.transition(disputeId, 'accepted', ['open', 'contested'], now, { close: true });
  }

  markWon(disputeId: string, now?: Date): DisputeCase {
    return this.transition(disputeId, 'won', ['open', 'contested'], now, { close: true });
  }

  markLost(disputeId: string, now?: Date): DisputeCase {
    return this.transition(disputeId, 'lost', ['open', 'contested'], now, { close: true });
  }

  applyRailResolution(input: RailResolutionInput): DisputeCase | null {
    const disputeId = input.disputeId?.trim() ?? '';
    const railEventId = input.railEventId?.trim() ?? '';
    if (!disputeId || !railEventId) return null;
    const prior = this.railEvents.get(railEventId);
    if (prior) {
      if (prior.disputeId !== disputeId) {
        throw new DisputeCaseError('a rail event id cannot move a different dispute', 'pay.dispute_invalid_transition');
      }
      return this.get(disputeId);
    }
    const current = this.cases.get(disputeId);
    if (!current) return null;
    const next = RAIL_OUTCOME_STATUS[input.outcome];
    if (current.status !== next) {
      const row = this.transition(disputeId, next, ['open', 'contested'], input.now, { close: true });
      this.railEvents.set(railEventId, { disputeId, outcome: input.outcome });
      return row;
    }
    this.railEvents.set(railEventId, { disputeId, outcome: input.outcome });
    return current;
  }

  private transition(
    disputeId: string,
    next: DisputeCaseStatus,
    from: readonly DisputeCaseStatus[],
    now: Date | undefined,
    flags: { contested?: boolean; close?: boolean },
  ): DisputeCase {
    const current = this.cases.get(disputeId);
    if (!current) {
      throw new DisputeCaseError(`No dispute case ${disputeId}`, 'pay.dispute_not_found');
    }
    const row = buildDisputeTransition(current, next, from, now, flags);
    this.cases.set(disputeId, row);
    return row;
  }
}

/**
 * Process-local default for unit tests and routers that do not receive a store.
 * Production `index.ts` uses `PostgresDisputeCaseStore` instead.
 */
export const defaultDisputeCaseStore = new MemoryDisputeCaseStore();

export {
  CHARGEBACK_LEDGER_REFUSE_CODE,
  CHARGEBACK_LEDGER_SOCKET_ID,
  CHARGEBACK_LEDGER_UNCOVERED_CODE,
  refuseChargebackLedgerPost,
  refuseChargebackPlanConflict,
  refuseChargebackUncovered,
  type ChargebackLedgerRefuse,
};
