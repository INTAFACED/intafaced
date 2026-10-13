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

export interface DisputeCaseStore {
  open(input: OpenDisputeCaseInput): DisputeCase;
  get(disputeId: string): DisputeCase | null;
  listForPayment(paymentId: string): readonly DisputeCase[];
  contest(disputeId: string, now?: Date): DisputeCase;
  accept(disputeId: string, now?: Date): DisputeCase;
  markWon(disputeId: string, now?: Date): DisputeCase;
  markLost(disputeId: string, now?: Date): DisputeCase;
}

const TERMINAL: ReadonlySet<DisputeCaseStatus> = new Set(['accepted', 'won', 'lost']);

export class MemoryDisputeCaseStore implements DisputeCaseStore {
  private readonly cases = new Map<string, DisputeCase>();

  open(input: OpenDisputeCaseInput): DisputeCase {
    const disputeId = input.disputeId?.trim();
    if (!disputeId) {
      throw new DisputeCaseError('disputeId is required (separate from payment/railRef)', 'pay.dispute_id_required');
    }
    const amount = input.amount?.trim();
    if (!amount || !/^\d+(\.\d{1,18})?$/.test(amount)) {
      throw new DisputeCaseError('dispute amount must be an unsigned decimal string', 'pay.dispute_amount_required');
    }
    const existing = this.cases.get(disputeId);
    if (existing) return existing;

    const now = (input.now ?? new Date()).toISOString();
    const txId = input.ledgerPost?.txId?.trim() ?? '';
    const posted = txId.length > 0;
    const ledgerRefuse = posted ? null : (input.ledgerRefuse ?? refuseChargebackLedgerPost({ disputeId, paymentId: input.paymentId }));
    const row: DisputeCase = {
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
    this.cases.set(disputeId, row);
    return row;
  }

  get(disputeId: string): DisputeCase | null {
    return this.cases.get(disputeId) ?? null;
  }

  listForPayment(paymentId: string): readonly DisputeCase[] {
    return [...this.cases.values()].filter((c) => c.paymentId === paymentId).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  contest(disputeId: string, now?: Date): DisputeCase {
    return this.transition(disputeId, 'contested', ['open'], now, { contested: true });
  }

  accept(disputeId: string, now?: Date): DisputeCase {
    return this.transition(disputeId, 'accepted', ['open', 'contested'], now, { close: true });
  }

  markWon(disputeId: string, now?: Date): DisputeCase {
    return this.transition(disputeId, 'won', ['open', 'contested'], now, { close: true });
  }

  markLost(disputeId: string, now?: Date): DisputeCase {
    return this.transition(disputeId, 'lost', ['open', 'contested'], now, { close: true });
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
    if (TERMINAL.has(current.status)) {
      throw new DisputeCaseError(`Dispute ${disputeId} is already ${current.status}`, 'pay.dispute_closed');
    }
    if (!from.includes(current.status)) {
      throw new DisputeCaseError(`Cannot move dispute ${disputeId} from ${current.status} to ${next}`, 'pay.dispute_invalid_transition');
    }
    const ts = (now ?? new Date()).toISOString();
    const row: DisputeCase = {
      ...current,
      status: next,
      updatedAt: ts,
      contestedAt: flags.contested ? ts : current.contestedAt,
      closedAt: flags.close ? ts : current.closedAt,
      ledgerWire: current.ledgerWire,
      ledgerRefuse: current.ledgerRefuse,
      ledgerTxId: current.ledgerTxId,
    };
    this.cases.set(disputeId, row);
    return row;
  }
}

/** Process-local default — durable disputes table is residual, not invent here. */
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
