import { div, mul, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { TradeError } from '../spot/types.js';

/**
 * THE CLOSE TOLERANCE: how far a protective close on the person's own venue account may cross the market.
 *
 * A stop's fired market exit, from its trigger, and a reduce-only close the desk sends, from the mark, are priced by
 * the owner's `TRADE_CLOSE_SLIPPAGE_BPS` and by nothing else: this file is its one home. The door requires it set for
 * a perpetual's reduce-only market or IOC order; it does not bound that order's price. Blank, non-integer or outside
 * 1–5000 refuses `trade.close_slippage_unset`; never an invented tolerance. The browser reads the value from
 * `/venue/status` (`closeSlippageBps`) and never keeps its own.
 */

export function requireCloseSlippageBps(bps: number | null | undefined): bigint {
  if (bps == null || !Number.isInteger(bps) || bps < 1 || bps > 5000) {
    throw new TradeError(
      'TRADE_CLOSE_SLIPPAGE_BPS is unset or not an integer 1–5000 — no stop or reduce-only close is priced rather than invent a tolerance',
      'trade.close_slippage_unset',
    );
  }
  return BigInt(bps);
}

/**
 * A close's worst price before rounding: `bps` past `from`, against the side that closes (a sell below, a buy above).
 * The caller puts it on the market's tick (and the venue's price rule).
 */
export function closeTolerancePrice(side: 'buy' | 'sell', from: Amount, bps: number | null | undefined): Amount {
  const tolerance = requireCloseSlippageBps(bps);
  const tenThousand = parseAmount('10000');
  return side === 'sell'
    ? div(mul(from, parseAmount(String(10_000n - tolerance))), tenThousand, 'floor')
    : div(mul(from, parseAmount(String(10_000n + tolerance))), tenThousand, 'ceil');
}
