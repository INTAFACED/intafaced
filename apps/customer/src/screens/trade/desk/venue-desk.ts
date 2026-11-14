import { formatAmount, parseAmount } from '../../../shared/money';
import {
  canonicalDecimal,
  draftId,
  keys,
  onStep,
  type OrderIntent,
  type VenueBestPrices,
  type VenueMarket,
  type VenueSelfTradeMode,
  type VenueTimeInForce,
} from '../../../features/trade/venue-api';
import { transferCalldata } from '../../../features/protocol/wallet/transfer';
import { toTokenUnits } from '../../../features/protocol/venue-wallet/venue-account-api';

// The venue spot desk's own rules (J-cex-spot-01 #4, #6–#10, #12), apart from the screen so each is tested on its own.
// Every figure is a decimal string or a scaled bigint, never a number.

export type VenueSide = 'buy' | 'sell';
export type VenueOrderType = 'limit' | 'market';

/** A wallet address as the desk names it: its first six and last four characters ("0x1234…abcd"). */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A market order's worst price from the venue's best prices and the owner's protection `bps` (never a default): a buy
 * pays at most the best ask plus `bps`, up to the tick; a sell at least the best bid less `bps`, down. Null with no price.
 */
export function slippageLimit(side: VenueSide, best: VenueBestPrices | null, bps: string, tick: string): string | null {
  const reference = side === 'buy' ? best?.ask : best?.bid;
  if (!reference) return null;
  const price = parseAmount(reference);
  const step = parseAmount(tick);
  const ratio = parseAmount(bps);
  const one = parseAmount('10000');
  if (price <= 0n || step <= 0n || ratio < 0n) return null;
  // Scaled bigint times a scaled ratio: divide by the scale of `one` to stay in the same units.
  const moved = side === 'buy' ? (price * (one + ratio)) / one : (price * (one - ratio)) / one;
  const ticks = side === 'buy' ? (moved + step - 1n) / step : moved / step;
  const limit = ticks * step;
  return limit > 0n ? formatAmount(limit) : null;
}

/** What the ticket holds for one side. `tif` is a limit's time in force (good till cancelled when absent). */
export interface TicketFields {
  side: VenueSide;
  type: VenueOrderType;
  price: string;
  amount: string;
  tif?: VenueTimeInForce;
}

/**
 * Every time in force the desk names (J-cex-spot-03 #4 to #7), in the order it lists them. The ones the venue offers on
 * the market (`VenueMarket.timeInForce`) can be picked; the rest are listed disabled with "not offered by this venue".
 */
export const TIME_IN_FORCE_NAMES = ['GTC', 'IOC', 'FOK', 'ALO', 'GTD'] as const;
export type TimeInForceName = (typeof TIME_IN_FORCE_NAMES)[number];

/** The venue's own offer of `name` on `market`: the time in force it takes, or null when it offers none by that name. */
export function offeredTif(market: Pick<VenueMarket, 'timeInForce'>, name: TimeInForceName): VenueTimeInForce | null {
  return (market.timeInForce as readonly string[]).includes(name) ? (name as VenueTimeInForce) : null;
}

/** Order types the desk names beside limit and market; a type the venue does not list is shown disabled. */
export const OTHER_ORDER_TYPES = ['stop_limit', 'stop', 'take_profit', 'trailing_stop'] as const;

/** Every self-trade mode the desk names (J-cex-spot-03 #8); only the venue's own published rule can be picked. */
export const SELF_TRADE_MODES: readonly VenueSelfTradeMode[] = ['cancel_resting', 'cancel_new', 'cancel_both'];

/** The venue's own self-trade rule on `market`, or null where it publishes none. */
export function venueSelfTrade(market: Pick<VenueMarket, 'selfTrade'>): VenueSelfTradeMode | null {
  return market.selfTrade?.known ? market.selfTrade.value : null;
}

/**
 * The amount a typed value buys or sells at `price` (a limit's price, or a market order's worst price): rounded down to
 * the market's lot, so what the venue locks for a buy (amount × price) never passes the value. Null when it sizes nothing.
 */
export function amountForValue(value: string, price: string | null, lot: string): string | null {
  if (!price || !isDecimal(value) || !isDecimal(price) || !isDecimal(lot)) return null;
  const v = parseAmount(value.trim());
  const p = parseAmount(price.trim());
  const step = parseAmount(lot.trim());
  if (v <= 0n || p <= 0n || step <= 0n) return null;
  const one = parseAmount('1');
  // value / price in scaled units, then down to a whole number of lots.
  const raw = (v * one) / p;
  const lots = raw / step;
  return lots > 0n ? formatAmount(lots * step) : null;
}

/** The value an amount comes to at `price`, for the field the person did not type. */
export function valueOf(amount: string, price: string | null): string | null {
  if (!price || !isDecimal(amount) || !isDecimal(price)) return null;
  const a = parseAmount(amount.trim());
  const p = parseAmount(price.trim());
  if (a <= 0n || p <= 0n) return null;
  return formatAmount((a * p) / parseAmount('1'));
}

