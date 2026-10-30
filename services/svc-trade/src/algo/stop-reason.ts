/**
 * Documented bot stop reasons for "My bots" (CB-bots-01).
 *
 * `haltReason` on a parent is free text written by the engine. The customer
 * reads a stable code and label instead, derived from what the engine
 * actually recorded: the cancel-incomplete halt marker, or the typed code of
 * the miss that halted the schedule. Nothing is guessed: a halt the engine
 * did not type reads `unrecorded`, never a plausible-looking reason.
 *
 * Reasons other engines will emit (liquidation, delisting, position limit,
 * contract parameter change, copied-lead stop) are part of the documented
 * list so the front end can render them; the TWAP/VWAP/POV engine never
 * produces them today.
 */

import { CANCEL_INCOMPLETE_HALT, CHASE_CHILD_UNACCOUNTED_HALT, CHASE_EXPIRED_HALT, CHASE_MAX_DISTANCE_HALT } from './twap-engine.js';
import type { AlgoMissCode, TwapParent } from './types.js';

export const ALGO_STOP_REASONS = {
  cancel_incomplete: 'Cancel incomplete',
  market_closed: 'Market closed',
  mark_unavailable: 'Market price unavailable',
  price_band: 'Price outside the limit',
  no_liquidity: 'No liquidity',
  no_volume: 'No market volume',
  insufficient_balance: 'Insufficient balance',
  account_unavailable: 'Account unavailable',
  order_refused: 'Order refused',
  chase_max_distance: 'Maximum chase distance reached',
  chase_expired: 'Chase time ended',
  chase_child_unaccounted: 'Stopped: a fill is still settling',
  liquidation: 'Liquidation',
  delisting: 'Delisting',
  position_limit: 'Position limit',
  contract_change: 'Contract parameter change',
  copied_lead_stop: 'Copied lead stopped',
  unrecorded: 'Stop reason not recorded',
} as const;

export type AlgoStopReasonCode = keyof typeof ALGO_STOP_REASONS;

export interface AlgoStopReason {
  readonly code: AlgoStopReasonCode;
  readonly label: string;
}

const BY_MISS_CODE: Readonly<Record<AlgoMissCode, AlgoStopReasonCode>> = {
  'trade.algo_no_liquidity': 'no_liquidity',
  'trade.algo_price_band': 'price_band',
  'trade.algo_mark_unusable': 'mark_unavailable',
  'trade.algo_mark_missing': 'mark_unavailable',
  'trade.algo_insufficient_balance': 'insufficient_balance',
  'trade.algo_market_closed': 'market_closed',
  'trade.algo_principal_unavailable': 'account_unavailable',
  'trade.algo_child_refused': 'order_refused',
  'trade.algo_no_volume': 'no_volume',
};

function reason(code: AlgoStopReasonCode): AlgoStopReason {
  return { code, label: ALGO_STOP_REASONS[code] };
}

/**
 * Stop reason for a parent, or null when it did not stop on its own.
 * Active, paused, completed and user-cancelled parents carry none.
 */
export function algoStopReason(parent: Pick<TwapParent, 'status' | 'haltReason' | 'misses'>): AlgoStopReason | null {
  if (parent.haltReason === CANCEL_INCOMPLETE_HALT) return reason('cancel_incomplete');
  if (parent.status !== 'halted') return null;
  if (parent.haltReason === CHASE_MAX_DISTANCE_HALT) return reason('chase_max_distance');
  if (parent.haltReason === CHASE_EXPIRED_HALT) return reason('chase_expired');
  if (parent.haltReason === CHASE_CHILD_UNACCOUNTED_HALT) return reason('chase_child_unaccounted');
  const last = parent.misses.length > 0 ? parent.misses[parent.misses.length - 1] : undefined;
  if (!last) return reason('unrecorded');
  return reason(BY_MISS_CODE[last.code] ?? 'unrecorded');
}
