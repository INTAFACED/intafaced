/**
 * Price-line overlays: a labelled line at one exact price, kept on this device for one market. A price is a decimal string
 * and is checked in whole units of the tick size (bigint, never a float): a blank, non-positive or off-tick price is refused
 * with its reason, and nothing is drawn at a guessed level.
 */

export interface PriceLine {
  id: string;
  /** The price as typed and checked: a decimal string on the tick grid. */
  price: string;
  label: string;
}

export type PriceLineCheck = { ok: true; price: string } | { ok: false; reason: 'blank' | 'not-positive' | 'off-tick' | 'tick-unset' };

const DECIMAL = /^\d+(\.\d+)?$/;
export const PRICE_LABEL_LIMIT = 32;

/** Pads two decimal strings to the same number of places and returns them as whole units. */
function units(a: string, b: string): [bigint, bigint] {
  const places = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const whole = (v: string) => {
    const [int, frac = ''] = v.split('.');
    return BigInt(`${int}${frac.padEnd(places, '0')}`);
  };
  return [whole(a), whole(b)];
}

/** Checks a typed price against the market's tick size. Only the plain decimal form is accepted (no sign, no exponent). */
export function checkPriceLine(input: string, tickSize: string): PriceLineCheck {
  const price = input.trim();
  if (price === '') return { ok: false, reason: 'blank' };
  // A market with no tick size (the owner has not set one, or the read did not give one) cannot be checked: nothing is drawn.
  if (!DECIMAL.test(tickSize) || BigInt(tickSize.replace('.', '')) === 0n) return { ok: false, reason: 'tick-unset' };
  if (!DECIMAL.test(price)) return { ok: false, reason: 'not-positive' };
  const [value, tick] = units(price, tickSize);
  if (value <= 0n) return { ok: false, reason: 'not-positive' };
  if (tick <= 0n || value % tick !== 0n) return { ok: false, reason: 'off-tick' };
  return { ok: true, price };
}

/** One device setting for every market's lines, so a chart that changes market reads the right ones without a reload. */
export const priceLinesKey = (userId: string | null): string => `charts-price-lines:${userId ?? 'guest'}`;

/** The stored lines, per market symbol. Stored lines are kept only when each still has a decimal price and a label. */
export type PriceLineStore = Readonly<Record<string, readonly PriceLine[]>>;

export const isPriceLineStore = (value: unknown): value is PriceLineStore =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function linesFor(store: unknown, symbol: string): PriceLine[] {
  const rows = isPriceLineStore(store) ? store[symbol] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is PriceLine =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as PriceLine).id === 'string' &&
      typeof (row as PriceLine).price === 'string' &&
      DECIMAL.test((row as PriceLine).price) &&
      typeof (row as PriceLine).label === 'string',
  );
}
