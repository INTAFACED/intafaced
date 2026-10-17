/**
 * §13 socket — chargeback ledger wire (pay.fraud / D26-P1-P5).
 *
 * Production dispute open posts `chargebackOpen` through `chargeback-ledger.ts`
 * (ledger-client only). This module is the named refuse for:
 *   - fixture / no money port (HTTP must not claim posted)
 *   - an opening post the ledger refuses for funds
 *
 * Won, shortfall, and shortfall recovery post through `chargeback-ledger.ts`.
 * A won dispute with nothing booked does not credit the merchant. Blocklist /
 * scheme list **content** remains Class X. Never Hyperswitch. Never grant `pay:*`.
 */

export const CHARGEBACK_LEDGER_SOCKET_ID = 'socket.pay-chargeback-ledger-wire' as const;

export const CHARGEBACK_LEDGER_REFUSE_CODE = 'pay.chargeback_ledger_unwired' as const;

export const CHARGEBACK_LEDGER_UNCOVERED_CODE = 'pay.chargeback_uncovered' as const;

export const CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE = 'pay.chargeback_plan_conflict' as const;

/** Won arrived and neither the opening nor a shortfall was booked. Nothing to return. */
export const CHARGEBACK_NOTHING_TO_REVERSE_CODE = 'pay.chargeback_nothing_to_reverse' as const;

/** Merchant pots are short and the insurance fund cannot cover the rest. Nothing was posted. */
export const CHARGEBACK_SHORTFALL_UNFUNDED_CODE = 'pay.chargeback_shortfall_unfunded' as const;

export type ChargebackLedgerRefuseCode =
  | typeof CHARGEBACK_LEDGER_REFUSE_CODE
  | typeof CHARGEBACK_LEDGER_UNCOVERED_CODE
  | typeof CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE
  | typeof CHARGEBACK_NOTHING_TO_REVERSE_CODE
  | typeof CHARGEBACK_SHORTFALL_UNFUNDED_CODE;

export interface ChargebackLedgerRefuse {
  readonly code: ChargebackLedgerRefuseCode;
  readonly socket: typeof CHARGEBACK_LEDGER_SOCKET_ID;
  readonly message: string;
  readonly disputeId: string;
  readonly paymentId: string;
}

/** Fixture / missing money port — case recorded, no value moved. */
export function refuseChargebackLedgerPost(input: { readonly disputeId: string; readonly paymentId: string }): ChargebackLedgerRefuse {
  return {
    code: CHARGEBACK_LEDGER_REFUSE_CODE,
    socket: CHARGEBACK_LEDGER_SOCKET_ID,
    message: 'Chargeback ledger port absent ' + `(${CHARGEBACK_LEDGER_SOCKET_ID}). Dispute case recorded; no value moved.`,
    disputeId: input.disputeId,
    paymentId: input.paymentId,
  };
}

/**
 * The opening post itself was refused for funds (the book moved under a plan).
 * A planned shortfall is `chargebackShortfall`, not this refuse.
 */
export function refuseChargebackUncovered(input: { readonly disputeId: string; readonly paymentId: string }): ChargebackLedgerRefuse {
  return {
    code: CHARGEBACK_LEDGER_UNCOVERED_CODE,
    socket: CHARGEBACK_LEDGER_SOCKET_ID,
    message:
      'Clearing and the merchant balance cannot cover this opening. The shortfall is a separate post ' +
      `(${CHARGEBACK_LEDGER_SOCKET_ID}). No value moved by this delivery.`,
    disputeId: input.disputeId,
    paymentId: input.paymentId,
  };
}

/**
 * A redelivery names a different amount than the opening this dispute already planned. The rail must not redeliver forever:
 * the case is recorded and the conflict named; the money plan stays the first one. No value moved by this refusal.
 */
export function refuseChargebackNothingToReverse(input: {
  readonly disputeId: string;
  readonly paymentId: string;
}): ChargebackLedgerRefuse {
  return {
    code: CHARGEBACK_NOTHING_TO_REVERSE_CODE,
    socket: CHARGEBACK_LEDGER_SOCKET_ID,
    message:
      'No chargeback opening is booked for this dispute, so a won outcome does not credit the merchant ' +
      `(${CHARGEBACK_LEDGER_SOCKET_ID}).`,
    disputeId: input.disputeId,
    paymentId: input.paymentId,
  };
}

/**
 * The insurance fund cannot cover the planned shortfall. The dispute is still recorded.
 * Nothing is posted. A later lost or closed delivery books the opening once the fund can cover.
 */
export function refuseChargebackShortfallUnfunded(input: {
  readonly disputeId: string;
  readonly paymentId: string;
}): ChargebackLedgerRefuse {
  return {
    code: CHARGEBACK_SHORTFALL_UNFUNDED_CODE,
    socket: CHARGEBACK_LEDGER_SOCKET_ID,
    message:
      'Insurance fund cannot cover the chargeback shortfall ' +
      `(${CHARGEBACK_SHORTFALL_UNFUNDED_CODE}). No opening and no shortfall were posted.`,
    disputeId: input.disputeId,
    paymentId: input.paymentId,
  };
}

export function refuseChargebackPlanConflict(input: { readonly disputeId: string; readonly paymentId: string }): ChargebackLedgerRefuse {
  return {
    code: CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE,
    socket: CHARGEBACK_LEDGER_SOCKET_ID,
    message:
      'This dispute already planned its opening for a different amount; the first plan stands ' +
      `(${CHARGEBACK_LEDGER_SOCKET_ID}). No value moved by this delivery.`,
    disputeId: input.disputeId,
    paymentId: input.paymentId,
  };
}
