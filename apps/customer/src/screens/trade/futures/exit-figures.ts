import { netIfClosedAt, openingFeesOf } from '@intafaced/venue-contracts';
import { add, compare, dec, str, ZERO, type Scaled } from '../../../data/decimal';
import type { VenueFill, VenueMarket, VenueOrder, VenuePosition, VenueUp } from '../../../features/trade/venue-api';

// J-derivatives-32: a position's stop and target in dollars after fees and in R, from the venue's own figures: its
// entry and size, the fees its opening fills paid (the venue's fill records), and the close's rate (the venue's taker
// fee on the market plus our published builder fee). The same formula svc-trade's breakeven stop solves for zero
// (`@intafaced/venue-contracts` position-net.ts). A figure that rests on one the venue or the owner has not given is
// null, never a guess.

/** What a position's close pays on its notional, in bps: the venue's taker rate and our builder fee; null when either is blank. */
export function closeFeeBpsOf(market: Pick<VenueMarket, 'takerFeeBps'> | undefined, status: Pick<VenueUp, 'builder'>): Scaled | null {
  if (!market?.takerFeeBps.known || !status.builder) return null;
  const taker = dec(market.takerFeeBps.value);
  const ours = dec(status.builder.feeBps);
  return taker === null || ours === null ? null : add(taker, ours);
}

/** The fees the position's opening fills paid, from the venue's fills on its market; null when they don't add up to it. */
export function openingFees(position: VenuePosition, fills: readonly VenueFill[]): Scaled | null {
  const size = dec(position.size);
  if (size === null) return null;
  const mine = fills
    .filter((f) => f.symbol === position.symbol)
    .map((f) => ({
      side: f.side,
      amount: dec(f.amount) ?? ZERO,
      venueFee: dec(f.venueFee) ?? ZERO,
      builderFee: dec(f.builderFee) ?? ZERO,
      filledAt: new Date(f.filledAt),
    }));
  return openingFeesOf({ side: position.side, size }, mine);
}

/** The inputs a position's after-fee figures need, or null with the one that is missing. */
export type FeeBasis =
  | { readonly ok: true; readonly openingFees: Scaled; readonly closeFeeBps: Scaled }
  | { readonly ok: false; readonly missing: 'fees' | 'history' };

export function feeBasis(
  position: VenuePosition,
  fills: readonly VenueFill[],
  market: Pick<VenueMarket, 'takerFeeBps'> | undefined,
  status: Pick<VenueUp, 'builder'>,
): FeeBasis {
  const closeFeeBps = closeFeeBpsOf(market, status);
  if (closeFeeBps === null) return { ok: false, missing: 'fees' };
  const paid = openingFees(position, fills);
  if (paid === null) return { ok: false, missing: 'history' };
  return { ok: true, openingFees: paid, closeFeeBps };
}

/** What closing the whole position at `price` nets after every fee, as a decimal string; null without the basis. */
export function netAt(position: VenuePosition, price: string, basis: FeeBasis): string | null {
  if (!basis.ok) return null;
  const size = dec(position.size);
  const entryPrice = dec(position.entryPrice);
  const at = dec(price);
  if (size === null || entryPrice === null || at === null) return null;
  return str(
    netIfClosedAt({ side: position.side, size, entryPrice, openingFees: basis.openingFees, closeFeeBps: basis.closeFeeBps, price: at }),
  );
}

/**
 * The R a price makes: its after-fee result over what the position stood to lose at the stop it opened with, to two
 * places, rounded toward zero. Null when either is unknown, or when that stop risked nothing (a stop already at or past
 * breakeven when the position opened has no R to measure against).
 */
export function rAt(net: string | null, riskNet: string | null): string | null {
  const n = dec(net);
  const r = dec(riskNet);
  if (n === null || r === null || r >= ZERO) return null;
  const hundredths = (n * 100n) / -r; // whole hundredths of R; a bigint division rounds toward zero
  const sign = hundredths < 0n ? '-' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** A waiting reduce-only trigger order that closes this position, of `role`. */
export function exitOf(position: VenuePosition, orders: readonly VenueOrder[], role: 'stop_loss' | 'take_profit'): VenueOrder | null {
  const against = position.side === 'long' ? 'sell' : 'buy';
  return (
    orders.find(
      (o) =>
        o.symbol === position.symbol &&
        o.side === against &&
        o.reduceOnly &&
        o.trigger?.state === 'waiting' &&
        o.trigger.role === role &&
        !!o.venueClientOrderId,
    ) ?? null
  );
}

/** The device's memory of the stop each position opened with, so R keeps its unit after the stop moves. */
const OPENING_STOPS = 'intafaced.desk.opening-stops.v1';
const keyOf = (owner: string, p: VenuePosition) => `${owner.toLowerCase()}:${p.symbol}:${p.side}:${p.entryPrice}:${p.size}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
function readAll(store: Store | null): Record<string, string> {
  try {
    const raw = store?.getItem(OPENING_STOPS);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The stop this position opened with: the first stop this device read on it (by owner, market, side, entry and size, so
 * a new or grown position starts again), else the stop resting now, kept from here on. Null while no stop was ever read.
 */
export function openingStop(owner: string, position: VenuePosition, restingStop: string | null, store: Store | null): string | null {
  const all = readAll(store);
  const key = keyOf(owner, position);
  const kept = all[key];
  if (typeof kept === 'string' && dec(kept) !== null) return kept;
  if (restingStop === null) return null;
  try {
    store?.setItem(OPENING_STOPS, JSON.stringify({ ...all, [key]: restingStop }));
  } catch {
    // A device that keeps nothing still shows R against the stop resting now.
  }
  return restingStop;
}

/** True when `a` is the same price as `b` (decimal strings, any trailing zeros). */
export const samePrice = (a: string | null | undefined, b: string | null | undefined) => {
  const x = dec(a ?? null);
  const y = dec(b ?? null);
  return x !== null && y !== null && compare(x, y) === 0;
};
