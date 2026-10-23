/**
 * Number display rules (UI-SPEC §2.6). Strings in, strings out.
 *
 * Every helper takes the decimal string a service sent and returns text. Values
 * are rounded with scaled-bigint arithmetic (`decimal.ts`), then handed to
 * `@intafaced/i18n` for grouping and symbols; no money value becomes a JS
 * number on the way. Unknown input (null, undefined, malformed) renders "—",
 * never 0.
 */
import { formatMoney, formatNumber, formatPercent } from '@intafaced/i18n';
import { SCALE } from '@intafaced/money-math';
import { dec, decOrNull, fractionDigits, ratio, roundScaled, toFixedString, type Scaled } from './decimal';
import type { Decimal } from './types';

export const UNKNOWN = '—';
export const HIDDEN = '••••';
/** Typographic minus (U+2212), used for every negative figure. */
export const MINUS = '−';
export const PLUS = '+';

type Maybe = Decimal | null | undefined;
type LocaleOption = { locale?: string };

/** A non-zero value must never display as zero; below this it shows "<". */
const USD_SMALL_PLACES = 4;
const COMPACT_UNITS = ['', 'K', 'M', 'B', 'T'] as const;

function split(value: Scaled): { negative: boolean; abs: Scaled } {
  return value < 0n ? { negative: true, abs: -value } : { negative: false, abs: value };
}

function signPrefix(negative: boolean, showPlus: boolean, isZero: boolean): string {
  if (isZero) return '';
  return negative ? MINUS : showPlus ? PLUS : '';
}

export interface UsdOptions extends LocaleOption {
  /** "$1.2M": only for volumes in Pro tables and market cards. */
  compact?: boolean;
  /** Prefix positive values with "+" (change lines). */
  showPlus?: boolean;
}

/**
 * USD value. 2 decimals; under $1 up to 4 ("$0.0412"); compact only on request.
 * A non-zero value that would round to $0.0000 shows "<$0.0001".
 */
export function fmtUsd(value: Maybe, options: UsdOptions = {}): string {
  const parsed = dec(value);
  if (parsed === null) return UNKNOWN;
  const { negative, abs } = split(parsed);
  const locale = options.locale ?? 'en';
  const plus = options.showPlus ?? false;

  if (options.compact && abs >= 1000n * SCALE) {
    let unit = 1;
    let tenths = 0n;
    for (; unit < COMPACT_UNITS.length; unit += 1) {
      const divisor = SCALE * 10n ** BigInt(3 * unit);
      tenths = (abs * 10n + divisor / 2n) / divisor;
      if (tenths < 10000n || unit === COMPACT_UNITS.length - 1) break; // 999.95K rolls over to 1.0M
    }
    const whole = formatNumber((tenths / 10n).toString(), locale, { maxFractionDigits: 0 });
    return `${signPrefix(negative, plus, false)}$${whole}.${tenths % 10n}${COMPACT_UNITS[unit]}`;
  }

  if (abs === 0n) return `$${formatMoney('0', 'USD', locale, { display: 'none', minFractionDigits: 2, maxFractionDigits: 2 })}`;

  if (abs < SCALE) {
    const rounded = roundScaled(abs, USD_SMALL_PLACES);
    if (rounded === 0n) return `${signPrefix(negative, plus, false)}<$0.0001`;
    const text = formatMoney(toFixedString(rounded, USD_SMALL_PLACES), 'USD', locale, {
      minFractionDigits: 2,
      maxFractionDigits: USD_SMALL_PLACES,
    });
    return `${signPrefix(negative, plus, false)}${text}`;
  }

  const rounded = roundScaled(abs, 2);
  return `${signPrefix(negative, plus, rounded === 0n)}${formatMoney(toFixedString(rounded, 2), 'USD', locale, { minFractionDigits: 2, maxFractionDigits: 2 })}`;
}

/** "+$134.46" / "−$12.00": a signed USD change. */
export function fmtUsdChange(value: Maybe, options: LocaleOption = {}): string {
  return fmtUsd(value, { ...options, showPlus: true });
}

/**
 * Price with the market's tick size as the number of decimals, fixed so a
 * column lines up ("65,242.30" for tick 0.01). Unknown tick: the value's own
 * digits, at most 8. A non-zero price is never shown as zero.
 */
