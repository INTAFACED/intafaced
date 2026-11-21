import { parseAmount } from '../../../shared/money';
import type { SpotConditionalKind } from '../../../features/trade/venue-api';

// The venue spot desk's conditional orders (J-cex-spot-08): which fields each kind takes, and the form's own check that
// the legs' prices are in order before anything is sent (svc-trade checks the same again and answers in its own words).

export type SpotField = 'triggerPrice' | 'limitPrice' | 'takeProfitPrice' | 'entryPrice' | 'closePrice';

/** The price fields each kind shows, in order; `limitPrice` on an OCO or bracket is the stop loss's limit. */
export const SPOT_FIELDS: Readonly<Record<SpotConditionalKind, readonly SpotField[]>> = {
  stop_limit: ['triggerPrice', 'limitPrice'],
  stop_market: ['triggerPrice'],
  oco: ['takeProfitPrice', 'triggerPrice', 'limitPrice'],
  bracket: ['entryPrice', 'takeProfitPrice', 'triggerPrice', 'limitPrice'],
  oto: ['entryPrice', 'closePrice'],
};

/** A field the form may leave blank: an OCO's or bracket's stop-loss limit on a sell exit (it fires at market). */
export function optionalField(kind: SpotConditionalKind, side: 'buy' | 'sell', field: SpotField): boolean {
  if (field !== 'limitPrice' || (kind !== 'oco' && kind !== 'bracket')) return false;
  const exit = kind === 'bracket' ? (side === 'buy' ? 'sell' : 'buy') : side;
  return exit === 'sell';
}

const num = (v: string | undefined): bigint | null => {
  if (!v || !/^\d+(\.\d+)?$/.test(v.trim())) return null;
  return parseAmount(v.trim());
};

/** Why the legs are out of order, in the form's words, or null when they are in order (or not all typed yet). */
export type OrderProblem =
  | { readonly key: 'tp_above_sl'; readonly tp: string; readonly sl: string }
  | { readonly key: 'tp_below_sl'; readonly tp: string; readonly sl: string }
  | { readonly key: 'limit_past_trigger'; readonly exit: 'buy' | 'sell' }
  | { readonly key: 'close_side'; readonly side: 'buy' | 'sell' };

export function legsOutOfOrder(
  kind: SpotConditionalKind,
  side: 'buy' | 'sell',
  fields: Partial<Record<SpotField, string>>,
): OrderProblem | null {
  const tp = num(fields.takeProfitPrice);
  const sl = num(fields.triggerPrice);
  const limit = num(fields.limitPrice);
  if (kind === 'oco' || kind === 'bracket') {
    const exit = kind === 'bracket' ? (side === 'buy' ? 'sell' : 'buy') : side;
    if (tp !== null && sl !== null) {
      if (exit === 'sell' && tp <= sl) return { key: 'tp_above_sl', tp: fields.takeProfitPrice!.trim(), sl: fields.triggerPrice!.trim() };
      if (exit === 'buy' && tp >= sl) return { key: 'tp_below_sl', tp: fields.takeProfitPrice!.trim(), sl: fields.triggerPrice!.trim() };
    }
    if (limit !== null && sl !== null && (exit === 'sell' ? limit > sl : limit < sl)) return { key: 'limit_past_trigger', exit };
  }
  if (kind === 'stop_limit' && limit !== null && sl !== null && (side === 'sell' ? limit > sl : limit < sl))
    return { key: 'limit_past_trigger', exit: side };
  if (kind === 'oto') {
    const entry = num(fields.entryPrice);
    const close = num(fields.closePrice);
    if (entry !== null && close !== null && (side === 'buy' ? close <= entry : close >= entry)) return { key: 'close_side', side };
  }
  return null;
}

/** A client order id for one conditional: letters and digits, never a random id reused as a key. */
export function spotClientId(now: number, counter: number): string {
  return `sc-${now.toString(36)}${counter.toString(36)}`;
}
