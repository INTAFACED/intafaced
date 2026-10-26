/**
 * Locale-aware formatting.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a money amount arrives as a decimal
 * string and is never parsed to a float. Not here, not anywhere.
 *
 * `packages/ledger-client/src/money.ts` carries 18 decimal places in a scaled
 * bigint because Postgres stores `numeric(38,18)` and the ledger reconciles to
 * the last digit. `Number('1234.123456789012345678')` returns
 * 1234.1234567890124 — four digits gone, silently, at the last step before a
 * user reads their balance. So the formatting path here works on the digit
 * string directly:
 *
 *   1. split the decimal string into sign / integer digits / fraction digits;
 *   2. round the fraction with string + BigInt arithmetic when the display
 *      precision is shorter than the value;
 *   3. format the INTEGER part with `Intl.NumberFormat` on a BigInt, using
 *      `formatToParts` so we get the locale's grouping, currency placement and
 *      sign position without inventing any of it;
 *   4. splice the fraction digits back in, transliterated into the locale's
 *      numbering system and separated by the locale's decimal separator — both
 *      obtained from `Intl` itself, never hardcoded.
 *
 * There is no `Number()`, no `parseFloat`, and no arithmetic on the value
 * anywhere in this file.
 *
 * Currency metadata is not reimplemented here — it lives in
 * `@intafaced/config`'s fiat registry (§6.2: "100+ fiat currencies = config,
 * not code") and is re-exported below.
 */
import { fiat } from '@intafaced/config/fiat';
import { DEFAULT_LOCALE, intlTagFor } from './locales.js';

export { fiat, FIAT_CURRENCIES, enabledFiat, isSupportedFiat } from '@intafaced/config/fiat';
export type { FiatCurrency } from '@intafaced/config/fiat';

/**
 * Display precision for an asset with no ISO minor-unit entry (BTC, IFC, …).
 * The ledger still carries 18; this is what a human reads.
 */
export const DEFAULT_ASSET_DECIMALS = 8;

/** Thrown when a caller hands the formatter something that is not a decimal string. */
export class AmountFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountFormatError';
  }
}

// ── Decimal-string primitives (no floats, ever) ─────────────────────────────

interface DecimalParts {
  readonly negative: boolean;
  /** Integer digits, as a digit string. */
  readonly whole: string;
  /** Fraction digits, as a digit string. No leading dot. */
  readonly frac: string;
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d*))?$/;

function splitDecimal(input: string): DecimalParts {
  const trimmed = input.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) {
    throw new AmountFormatError(`Expected a decimal string, got "${input}" — money never crosses this boundary as a number`);
  }
  const [, sign, whole = '0', frac = ''] = match;
  const allZero = /^0*$/.test(whole) && /^0*$/.test(frac);
  return { negative: sign === '-' && !allZero, whole, frac };
}

/**
 * How a value is cut to its display precision.
 *
 * - `'half-up'`: to the nearest, a tie away from zero. The default for prices
 *   and history rows.
 * - `'down'`: toward zero. For an available balance or a withdrawable amount,
 *   so the screen never shows more than the user can move.
 */
export type Rounding = 'half-up' | 'down';

/**
 * Which sign a figure shows. A value whose shown digits are all zero never
 * shows a minus, whatever its input sign was ("-0.001" at 2 places is "0.00").
 *
 * - `'auto'`: a minus on negatives only.
 * - `'exceptZero'`: a plus or a minus on anything but zero. For P&L and change.
 * - `'always'`: as `'exceptZero'`, and a plus on zero too.
 * - `'never'`: no sign. Pair it with an arrow or a word, never colour alone.
 */
export type SignDisplay = 'auto' | 'exceptZero' | 'always' | 'never';

/**
 * Round a decimal string to `digits` fraction digits, with the carry
 * propagated into the integer part as a BigInt. String and BigInt only.
 * Both modes work on the magnitude, so they are symmetric around zero.
 */
