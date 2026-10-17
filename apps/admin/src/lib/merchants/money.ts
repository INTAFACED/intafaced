/**
 * Money display for the Merchants panel.
 *
 * Amounts are unsigned decimal strings on the wire (at most 18 places). They are
 * never turned into a JS `number` here. Comparison and addition use scaled
 * `bigint`; display is string manipulation. Two assets are never summed.
 */

const DECIMAL = /^\d+(\.\d{1,18})?$/;
const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

export interface AssetAmount {
  readonly assetCode: string;
  readonly amount: string;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value);
}

/** Exact scaled value, 18 places. Throws on anything that is not a wire decimal. */
export function toScaled(value: string): bigint {
  if (!DECIMAL.test(value)) throw new RangeError('not a decimal amount string');
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * ONE + BigInt(frac.padEnd(SCALE, '0'));
}

function fromScaled(scaled: bigint): string {
  const whole = scaled / ONE;
  const frac = (scaled % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function isZeroDecimal(value: string): boolean {
  return toScaled(value) === 0n;
}

/**
 * Whole-number permille (0 to 1000) of `value` against `max`, for bar heights only.
 * The division happens in bigint; the result is a layout ratio, not money.
 */
export function permille(value: string, max: string): number {
  const top = toScaled(max);
  if (top === 0n) return 0;
  const part = (toScaled(value) * 1000n) / top;
  return Number(part > 1000n ? 1000n : part);
}

const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * "1,234.50": thousands separators, at least two places, no places dropped.
 * Display only; the input string is untouched.
 */
export function formatAmount(value: string): string {
  if (!DECIMAL.test(value)) return '—';
  const [whole = '0', frac = ''] = value.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return `${group(whole)}.${trimmed.padEnd(2, '0')}`;
}

export function formatMoney(amount: string, assetCode: string): string {
  return `${formatAmount(amount)} ${assetCode}`;
}

/** Sum a list per asset. Two different assets stay two rows. Rows with a malformed amount are skipped and counted. */
export function sumByAsset(rows: readonly AssetAmount[]): { totals: AssetAmount[]; skipped: number } {
  const map = new Map<string, bigint>();
  let skipped = 0;
  for (const row of rows) {
    if (!isDecimalString(row.amount)) {
      skipped += 1;
      continue;
    }
    map.set(row.assetCode, (map.get(row.assetCode) ?? 0n) + toScaled(row.amount));
  }
  const totals = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assetCode, scaled]) => ({ assetCode, amount: fromScaled(scaled) }));
  return { totals, skipped };
}

/** Amount of one asset in a per-asset list, or null when the asset is absent (absent is not zero). */
export function amountFor(rows: readonly AssetAmount[], assetCode: string): string | null {
  return rows.find((row) => row.assetCode === assetCode)?.amount ?? null;
}

/** "1,200.00 USDT · 3.00 USD" for a per-asset list; an empty list reads as "none". */
export function describeAmounts(rows: readonly AssetAmount[]): string {
  return rows.length === 0 ? 'none' : rows.map((row) => formatMoney(row.amount, row.assetCode)).join(' · ');
}