/** A client tag: 1 to 32 letters, digits, spaces, dots, dashes or underscores. Blank is no tag. */
export const TAG_PATTERN = /^[A-Za-z0-9 ._-]{1,32}$/;
export function tagProblem(tag: string): boolean {
  return tag.trim() !== '' && !TAG_PATTERN.test(tag.trim());
}

/** Why the ticket is not an order yet, or null when it is one the venue can be asked about. */
export type TicketProblem = 'amount' | 'price' | 'amount_step' | 'price_step' | 'no_book' | 'no_cap';

/** `capSet` false: the owner's protection is blank, so a market order is refused (`trade.slippage_cap_unset`). */
export function ticketProblem(fields: TicketFields, market: VenueMarket, worst: string | null, capSet = true): TicketProblem | null {
  if (!fields.amount.trim() || !isDecimal(fields.amount)) return 'amount';
  if (!onStep(fields.amount, market.lotSize)) return 'amount_step';
  if (fields.type === 'market') return !capSet ? 'no_cap' : worst === null ? 'no_book' : null;
  if (!fields.price.trim() || !isDecimal(fields.price)) return 'price';
  if (!onStep(fields.price, market.tickSize)) return 'price_step';
  return null;
}

function isDecimal(value: string): boolean {
  try {
    parseAmount(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** The ticket as the venue's intent: a limit at its price with its time in force (GTC when none), a market IOC at its worst price (none if `capSet` is false). */
export function intentOf(
  fields: TicketFields,
  market: VenueMarket,
  worst: string | null,
  clientOrderKey: string,
  capSet: boolean,
): OrderIntent | null {
  if (ticketProblem(fields, market, worst, capSet) !== null) return null;
  const limit = fields.type === 'limit';
  return {
    kind: 'place_order',
    symbol: market.symbol,
    side: fields.side,
    type: fields.type,
    amount: canonicalDecimal(fields.amount),
    price: canonicalDecimal(limit ? fields.price : worst!),
    timeInForce: limit ? (fields.tif ?? 'GTC') : 'IOC',
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  };
}

/** The part of a ticket that names one order: the same order reviewed again keeps its client id. */
export function draftSignature(fields: TicketFields): string {
  const tidy = (v: string) => (isDecimal(v) ? canonicalDecimal(v) : v.trim());
  const limit = fields.type === 'limit';
  return [fields.side, fields.type, limit ? tidy(fields.price) : '', tidy(fields.amount), limit ? (fields.tif ?? 'GTC') : ''].join('|');
}

/** The order key (and a market order's worst price) held until the order changes or gets a definite answer. */
export class HeldDraft {
  private held: { signature: string; key: string; worst: string | null } | null = null;
  private counter = 0;

  constructor(
    private readonly owner: string,
    private readonly symbol: string,
    private readonly now: () => number = Date.now,
  ) {}

  keyFor(fields: TicketFields): string {
    return this.hold(fields, null).key;
  }

  /** The key for this order and the worst price held with it (a limit's is unused). */
  hold(fields: TicketFields, worst: string | null): { key: string; worst: string | null } {
    const signature = draftSignature(fields);
    if (this.held?.signature !== signature) {
      this.held = { signature, key: keys.order(this.owner, this.symbol, draftId(this.now(), this.counter++)), worst };
    } else if (this.held.worst === null && worst !== null) {
      // Nothing was built under the key without a worst price (no intent with no book), so the first one is held.
      this.held = { ...this.held, worst };
    }
    return { key: this.held.key, worst: this.held.worst };
  }

  /** The venue answered this order definitely, or the door refused it before preparing anything: the next order is a new one. */
  settle(key: string) {
    if (this.held?.key === key) this.held = null;
  }
}

/** The door refused the held worst price as past the protection before preparing anything: the next try mints a new key. */
export function refusedAtHeldWorst(result: { kind: string; code?: string | undefined }): boolean {
  return result.kind === 'refused' && result.code === 'trade.venue.price_outside_protection';
}

/** The deposit route `/venue/status` names (B2's chain-transfer watcher). */
export interface DepositRoute {
  chainId: number;
  token: string;
  tokenDecimals: number;
  address: string;
  asset: string;
}

/** The person's ERC-20 `transfer` to the venue's deposit address; null unless the amount is positive within the token's decimals. */
export function depositTransfer(route: DepositRoute, amount: string): { to: string; data: string; units: bigint } | null {
  const units = toTokenUnits(amount, route.tokenDecimals);
  if (units === null) return null;
  return { to: route.token, data: transferCalldata(route.address, units), units };
}

/** What the withdraw dialog does when its button is pressed: ask for the step-up first, and the wallet only after it. */
export type WithdrawStep = { step: 'refuse'; why: 'amount' } | { step: 'step_up' } | { step: 'sign'; stepUpApprovalId: string | null };

export function withdrawStep(amount: string, approval: { id: string | null } | null): WithdrawStep {
  if (toTokenUnits(amount, 18) === null) return { step: 'refuse', why: 'amount' };
  if (approval === null) return { step: 'step_up' };
  return { step: 'sign', stepUpApprovalId: approval.id };
}