function roundDecimal(value: DecimalParts, digits: number, rounding: Rounding = 'half-up'): DecimalParts {
  if (value.frac.length <= digits) return value;

  const keep = value.frac.slice(0, digits);
  if (rounding === 'down') return { ...value, frac: keep };

  const nextDigit = value.frac.charAt(digits);
  const roundUp = nextDigit >= '5';
  if (!roundUp) return { ...value, frac: keep };

  if (digits === 0) {
    return { ...value, whole: (BigInt(value.whole) + 1n).toString(), frac: '' };
  }

  const bumped = BigInt(keep) + 1n;
  const bumpedStr = bumped.toString();
  if (bumpedStr.length > digits) {
    // The fraction carried: 0.99 → 1.0 at one digit.
    return { ...value, whole: (BigInt(value.whole) + 1n).toString(), frac: '0'.repeat(digits) };
  }
  return { ...value, frac: bumpedStr.padStart(digits, '0') };
}

/** Move the decimal point `places` to the right. Used by percent — a shift, not a multiply. */
function shiftRight(value: DecimalParts, places: number): DecimalParts {
  const padded = value.frac.padEnd(places, '0');
  const moved = padded.slice(0, places);
  const rest = padded.slice(places);
  const whole = (value.whole + moved).replace(/^0+(?=\d)/, '');
  return { negative: value.negative, whole, frac: rest };
}

// ── Intl plumbing (cached — the constructors are the expensive part) ─────────

const numberFormatCache = new Map<string, Intl.NumberFormat>();
const dateFormatCache = new Map<string, Intl.DateTimeFormat>();
const relativeFormatCache = new Map<string, Intl.RelativeTimeFormat>();
const digitCache = new Map<string, readonly string[]>();
const separatorCache = new Map<string, string>();

