/**
 * pay.routing product policy — smart rail selection mechanism honesty (D26-P1-P3).
 *
 * Pure mechanism: geo + method + risk required; no invented approval rates,
 * cost weights, or payer-named rails. Live acquiring / PSP connectors Class X.
 */

import { FORBIDDEN_ROUTING_SCORE_FIELDS } from './routing-inputs.js';

/** Smart routing always requires these dimensions — never preference-only invent. */
export const ROUTING_REQUIRED_DIMENSIONS = ['geo', 'method', 'risk'] as const;

/** Named refuse codes on the product path. */
export const ROUTING_INPUT_MISSING = 'pay.routing_input_missing' as const;
export const ROUTING_NO_RAIL = 'pay.routing_no_rail' as const;
/**
 * No otherwise eligible rail carries an operator-declared success fraction.
 * The selector throws this; the board must name it. Blank is not a rate.
 */
export const ROUTING_APPROVAL_RATE_UNSET = 'pay.routing_approval_rate_unset' as const;

/** Append-only decision record kind for payment_events / operator logs. */
export const ROUTING_DECISION_KIND = 'pay.routing.decision' as const;

/** v1 reference profiles in decide.ts — listed here for honesty board only. */
export const REFERENCE_PROFILE_RAIL_IDS = ['crypto-native', 'card-sandbox', 'bank-transfer-sandbox'] as const;

export type RoutingPolicySummary = ReturnType<typeof describeRoutingPolicy>;

/** Public honesty board for pay.routing — mechanism only, live PSP Class X. */
export function describeRoutingPolicy() {
  return {
    requiredDimensions: [...ROUTING_REQUIRED_DIMENSIONS],
    refuseCodes: [ROUTING_INPUT_MISSING, ROUTING_NO_RAIL, ROUTING_APPROVAL_RATE_UNSET] as const,
    decisionKind: ROUTING_DECISION_KIND,
    forbiddenScoreFields: [...FORBIDDEN_ROUTING_SCORE_FIELDS],
    referenceProfileRailIds: [...REFERENCE_PROFILE_RAIL_IDS],
    inventsApprovalRates: false as const,
    inventsCostWeights: false as const,
    payerMayNameRail: false as const,
    preferenceOperatorSupplied: true as const,
    referenceProfilesNotSilentDefault: true as const,
    skipCannotHonestlyAccept: true as const,
    idempotencyPerPaymentNotAttempt: true as const,
    optimiseSuccessThenCost: true as const,
    undisclosedRailIncentivesForbidden: true as const,
    explainableDecisions: true as const,
    movesValue: false as const,
  };
}
