/**
 * Time in force on the spot ticket: what the trader may pick, what the order carries, and how the outcome is worded.
 *
 * The service accepts GTC, good-till-date (GTD, with an expiry the trader picks), post-only (PO), IOC and FOK on a limit order, and a market order is already immediate
 * (the engine sends it as IOC, or FOK when asked). Stop-limit and stop-market are accepted (GTC only). An OCO (GTC, either side) and a buy
 * bracket (market, IOC, FOK or a resting GTC limit entry) are accepted, and a buy OTO (a GTC, IOC or FOK limit entry with one
 * close price). Trailing stop is refused by the service
 * (`trade.order_type_unsupported`), so the ticket shows it disabled (`UNSUPPORTED_TYPES`).
 */
import type { Draft, Order } from '../../../features/trade/trade-api';
import { SPOT_ORDER_TYPE_SEND, SPOT_REFUSED_ORDER_TYPES, type SpotTimeInForce } from '@intafaced/contracts/spot-order-types';
import { scaled, type OrderType } from './order-math';

export type Tif = SpotTimeInForce;

/**
 * The times in force the ticket offers per type: the shared list the API publishes (`@intafaced/contracts/spot-order-types`),
 * so the ticket and `GET /api/v1/order-types` never differ. A limit takes all five; a market order never rests, so
 * "good till cancelled" there is the engine's immediate rule and fill-or-kill its other pick; a stop and an OCO rest until
 * they trigger or end (GTC); a bracket entry resolves inside the request (IOC, FOK) or rests with an entry price (GTC); an
 * OTO entry rests until it fills (GTC, the default) or resolves inside the request.
 */
export const tifsFor = (type: OrderType): readonly Tif[] => SPOT_ORDER_TYPE_SEND[type].timeInForce;

/** Keep the pick when the new order type still allows it, otherwise fall back to the standard one (a bracket's is IOC). */
export const tifFor = (type: OrderType, tif: Tif): Tif => (tifsFor(type).includes(tif) ? tif : (tifsFor(type)[0] ?? 'GTC'));

/** The two fields the order carries. Post-only is sent as time in force PO and postOnly true, as the service expects. */
export function tifFields(tif: Tif, expireAt?: string): Pick<Draft, 'timeInForce' | 'postOnly' | 'expireAt'> {
  if (tif === 'PO') return { timeInForce: 'PO', postOnly: true };
  return tif === 'GTD' && expireAt ? { timeInForce: 'GTD', postOnly: false, expireAt } : { timeInForce: tif, postOnly: false };
}

/** A local "date and time" field value ("2026-10-21T18:00") as the UTC instant it names; null when it is not a date. */
export function expiryOf(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Is the picked expiry usable now: a real date, strictly after `nowMs`? */
export const expiryIsFuture = (local: string, nowMs: number): boolean => {
  const at = expiryOf(local);
  return at !== null && Date.parse(at) > nowMs;
};

export type TifLabelKey =
  'Tif GTC' | 'Tif GTD' | 'Tif bracket resting' | 'Tif PO' | 'Tif IOC' | 'Tif FOK' | 'Tif market standard' | 'Tif market FOK';
export type TifHelpKey = `${TifLabelKey} help`;

/** Copy key for the name of a pick. A market order's "standard" is the engine's immediate rule, not "good till cancelled". */
export function tifLabelKey(type: OrderType, tif: Tif): TifLabelKey {
  // A resting bracket or OTO buy is cancelled for the trader before their login runs out, so it is not "till cancelled".
  if ((type === 'bracket' || type === 'oto') && tif === 'GTC') return 'Tif bracket resting';
  if (type === 'market') return tif === 'FOK' ? 'Tif market FOK' : 'Tif market standard';
  return tif === 'GTD' ? 'Tif GTD' : tif === 'PO' ? 'Tif PO' : tif === 'IOC' ? 'Tif IOC' : tif === 'FOK' ? 'Tif FOK' : 'Tif GTC';
}

/** The pick a draft was built from (the inverse of `tifFields`). */
export const tifOfDraft = (draft: Pick<Draft, 'timeInForce' | 'postOnly'>): Tif =>
  draft.postOnly || draft.timeInForce === 'PO' ? 'PO' : draft.timeInForce;

/**
 * Order kinds the service refuses on spot today, from the shared list (`SPOT_REFUSED_ORDER_TYPES`). They are listed,
 * disabled, with one shared reason.
 */
const REFUSED_KEY = { trailing_stop: 'trailingStop' } as const;
export const UNSUPPORTED_TYPES = SPOT_REFUSED_ORDER_TYPES.map((id) => REFUSED_KEY[id]);
export type UnsupportedType = (typeof REFUSED_KEY)[keyof typeof REFUSED_KEY];

/** The ticket's name for each type tab, in the shared list's order (`SPOT_TICKET_ORDER_TYPES`): desk copy keys. */
export const TYPE_TAB_KEY = {
  limit: 'Limit',
  stop_limit: 'Order type stopLimit',
  stop_market: 'Order type stopMarket',
  oco: 'Order type oco',
  bracket: 'Order type bracket',
  oto: 'Order type oto',
  market: 'Market',
} as const satisfies Record<OrderType, string>;

/** The ticket's name for each kind it lists as unavailable (desk copy keys), by the ticket's own id. */
export const REFUSED_TAB_KEY = { trailingStop: 'Order type trailingStop' } as const satisfies Record<UnsupportedType, string>;

/** The same names by the shared list's id, so the portal names a refused kind exactly as the ticket does. */
export const REFUSED_NAME_KEY = Object.fromEntries(SPOT_REFUSED_ORDER_TYPES.map((id) => [id, REFUSED_TAB_KEY[REFUSED_KEY[id]]])) as Record<
  (typeof SPOT_REFUSED_ORDER_TYPES)[number],
  (typeof REFUSED_TAB_KEY)[UnsupportedType]
>;

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