function numberFormat(tag: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${tag}|${JSON.stringify(options)}`;
  let nf = numberFormatCache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(tag, options);
    numberFormatCache.set(key, nf);
  }
  return nf;
}

/** The locale's own glyphs for 0–9, asked of `Intl` rather than assumed. */
function localeDigits(tag: string): readonly string[] {
  let digits = digitCache.get(tag);
  if (!digits) {
    const nf = numberFormat(tag, { useGrouping: false });
    digits = Array.from({ length: 10 }, (_, d) => nf.format(BigInt(d)));
    digitCache.set(tag, digits);
  }
  return digits;
}

function decimalSeparator(tag: string): string {
  let sep = separatorCache.get(tag);
  if (sep === undefined) {
    const parts = numberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).formatToParts(1n);
    sep = parts.find((p) => p.type === 'decimal')?.value ?? '.';
    separatorCache.set(tag, sep);
  }
  return sep;
}

/** ASCII digit string → the locale's numbering system. */
function toLocaleDigits(digits: string, tag: string): string {
  const glyphs = localeDigits(tag);
  if (glyphs[0] === '0') return digits;
  let out = '';
  for (const ch of digits) {
    out += glyphs[ch.charCodeAt(0) - 48] ?? ch;
  }
  return out;
}

// ── Parts ───────────────────────────────────────────────────────────────────

/**
 * One piece of a formatted figure, so a component can style the integer, the
 * fraction and the currency apart (a dimmer fraction, a smaller ticker)
 * without re-parsing a string. Joining every `value` gives the string form.
 *
 * `unit` is an asset ticker outside ISO 4217 (USDC, IFC); `currency` is what
 * `Intl` itself placed. `literal` covers spaces and the invisible direction
 * marks some locales put around a sign (U+200E, U+200F, U+061C): never strip
 * them, and never compare formatted strings to hand-typed ones in RTL tests.
 */
export type FormatPartType =
  'integer' | 'group' | 'decimal' | 'fraction' | 'minusSign' | 'plusSign' | 'currency' | 'unit' | 'percentSign' | 'compact' | 'literal';

export interface FormatPart {
  readonly type: FormatPartType;
  readonly value: string;
}

const PART_TYPES = new Set<string>([
  'integer',
  'group',
  'decimal',
  'fraction',
  'minusSign',
  'plusSign',
  'currency',
  'percentSign',
  'compact',
  'literal',
]);

function toPart(part: Intl.NumberFormatPart): FormatPart {
  return { type: PART_TYPES.has(part.type) ? (part.type as FormatPartType) : 'literal', value: part.value };
}

export function joinParts(parts: readonly FormatPart[]): string {
  let out = '';
  for (const part of parts) out += part.value;
  return out;
}

type ShownSign = 'minus' | 'plus' | 'none';

function shownSign(negative: boolean, isZero: boolean, display: SignDisplay): ShownSign {
  if (display === 'never') return 'none';
  if (isZero) return display === 'always' ? 'plus' : 'none';
  if (negative) return 'minus';
  return display === 'auto' ? 'none' : 'plus';
}

interface ExactRender {
  /** The figure's parts, sign and currency placed by the locale. */
  readonly parts: FormatPart[];
  /** True when every shown digit is zero. */
  readonly isZero: boolean;
}

/**
 * Render a decimal string exactly: the integer part goes through `Intl` as a
 * BigInt (the locale's grouping, sign and currency placement, none of it
 * invented here), and our own fraction digits are spliced in after the last
 * integer part.
 *
 * `options` give the figure's style; this function adds the digits and the sign
 * handling. A zero integer part has no sign in BigInt, so when a sign must
 * show on "0.50" the locale's template is taken from a stand-in 1 and its
 * digit swapped for the locale's zero: "-$0.50" in English, "-0,50 $" in German,
 * and a direction-marked minus in Arabic each come out where that locale puts them.
 *
 * Strings and not `Intl`'s own string input, on purpose: engines before
 * Safari 15.4 (the iOS web view floor is still 14 today) convert a string
 * argument to a float and drop digits without an error.
 */
function renderExact(
  value: DecimalParts,
  tag: string,
  options: Intl.NumberFormatOptions,
  minFrac: number,
  maxFrac: number,
  rounding: Rounding,
  signDisplay: SignDisplay,
): ExactRender {
  const rounded = roundDecimal(value, maxFrac, rounding);

  let frac = rounded.frac.slice(0, maxFrac).replace(/0+$/, '');
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, '0');

  const wholeValue = BigInt(rounded.whole);
  const isZero = wholeValue === 0n && !/[1-9]/.test(frac);
  const sign = shownSign(rounded.negative, isZero, signDisplay);

  const standIn = wholeValue === 0n && sign !== 'none';
  const magnitude = standIn ? 1n : wholeValue;
  const nf = numberFormat(tag, {
    ...options,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    signDisplay: sign === 'plus' ? 'always' : 'auto',
  });
  const raw = nf.formatToParts(sign === 'minus' ? -magnitude : magnitude);

  let lastInteger = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]?.type === 'integer') lastInteger = i;
  }

  const parts: FormatPart[] = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i];
    if (!part) continue;
    if (standIn && part.type === 'integer') parts.push({ type: 'integer', value: localeDigits(tag)[0] ?? '0' });
    else parts.push(toPart(part));
    if (i === lastInteger && frac.length > 0) {
      parts.push({ type: 'decimal', value: decimalSeparator(tag) }, { type: 'fraction', value: toLocaleDigits(frac, tag) });
    }
  }
  return { parts, isZero };
}

// ── Money ───────────────────────────────────────────────────────────────────

export type CurrencyDisplay = 'symbol' | 'narrowSymbol' | 'code' | 'name' | 'none';

export interface MoneyFormatOptions {
  /** Defaults to the currency's ISO minor units, or 0 for assets with none. */
  readonly minFractionDigits?: number;
  /** Defaults to the currency's ISO minor units, or `DEFAULT_ASSET_DECIMALS`. Pass 18 to show everything. */
  readonly maxFractionDigits?: number;
  /**
   * How the currency itself is shown. `'name'` leaves pluralisation of the
   * currency name to `Intl`, which only sees the integer part — prefer
   * `'symbol'` or `'code'` on money surfaces.
   */
  readonly display?: CurrencyDisplay;
  readonly useGrouping?: boolean;
  /** Defaults to `'half-up'`. Use `'down'` for an available balance. */
  readonly rounding?: Rounding;
  /** Defaults to `'auto'`. */
  readonly signDisplay?: SignDisplay;
}

/**
 * Format a money amount as parts. See `formatMoney`; joining the parts gives
 * exactly its string.
 */
export function formatMoneyToParts(
  amount: string,
  currency: string,
  locale: string = DEFAULT_LOCALE,
  options: MoneyFormatOptions = {},
): FormatPart[] {
  const value = splitDecimal(amount);
  const tag = intlTagFor(locale);
  const code = currency.trim().toUpperCase();
  const known = fiat(code);
  const display = options.display ?? 'symbol';

  const maxFrac = options.maxFractionDigits ?? known?.minorUnits ?? DEFAULT_ASSET_DECIMALS;
  const minFrac = Math.min(options.minFractionDigits ?? known?.minorUnits ?? 0, maxFrac);
  const useGrouping = options.useGrouping ?? true;
  const rounding = options.rounding ?? 'half-up';
  const signDisplay = options.signDisplay ?? 'auto';

  // `Intl` only accepts well-formed ISO-style currency codes, and only knows
  // the ones in CLDR (`currency: 'USDC'` throws). Anything else (USDT, IFC, an
  // on-chain ticker) is rendered as a plain number with the ticker beside it.
  if (display === 'none' || !known) {
    const { parts } = renderExact(value, tag, { style: 'decimal', useGrouping }, minFrac, maxFrac, rounding, signDisplay);
    if (display === 'none') return parts;
    return [...parts, { type: 'literal', value: ' ' }, { type: 'unit', value: code }];
  }

  const style: Intl.NumberFormatOptions = { style: 'currency', currency: known.code, currencyDisplay: display, useGrouping };
  return renderExact(value, tag, style, minFrac, maxFrac, rounding, signDisplay).parts;
}

/**
 * Format a money amount for display.
 *
 * @param amount   Decimal string, exactly as it crossed the service boundary.
 *                 Never a `number` — the signature is the enforcement.
 * @param currency ISO 4217 code (formatted as currency) or an asset ticker such
 *                 as `BTC` / `USDT` (formatted as a number with the ticker).
 * @param locale   App locale code from the registry, or any BCP-47 tag.
 */
export function formatMoney(amount: string, currency: string, locale: string = DEFAULT_LOCALE, options: MoneyFormatOptions = {}): string {
  return joinParts(formatMoneyToParts(amount, currency, locale, options));
}

// ── Numbers ─────────────────────────────────────────────────────────────────

export interface NumberFormatOptions {
  readonly minFractionDigits?: number;
  /** Defaults to "everything the string carries" — precision is never dropped by accident. */
  readonly maxFractionDigits?: number;
  readonly useGrouping?: boolean;
  readonly notation?: 'standard' | 'compact';
  /** Decimal strings only. Defaults to `'half-up'`. */
  readonly rounding?: Rounding;
  /** Decimal strings only. Defaults to `'auto'`. */
  readonly signDisplay?: SignDisplay;
}

/** Format a decimal string as parts. See `formatNumber`. */
export function formatNumberToParts(value: string, locale: string = DEFAULT_LOCALE, options: NumberFormatOptions = {}): FormatPart[] {
  const tag = intlTagFor(locale);
  const parts = splitDecimal(value);
  const maxFrac = options.maxFractionDigits ?? parts.frac.length;
  const minFrac = Math.min(options.minFractionDigits ?? 0, maxFrac);
  const style: Intl.NumberFormatOptions = { style: 'decimal', useGrouping: options.useGrouping ?? true };
  return renderExact(parts, tag, style, minFrac, maxFrac, options.rounding ?? 'half-up', options.signDisplay ?? 'auto').parts;
}

/**
 * Format a number. Decimal strings take the exact path; `number` and `bigint`
 * go straight to `Intl`. If the value came from a balance, it is a string.
 */
export function formatNumber(value: string | number | bigint, locale: string = DEFAULT_LOCALE, options: NumberFormatOptions = {}): string {
  if (typeof value !== 'string') {
    return numberFormat(intlTagFor(locale), {
      minimumFractionDigits: options.minFractionDigits ?? 0,
      maximumFractionDigits: options.maxFractionDigits ?? Math.max(options.minFractionDigits ?? 0, 3),
      useGrouping: options.useGrouping ?? true,
      notation: options.notation ?? 'standard',
    }).format(value);
  }
  return joinParts(formatNumberToParts(value, locale, options));
}

// ── Compact ─────────────────────────────────────────────────────────────────

export interface CompactFormatOptions {
  /** An ISO 4217 code or an asset ticker. Omit for a bare number. */
  readonly currency?: string;
  /** How a fiat currency is shown. Defaults to `'symbol'`. */
  readonly display?: Exclude<CurrencyDisplay, 'none' | 'name'>;
  /** Defaults to `'auto'`. */
  readonly signDisplay?: SignDisplay;
}

/**
 * A short figure for volumes and market caps: "$1.2M", "1,2 Mio. $", "12万".
 *
 * Exact without floats: a value of 1,000 or more is cut to its integer part
 * and handed to `Intl` as a BigInt. That never changes the shown digits,
 * because compact display rounds at a power of ten no smaller than ten, so
 * every rounding boundary is a whole number. Below 1,000 there is nothing to
 * shorten and the standard formatter answers. Rounding is always half-up: a
 * compact figure is never a balance anyone withdraws against.
 */
export function formatCompact(value: string, locale: string = DEFAULT_LOCALE, options: CompactFormatOptions = {}): string {
  const parts = splitDecimal(value);
  const tag = intlTagFor(locale);
  const code = options.currency?.trim().toUpperCase();
  const known = code ? fiat(code) : undefined;
  const signDisplay = options.signDisplay ?? 'auto';
  const whole = BigInt(parts.whole);

  if (whole < 1000n) {
    if (code) return formatMoney(value, code, locale, { signDisplay, ...(known ? {} : { maxFractionDigits: 2 }) });
    return formatNumber(value, locale, { maxFractionDigits: 2, signDisplay });
  }

  const sign = shownSign(parts.negative, false, signDisplay);
  const intlSign: Intl.NumberFormatOptions['signDisplay'] = sign === 'plus' ? 'always' : 'auto';
  const signed = sign === 'minus' ? -whole : whole;
  if (known) {
    const style = { style: 'currency', currency: known.code, currencyDisplay: options.display ?? 'symbol' } as const;
    return numberFormat(tag, { ...style, notation: 'compact', signDisplay: intlSign }).format(signed);
  }
  const text = numberFormat(tag, { notation: 'compact', signDisplay: intlSign }).format(signed);
  return code ? `${text} ${code}` : text;
}

// ── Percent ─────────────────────────────────────────────────────────────────

export interface PercentFormatOptions {
  readonly minFractionDigits?: number;
  readonly maxFractionDigits?: number;
  /**
   * `true` is the old spelling of `'exceptZero'`: a plus on positive values,
   * for 24h change columns. Defaults to `'auto'`.
   */
  readonly signDisplay?: boolean | SignDisplay;
  /** Defaults to `'half-up'`. */
  readonly rounding?: Rounding;
}

/** Format a ratio as percent parts. See `formatPercent`. */
export function formatPercentToParts(
  ratio: string | number,
  locale: string = DEFAULT_LOCALE,
  options: PercentFormatOptions = {},
): FormatPart[] {
  const tag = intlTagFor(locale);
  const value = shiftRight(splitDecimal(typeof ratio === 'string' ? ratio : ratio.toFixed(10)), 2);

  const maxFrac = options.maxFractionDigits ?? 2;
  const minFrac = Math.min(options.minFractionDigits ?? 0, maxFrac);
  const signOption = options.signDisplay;
  const signDisplay: SignDisplay =
    signOption === true ? 'exceptZero' : signOption === false || signOption === undefined ? 'auto' : signOption;

  // The digits, unsigned, through the decimal path; then the locale's percent
  // template (sign and % placement, "%5" in Turkish, "5 %" in French) from a
  // stand-in, its integer swapped for those digits.
  const magnitude = { ...value, negative: false };
  const figure = renderExact(
    magnitude,
    tag,
    { style: 'decimal', useGrouping: true },
    minFrac,
    maxFrac,
    options.rounding ?? 'half-up',
    'never',
  );
  const sign = shownSign(value.negative, figure.isZero, signDisplay);
  const template = numberFormat(tag, {
    style: 'percent',
    maximumFractionDigits: 0,
    signDisplay: sign === 'plus' ? 'always' : 'auto',
  }).formatToParts(sign === 'minus' ? -1n : 1n);

  const parts: FormatPart[] = [];
  let placed = false;
  for (const part of template) {
    if (part.type === 'integer') {
      if (!placed) parts.push(...figure.parts);
      placed = true;
      continue;
    }
    if (part.type === 'group') continue;
    if (sign === 'none' && (part.type === 'minusSign' || part.type === 'plusSign')) continue;
    parts.push(toPart(part));
  }
  return parts;
}

/**
 * Format a ratio as a percentage. `'0.0432'` → `4.32%`.
 *
 * The ×100 is a decimal-point shift on the digit string, not a multiplication,
 * so a rate quoted to 18 places stays exact.
 */
export function formatPercent(ratio: string | number, locale: string = DEFAULT_LOCALE, options: PercentFormatOptions = {}): string {
  return joinParts(formatPercentToParts(ratio, locale, options));
}

// ── Direction ───────────────────────────────────────────────────────────────

const ISOLATE_OPEN = { ltr: '⁦', rtl: '⁧', auto: '⁨' } as const;
const POP_ISOLATE = '⁩';

/**
 * Keep a run of text in its own direction inside the other one, for sinks
 * that take plain text only: an `aria-label`, `document.title`, a push
 * notification. In markup use `<bdi dir="ltr">` (or `dir="ltr"` with
 * `unicode-bidi: isolate`) instead, as W3C advises.
 *
 * Addresses, hashes, IBANs, sort codes and order-book figures are `'ltr'`
 * in every language. A name, payee reference or token name of unknown
 * direction is `'auto'`.
 */
export function isolate(text: string, direction: 'ltr' | 'rtl' | 'auto' = 'ltr'): string {
  return `${ISOLATE_OPEN[direction]}${text}${POP_ISOLATE}`;
}

/**
 * An IBAN in its printed form (ISO 13616): upper case, in groups of four.
 * Display only; validate and store the electronic form, without spaces.
 * Keep it left-to-right in every language.
 */
export function formatIban(iban: string): string {
  const compact = iban.replace(/\s+/g, '').toUpperCase();
  return compact.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Shorten an address or hash in the middle: "0x12ab…9f3c". The ends are the
 * parts people compare, so both stay. A value no longer than `head + tail + 1`
 * comes back whole. Keep it left-to-right in every language, and always offer
 * the full value beside it (copy, or a tap to expand).
 */
export function shortenIdentifier(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

// ── Dates ───────────────────────────────────────────────────────────────────

export type DateInput = Date | number | string;

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AmountFormatError(`Not a date: "${String(value)}"`);
  return date;
}

function dateFormat(tag: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tag}|${JSON.stringify(options)}`;
  let df = dateFormatCache.get(key);
  if (!df) {
    df = new Intl.DateTimeFormat(tag, options);
    dateFormatCache.set(key, df);
  }
  return df;
}

