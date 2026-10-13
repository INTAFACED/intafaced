/**
 * §13 socket — chargeback ledger wire (pay.fraud / D26-P1-P5).
 *
 * Production dispute open posts `chargebackOpen` through `chargeback-ledger.ts`
 * (ledger-client only). This module is the named refuse for:
 *   - fixture / no money port (HTTP must not claim posted)
 *   - merchant pots that cannot cover (do not invent `chargebackShortfall`)
 *
 * `chargebackWon` / shortfall recovery stay unwired. Do not invent split-leg
 * policy beyond the recipe's two caller-supplied legs. Blocklist / scheme list
 * **content** remains Class X. Never Hyperswitch. Never grant `pay:*`.
 */

export const CHARGEBACK_LEDGER_SOCKET_ID = 'socket.pay-chargeback-ledger-wire' as const;

export const CHARGEBACK_LEDGER_REFUSE_CODE = 'pay.chargeback_ledger_unwired' as const;

export const CHARGEBACK_LEDGER_UNCOVERED_CODE = 'pay.chargeback_uncovered' as const;

export const CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE = 'pay.chargeback_plan_conflict' as const;

export type ChargebackLedgerRefuseCode =
  typeof CHARGEBACK_LEDGER_REFUSE_CODE | typeof CHARGEBACK_LEDGER_UNCOVERED_CODE | typeof CHARGEBACK_LEDGER_PLAN_CONFLICT_CODE;

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

/** Merchant pots cannot cover; shortfall recipes stay refuse-closed. */
export function refuseChargebackUncovered(input: { readonly disputeId: string; readonly paymentId: string }): ChargebackLedgerRefuse {
  return {
    code: CHARGEBACK_LEDGER_UNCOVERED_CODE,
    socket: CHARGEBACK_LEDGER_SOCKET_ID,
    message:
      'Merchant clearing and available cannot cover this chargeback; ' +
      `shortfall recipes stay refuse-closed (${CHARGEBACK_LEDGER_SOCKET_ID}). No value moved.`,
    disputeId: input.disputeId,
    paymentId: input.paymentId,
  };
}

/**
 * A redelivery names a different amount than the opening this dispute already planned. The rail must not redeliver forever:
 * the case is recorded and the conflict named; the money plan stays the first one. No value moved by this refusal.
 */
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
