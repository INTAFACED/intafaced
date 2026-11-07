/** Typed refusals for wallet orders (D-limit-dca-01 to -04). The code leads the message on the wire. */
export const vaultCodes = {
  badRequest: 'dex.order.bad_request',
  notFound: 'dex.order.not_found',
  conflict: 'dex.order.conflict',
  internal: 'dex.internal',
  pairUnset: 'dex.order.pair_unset',
  railCrypto: 'rail.crypto',
  amountInvalid: 'dex.order.amount_invalid',
  minSizeUnset: 'dex.order.min_size_unset',
  belowMinSize: 'dex.order.below_min_size',
  expiryRequired: 'dex.order.expiry_required',
  expiryInvalid: 'dex.order.expiry_invalid',
  slippageUnset: 'dex.order.slippage_unset',
  restrictedListUnset: 'dex.order.restricted_list_unset',
  restrictedToken: 'dex.order.restricted_token',
  triggerInvalid: 'dex.order.trigger_invalid',
  tpNotAboveSl: 'dex.order.tp_not_above_sl',
  tpNotBelowSl: 'dex.order.tp_not_below_sl',
  triggerNotAllowedOnTrailing: 'dex.order.trigger_not_allowed_on_trailing',
  trailBoundsUnset: 'dex.order.trail_bounds_unset',
  trailOutOfBounds: 'dex.order.trail_out_of_bounds',
  insufficientCredit: 'dex.order.insufficient_credit',
  capExceeded: 'dex.order.cap_exceeded',
  draftExpired: 'dex.order.draft_expired',
  signatureInvalid: 'dex.order.signature_invalid',
  notEditable: 'dex.order.not_editable',
  notCancellable: 'dex.order.not_cancellable',
  nothingToSweep: 'dex.order.nothing_to_sweep',
  nothingToWithdraw: 'dex.order.nothing_to_withdraw',
  priceUnavailable: 'dex.order.price_unavailable',
} as const;
export type VaultCode = (typeof vaultCodes)[keyof typeof vaultCodes];

export class VaultOrderRefused extends Error {
  constructor(
    readonly code: VaultCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultOrderRefused';
  }
}

export function refuse(code: VaultCode, message: string): never {
  throw new VaultOrderRefused(code, message);
}
