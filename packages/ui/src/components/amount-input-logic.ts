/**
 * Pure logic for AmountInput (COMPONENT-PLAN 3.5). Money here is ALWAYS a
 * decimal string with "." as the separator; arithmetic is bigint. There is no
 * parseFloat, Number() or toFixed() on an amount anywhere in this file.
 */

export type DecimalSeparator = '.' | ',';

const DIGITS = /^\d+$/;

/** Number of digits after the dot in a canonical decimal string. */
export function decimalsOf(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

/** Strips leading zeros of an integer part ("007" -> "7", "" -> "0"). */
function normaliseInt(int: string): string {
  const trimmed = int.replace(/^0+(?=\d)/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** "12.5" at scale 3 -> 12500n. Extra digits beyond `scale` are cut off (toward zero). */
export function toScaled(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const [int = '0', frac = ''] = body.split('.');
  const digits = `${int === '' ? '0' : int}${frac.slice(0, scale).padEnd(scale, '0')}`;
  const n = BigInt(digits);
  return negative ? -n : n;
}

/** 12500n at scale 3 -> "12.500" (always exactly `scale` decimals). */
export function fromScaled(n: bigint, scale: number): string {
  const negative = n < 0n;
  const abs = (negative ? -n : n).toString().padStart(scale + 1, '0');
  const int = abs.slice(0, abs.length - scale);
  const frac = abs.slice(abs.length - scale);
  return `${negative ? '-' : ''}${int}${scale > 0 ? `.${frac}` : ''}`;
}

/**
 * Cuts a decimal string to `precision` decimals.
 * `down` truncates toward zero (safe for anything that must not exceed a balance);
 * `half-up` rounds halves away from zero (display rounding, matches format.ts).
 */
export function roundDecimal(value: string, precision: number, mode: 'down' | 'half-up' = 'down'): string {
  const have = decimalsOf(value);
  if (have <= precision) return value;
  const n = toScaled(value, have);
  const divisor = 10n ** BigInt(have - precision);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = mode === 'down' ? abs / divisor : (abs + divisor / 2n) / divisor;
  return fromScaled(negative ? -q : q, precision);
}

export interface TypedOptions {
  /** Max decimals the asset or market allows. */
  precision: number;
  /** What the person's keyboard types as the decimal mark. */
  decimalSeparator?: DecimalSeparator;
}

/**
 * Reads what is in the input box after a keystroke and returns the canonical
 * value, or null to reject the keystroke (a second decimal mark, or more
 * decimals than `precision`, or both "." and ","). The other decimal mark counts as the
 * decimal point when the person's own is absent. Letters and symbols are dropped.
 * An in-progress "12." is kept so the person can keep typing.
 */
export function parseTyped(raw: string, { precision, decimalSeparator = '.' }: TypedOptions): string | null {
  const sep = decimalSeparator;
  const other = sep === '.' ? ',' : '.';
  // The other decimal mark is a decimal point if the person's own mark is not in the box yet
  // ("0,5" typed on a "." keyboard is 0.5, never 5); if both marks are there, refuse the keystroke.
  if (raw.includes(sep) && raw.includes(other)) return null;
  let out = '';
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === sep || ch === other) out += '.';
  }
  const dots = out.split('.').length - 1;
  if (dots > 1) return null;
  if (dots === 1 && precision === 0) return null;
  if (out.startsWith('.')) out = `0${out}`;
  const [int = '', frac] = out.split('.');
  if (frac !== undefined && frac.length > precision) return null;
  if (int === '' && frac === undefined) return '';
  const normalised = normaliseInt(int);
  return frac === undefined ? normalised : `${normalised}.${frac}`;
}

const count = (text: string, ch: string) => text.split(ch).length - 1;

/**
 * Reads pasted text and returns the canonical value, or null if it cannot be
 * read as an amount. Handles group separators ("1,234.56", "1.234,56",
 * "1 234,56", "1'234.56"), currency symbols and units ("$1,234.56", "0.5 BTC").
 * A minus sign is dropped: amounts are never negative.
 *
 * The one ambiguous case, a single "," or "." with exactly three digits after
 * it ("1,234"), is read as a group mark when it is NOT the person's own decimal
 * mark and the whole part looks like a group head (1 to 3 digits, no leading
 * zero). Anything else is read as a decimal mark, so "0,5" is 0.5 and never 5.
 *
 * Decimals beyond `precision` are cut off (toward zero), never rounded up.
 */
export function parsePasted(text: string, { precision, decimalSeparator = '.' }: TypedOptions): string | null {
  // Only leading and trailing text ("$", "BTC", "USDT ") is stripped. A letter or symbol left between
  // digits ("1e5", "1.5e-3", "1.5 BTC (2 orders)") is not an amount we can read: reject, never guess.
  const compact = text.replace(/[\s   '’]/g, '');
  const core = compact.replace(/^[^0-9.,]+/, '').replace(/[^0-9.,]+$/, '');
  if (/[^0-9.,]/.test(core)) return null;
  const t = core;
  if (!/\d/.test(t)) return null;

  const dots = count(t, '.');
  const commas = count(t, ',');
  let int: string;
  let frac = '';

  if (dots > 0 && commas > 0) {
    const decimalMark = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    const groupMark = decimalMark === '.' ? ',' : '.';
    if (count(t, decimalMark) !== 1) return null;
    const [ip = '', fp = ''] = t.split(decimalMark);
    const grouped = new RegExp(`^\\d{1,3}(?:\\${groupMark}\\d{3})+$`);
    if (!(grouped.test(ip) || DIGITS.test(ip) || ip === '')) return null;
    if (fp !== '' && !DIGITS.test(fp)) return null;
    int = ip.split(groupMark).join('');
    frac = fp;
  } else if (dots > 0 || commas > 0) {
    const mark = dots > 0 ? '.' : ',';
    const parts = t.split(mark);
    if (parts.length > 2) {
      const [head = '', ...rest] = parts;
      if (!/^\d{1,3}$/.test(head) || !rest.every((p) => /^\d{3}$/.test(p))) return null;
      int = parts.join('');
    } else {
      const [ip = '', fp = ''] = parts;
      const looksLikeGroup = /^[1-9]\d{0,2}$/.test(ip) && /^\d{3}$/.test(fp);
      if (mark === decimalSeparator || !looksLikeGroup) {
        int = ip;
        frac = fp;
      } else {
        int = `${ip}${fp}`;
      }
    }
  } else {
    int = t;
  }

  const cut = precision === 0 ? '' : frac.slice(0, precision);
  const whole = normaliseInt(int);
  return cut === '' ? whole : `${whole}.${cut}`;
}

export interface StepOptions {
  precision: number;
  /** Smallest allowed value. Default "0": amounts are never negative. */
  min?: string;
  /** Largest allowed value, e.g. the available balance. */
  max?: string;
  /** Arrow key moves one tick; Shift or Page keys move `multiplier` ticks. */
  multiplier?: number;
}

/**
 * Moves `value` one tick up (+1) or down (-1) in bigint arithmetic and returns a
 * canonical string. An empty value counts as 0. The result keeps the number of
 * decimals of the tick or of the value, whichever is larger (so "5.5" stepped
 * by "0.01" is "5.51"), never more than `precision`, and stays within min/max.
 */
export function stepDecimal(value: string, tick: string, direction: 1 | -1, opts: StepOptions): string {
  const { precision, min = '0', max, multiplier = 1 } = opts;
  const current = value === '' || value === '.' ? '0' : value.replace(/\.$/, '');
  const scale = Math.max(decimalsOf(current), decimalsOf(tick), decimalsOf(min), max ? decimalsOf(max) : 0);
  const before = toScaled(current, scale);
  let n = before + BigInt(direction) * BigInt(multiplier) * toScaled(tick, scale);
  const lo = toScaled(min, scale);
  if (n < lo) n = lo;
  if (max !== undefined) {
    const hi = toScaled(max, scale);
    if (n > hi) n = hi;
  }
  // Pinned against a bound: nothing changed, so hand back the same text.
  if (n === before && value !== '') return value;
  const raw = fromScaled(n, scale);
  const cut = roundDecimal(raw, precision, 'down');
  // Keep the same visible decimals as the tick or the value, without growing beyond precision.
  const decimals = Math.min(precision, Math.max(decimalsOf(current), decimalsOf(tick)));
  const have = decimalsOf(cut);
  if (have >= decimals) return cut;
  return fromScaled(toScaled(cut, decimals), decimals);
}

/** Canonical "12.5" shown with the person's decimal mark ("12,5"). */
export function toDisplay(value: string, decimalSeparator: DecimalSeparator = '.'): string {
  return decimalSeparator === '.' ? value : value.replace('.', decimalSeparator);
}

/** True for a finished, positive-or-zero amount such as "12" or "0.05" (not "12." or ""). */
export function isCompleteAmount(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

/** True when the amount is greater than zero. Compares digits, never floats. */
export function isPositiveAmount(value: string): boolean {
  return isCompleteAmount(value) && /[1-9]/.test(value);
}
