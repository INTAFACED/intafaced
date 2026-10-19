/**
 * Time in force on the spot ticket: what the trader may pick, what the order carries, and how the outcome is worded.
 *
 * The service accepts GTC, post-only (PO), IOC and FOK on a limit order, and a market order is already immediate
 * (the engine sends it as IOC, or FOK when asked). Stop-limit is accepted (GTC only). A sell OCO (GTC) and a buy
 * bracket (market, IOC or FOK entry) are accepted. Trailing stop is refused by the service
 * (`trade.order_type_unsupported`), so the ticket shows it disabled (`UNSUPPORTED_TYPES`).
 */
import type { Draft, Order } from '../../../features/trade/trade-api';
import { scaled, type OrderType } from './order-math';

export type Tif = 'GTC' | 'PO' | 'IOC' | 'FOK';

const LIMIT_TIFS: readonly Tif[] = ['GTC', 'PO', 'IOC', 'FOK'];
/** A market order never rests, so "good till cancelled" and "post only" do not apply. Standard = the engine's immediate rule. */
const MARKET_TIFS: readonly Tif[] = ['GTC', 'FOK'];

/** A stop-limit rests until it triggers, so only good-till-cancelled applies. */
const STOP_TIFS: readonly Tif[] = ['GTC'];

/** A sell OCO rests its take-profit leg until the pair ends, so it is good till cancelled only. */
const OCO_TIFS: readonly Tif[] = ['GTC'];

/** A bracket's buy entry must resolve inside the request (the exit is placed once it has filled), so it never rests. */
const BRACKET_TIFS: readonly Tif[] = ['IOC', 'FOK'];

export const tifsFor = (type: OrderType): readonly Tif[] =>
  type === 'limit'
    ? LIMIT_TIFS
    : type === 'stop_limit'
      ? STOP_TIFS
      : type === 'oco'
        ? OCO_TIFS
        : type === 'bracket'
          ? BRACKET_TIFS
          : MARKET_TIFS;

/** Keep the pick when the new order type still allows it, otherwise fall back to the standard one (a bracket's is IOC). */
export const tifFor = (type: OrderType, tif: Tif): Tif => (tifsFor(type).includes(tif) ? tif : (tifsFor(type)[0] ?? 'GTC'));

/** The two fields the order carries. Post-only is sent as time in force PO and postOnly true, as the service expects. */
export function tifFields(tif: Tif): Pick<Draft, 'timeInForce' | 'postOnly'> {
  return tif === 'PO' ? { timeInForce: 'PO', postOnly: true } : { timeInForce: tif, postOnly: false };
}

export type TifLabelKey = 'Tif GTC' | 'Tif PO' | 'Tif IOC' | 'Tif FOK' | 'Tif market standard' | 'Tif market FOK';
export type TifHelpKey = `${TifLabelKey} help`;

/** Copy key for the name of a pick. A market order's "standard" is the engine's immediate rule, not "good till cancelled". */
export function tifLabelKey(type: OrderType, tif: Tif): TifLabelKey {
  if (type === 'market') return tif === 'FOK' ? 'Tif market FOK' : 'Tif market standard';
  return tif === 'PO' ? 'Tif PO' : tif === 'IOC' ? 'Tif IOC' : tif === 'FOK' ? 'Tif FOK' : 'Tif GTC';
}

/** The pick a draft was built from (the inverse of `tifFields`). */
export const tifOfDraft = (draft: Pick<Draft, 'timeInForce' | 'postOnly'>): Tif =>
  draft.postOnly || draft.timeInForce === 'PO' ? 'PO' : draft.timeInForce;

/** Order kinds the service refuses on spot today. They are listed, disabled, with one shared reason. */
export const UNSUPPORTED_TYPES = ['trailingStop'] as const;
export type UnsupportedType = (typeof UNSUPPORTED_TYPES)[number];

/** What the order itself says it is, for the tables: nothing for a plain limit or market, a short tag otherwise. */
export function orderTag(order: Pick<Order, 'timeInForce' | 'postOnly'>): 'PO' | 'IOC' | 'FOK' | 'GTD' | 'GTT' | null {
  if (order.postOnly || order.timeInForce === 'PO') return 'PO';
  if (order.timeInForce === 'IOC' || order.timeInForce === 'FOK' || order.timeInForce === 'GTD' || order.timeInForce === 'GTT')
    return order.timeInForce;
  return null;
}

export type Outcome =
  | { kind: 'filled' }
  | { kind: 'resting' }
  | { kind: 'partCancelled' }
  | { kind: 'noFill'; tif: Tif }
  | { kind: 'rejected'; tif: Tif }
  | { kind: 'done' };

/**
 * What happened to an order the service accepted a request for. An order that came back rejected, or finished with
 * nothing filled, is NOT "done": the trader must hear that nothing traded and, for post-only and fill-or-kill, why.
 */
export function outcomeOf(order: Pick<Order, 'status' | 'filled' | 'remaining'>, tif: Tif): Outcome {
  const filled = scaled(order.filled) ?? 0n;
  const remaining = scaled(order.remaining) ?? 0n;
  if (order.status === 'open') return { kind: 'resting' };
  if (order.status === 'rejected') return { kind: 'rejected', tif };
  if (order.status === 'closed' && remaining === 0n && filled > 0n) return { kind: 'filled' };
  if (filled === 0n) return { kind: 'noFill', tif };
  if (remaining > 0n) return { kind: 'partCancelled' };
  return { kind: 'done' };
}