export function fmtPrice(value: Maybe, tickSize: Maybe, options: LocaleOption = {}): string {
  const parsed = dec(value);
  if (parsed === null) return UNKNOWN;
  const locale = options.locale ?? 'en';
  const { negative, abs } = split(parsed);
  const places = fractionDigits(tickSize) ?? Math.min(8, fractionDigits(value) ?? 2);
  const rounded = roundScaled(abs, places);
  const sign = negative && rounded !== 0n ? MINUS : '';
  if (rounded === 0n && abs !== 0n)
    return `${sign}${formatNumber(toFixedString(abs, 18).replace(/0+$/, ''), locale, { maxFractionDigits: 18 })}`;
  return `${sign}${formatNumber(toFixedString(rounded, places), locale, { minFractionDigits: places, maxFractionDigits: places })}`;
}

export interface AmountOptions extends LocaleOption {
  /** Asset precision. Default 8. */
  places?: number;
  /** Keep trailing zeros (table columns). Default: trimmed. */
  fixed?: boolean;
  /** `down` never shows more than the user holds. Default half-up. */
  round?: 'half-up' | 'down';
}

/**
 * Asset amount. Trailing zeros trimmed unless `fixed`. A non-zero amount is
 * never rounded to zero: if it does not fit `places` it shows with its own
 * digits (up to the ledger's 18).
 */
export function fmtAmount(value: Maybe, options: AmountOptions = {}): string {
  const parsed = dec(value);
  if (parsed === null) return UNKNOWN;
  const locale = options.locale ?? 'en';
  const places = Math.max(0, Math.min(18, options.places ?? 8));
  const { negative, abs } = split(parsed);
  let rounded = roundScaled(abs, places, options.round ?? 'half-up');
  let minimum = options.fixed ? places : 0;
  let maximum = places;
  if (rounded === 0n && abs !== 0n) {
    rounded = abs; // never round a non-zero amount to zero
    minimum = 0;
    maximum = 18;
  }
  const sign = negative && rounded !== 0n ? MINUS : '';
  return `${sign}${formatNumber(toFixedString(rounded, maximum), locale, { minFractionDigits: minimum, maxFractionDigits: maximum })}`;
}

export interface PctOptions extends LocaleOption {
  /** Default 2. */
  places?: number;
  /** Default true: "+4.02%". */
  signed?: boolean;
}

/** Ratio string to a signed percent: "-0.0028" -> "−0.28%". A value that rounds to zero shows "0.00%". */
export function fmtPct(ratio: Maybe, options: PctOptions = {}): string {
  const parsed = dec(ratio);
  if (parsed === null) return UNKNOWN;
  const locale = options.locale ?? 'en';
  const places = options.places ?? 2;
  const { negative, abs } = split(parsed);
  // Percent shown to `places` decimals is the ratio rounded to places + 2.
  const rounded = roundScaled(abs, places + 2);
  const body = formatPercent(toFixedString(rounded, places + 2), locale, { minFractionDigits: places, maxFractionDigits: places });
  const sign = rounded === 0n ? '' : negative ? MINUS : (options.signed ?? true) ? PLUS : '';
  return `${sign}${body}`;
}

/**
 * A percent the service already multiplied by 100 (CCXT `percentage`: "-0.597971947108675048" means -0.60%).
 * Same text as `fmtPct`; the old desk printed the raw 18-digit string.
 */
export function fmtPctPoints(percent: Maybe, options: PctOptions = {}): string {
  const parsed = dec(percent);
  if (parsed === null) return UNKNOWN;
  const asRatio = decOrNull(ratio(parsed, 100n * SCALE));
  return fmtPct(asRatio, options);
}

/** "+$134.46 (+4.02%)" or "—" when the dollar change is unknown. A missing percent drops the bracket. */
export function fmtChangeLine(usd: Maybe, pct: Maybe, options: LocaleOption = {}): string {
  if (dec(usd) === null) return UNKNOWN;
  const amount = fmtUsdChange(usd, options);
  return dec(pct) === null ? amount : `${amount} (${fmtPct(pct, options)})`;
}

/** Direction for the glyph and colour: sign is never carried by colour alone. */
export function direction(value: Maybe): 'up' | 'down' | 'flat' | null {
  const parsed = dec(value);
  if (parsed === null) return null;
  return parsed > 0n ? 'up' : parsed < 0n ? 'down' : 'flat';
}

export const DIRECTION_GLYPH = { up: '▲', down: '▼', flat: '' } as const;