/** Format a date or timestamp. Defaults to a medium date in the locale's own calendar conventions. */
export function formatDate(
  value: DateInput,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return dateFormat(intlTagFor(locale), options).format(toDate(value));
}

/** Date plus time — the default for ledger and order history rows. */
export function formatDateTime(
  value: DateInput,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return dateFormat(intlTagFor(locale), options).format(toDate(value));
}

export interface RelativeTimeOptions {
  /** Defaults to now. Injected in tests so relative time is deterministic. */
  readonly now?: DateInput;
  /** `'auto'` yields "yesterday" where the language has a word for it. */
  readonly numeric?: 'auto' | 'always';
}

const RELATIVE_UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
];

/**
 * "3 minutes ago", "in 2 days" — via `Intl.RelativeTimeFormat`, which owns the
 * grammar for every language we ship.
 */
export function formatRelativeTime(value: DateInput, locale: string = DEFAULT_LOCALE, options: RelativeTimeOptions = {}): string {
  const tag = intlTagFor(locale);
  const numeric = options.numeric ?? 'auto';
  const key = `${tag}|${numeric}`;
  let rtf = relativeFormatCache.get(key);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric });
    relativeFormatCache.set(key, rtf);
  }

  const from = toDate(options.now ?? Date.now()).getTime();
  const delta = toDate(value).getTime() - from;
  const magnitude = Math.abs(delta);

  for (const { unit, ms } of RELATIVE_UNITS) {
    if (magnitude >= ms) return rtf.format(Math.round(delta / ms), unit);
  }
  return rtf.format(0, 'second');
}
