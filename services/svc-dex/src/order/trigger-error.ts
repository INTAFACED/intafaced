/**
 * Typed refusals for price-trigger orders (D-limit-dca-02).
 * Attempt reasons are a separate set: they explain a keeper tick, they are not HTTP refusals.
 */

export const triggerOrderCodes = {
  principalRequired: 'dex.order.principal_required',
  badRequest: 'dex.order.bad_request',
  minSizeUnset: 'dex.order.min_size_unset',
  belowMinSize: 'dex.order.below_min_size',
  expiryRequired: 'dex.order.expiry_required',
  expiryInvalid: 'dex.order.expiry_invalid',
  restrictedListUnset: 'dex.order.restricted_list_unset',
  restrictedToken: 'dex.order.restricted_token',
  warnListUnset: 'dex.order.warn_list_unset',
  domainUnset: 'dex.order.domain_unset',
  slippageUnset: 'dex.order.slippage_unset',
  slippageInvalid: 'dex.order.slippage_invalid',
  minOutUnset: 'dex.order.min_out_unset',
  minOutInvalid: 'dex.order.min_out_invalid',
  amountUnset: 'dex.order.amount_unset',
  amountInvalid: 'dex.order.amount_invalid',
  triggerUnset: 'dex.order.trigger_unset',
  triggerInvalid: 'dex.order.trigger_invalid',
  tokenInvalid: 'dex.order.token_invalid',
  makerInvalid: 'dex.order.maker_invalid',
  signatureRequired: 'dex.order.signature_required',
  signatureInvalid: 'dex.order.signature_invalid',
  notFound: 'dex.order.not_found',
  conflict: 'dex.order.conflict',
  oracleMaxAgeUnset: 'dex.order.oracle_max_age_unset',
  tickUnset: 'dex.order.tick_unset',
} as const;

export type TriggerOrderCode = (typeof triggerOrderCodes)[keyof typeof triggerOrderCodes];

export const attemptReasons = {
  predicateFalse: 'predicate_false',
  oracleStale: 'oracle_stale',
  oracleDisagree: 'oracle_disagree',
  insufficientLiquidity: 'insufficient_liquidity',
  reverted: 'reverted',
  feedMarket: 'feed.market',
  railCrypto: 'rail.crypto',
  oracleMaxAgeUnset: 'dex.order.oracle_max_age_unset',
} as const;

export type AttemptReason = (typeof attemptReasons)[keyof typeof attemptReasons];

export class TriggerOrderRefused extends Error {
  constructor(
    readonly code: TriggerOrderCode,
    message: string,
  ) {
    super(message);
    this.name = 'TriggerOrderRefused';
  }
}

export function refuseTrigger(code: TriggerOrderCode, message: string): never {
  throw new TriggerOrderRefused(code, message);
}
