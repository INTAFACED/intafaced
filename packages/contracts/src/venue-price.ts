/**
 * A price we compute (a market order's worst price, a close's, a protection's) put on the venue's price rule, so the
 * venue never refuses an order for a price nobody typed. One rounding, used by the customer app and svc-trade.
 *
 * Hyperliquid's rule (`packages/venue-hyperliquid/src/wire.ts`, which refuses a price that breaks it): any whole
 * number, or at most 5 significant figures and no finer than the market's tick (`10^-(6 - szDecimals)` on perps,
 * `10^-(8 - szDecimals)` on spot, the tick svc-trade publishes). A price a person typed is never rounded here: one
 * that breaks the rule is refused with the venue's words.
 *
 * `toward` is the way the price moves: `down` for a buy's cap and `up` for a sell's floor, toward the market, so the
 * rounded price is never past the protection the review showed. Decimal strings in and out; never a float.
 */
export const VENUE_PRICE_SIG_FIGS = 5;

const DECIMAL = /^\d+(\.\d+)?$/;

function parse(value: string, field: string): { digits: bigint; places: number } {
  if (!DECIMAL.test(value)) throw new RangeError(`${field} must be a decimal string, got ${JSON.stringify(value)}`);
  const [whole = '0', fraction = ''] = value.split('.');
  return { digits: BigInt(whole + fraction), places: fraction.length };
}

function format(digits: bigint, places: number): string {
  const s = digits.toString().padStart(places + 1, '0');
  const whole = s.slice(0, s.length - places);
  const fraction = s.slice(s.length - places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The decimal places a tick allows: `0.1` → 1, `1` → 0. A tick that is not a power of ten at most 1 is refused. */
function tickPlaces(tick: string): number {
  const { digits, places } = parse(tick, 'tick');
  const tickDp = places - (digits.toString().length - 1);
  if (digits <= 0n || !/^10*$/.test(digits.toString()) || tickDp < 0)
    throw new RangeError(`tick must be a power of ten no larger than 1, got ${tick}`);
  return tickDp;
}

/** `price` on the venue's price rule, moved `toward` the market. */
export function onVenuePriceRule(price: string, tick: string, toward: 'up' | 'down'): string {
  const { digits, places } = parse(price, 'price');
  const maxPlaces = tickPlaces(tick);
  if (digits === 0n) return '0';
  // Places 5 significant figures allow at this magnitude: the integer digits use some; below 1, leading zeros don't.
  const all = digits.toString();
  const intDigits = all.length - places;
  // A whole number is always allowed: from 5 integer digits up, the price keeps its integer and drops its fraction.
  const keep = Math.min(maxPlaces, intDigits > 0 ? Math.max(0, VENUE_PRICE_SIG_FIGS - intDigits) : VENUE_PRICE_SIG_FIGS - intDigits);
  if (places <= keep) return format(digits, places);
  const step = 10n ** BigInt(places - keep);
  const floor = digits / step;
  const rounded = toward === 'up' && floor * step !== digits ? floor + 1n : floor;
  return format(rounded, keep);
}

function compareDecimal(a: string, b: string): number {
  const x = parse(a, 'price');
  const y = parse(b, 'price');
  const places = Math.max(x.places, y.places);
  const l = x.digits * 10n ** BigInt(places - x.places);
  const r = y.digits * 10n ** BigInt(places - y.places);
  return l === r ? 0 : l > r ? 1 : -1;
}

/**
 * A worst price `moved` away from `reference` (the best price, the mark or the mid it was computed from), on the
 * venue's price rule: rounded toward the market, a buy's down and a sell's up, so it never goes past the protection.
 * When that would land on the reference or cross it (a cap finer than one price step there), it takes the nearest
 * price beyond the reference instead, so the order still has room to fill and the review names a real limit.
 */
export function venueBound(side: 'buy' | 'sell', { moved, reference, tick }: { moved: string; reference: string; tick: string }): string {
  const toward = onVenuePriceRule(moved, tick, side === 'buy' ? 'down' : 'up');
  const past = (p: string) => compareDecimal(p, reference) * (side === 'buy' ? 1 : -1) > 0;
  return past(moved) && !past(toward) ? onVenuePriceRule(moved, tick, side === 'buy' ? 'up' : 'down') : toward;
}
