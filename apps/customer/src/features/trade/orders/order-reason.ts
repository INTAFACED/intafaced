/** Why an order ended, as the service recorded it, in the words the order page uses. */
const REASONS = {
  requested: 'reasonRequested',
  self_trade_prevention: 'reasonSelfTrade',
  ioc_remainder: 'reasonIoc',
  market_remainder: 'reasonMarketRemainder',
  fok_unfillable: 'reasonFok',
  post_only_would_cross: 'reasonPostOnly',
  expired: 'reasonExpired',
  oco_sibling_filled: 'reasonOcoSibling',
  trigger_rejected: 'reasonTriggerRejected',
  session_dead: 'reasonSessionDead',
  hold_unconfirmed: 'reasonHoldUnconfirmed',
} as const;

export type ReasonKey = (typeof REASONS)[keyof typeof REASONS];

/**
 * The reason line of an ended order: a known engine reason in words, any other recorded code as a refusal code (shown
 * through the shared refusal words), or `not-recorded` when the service kept none. A filled or open order has no line.
 */
export function orderReason(order: {
  status: string;
  rejectCode?: string | null;
}): { kind: 'none' } | { kind: 'not-recorded' } | { kind: 'known'; key: ReasonKey } | { kind: 'code'; code: string } {
  if (order.status === 'open' || order.status === 'closed') return { kind: 'none' };
  const code = order.rejectCode?.trim() ?? '';
  if (code === '') return { kind: 'not-recorded' };
  return Object.hasOwn(REASONS, code) ? { kind: 'known', key: REASONS[code as keyof typeof REASONS] } : { kind: 'code', code };
}
