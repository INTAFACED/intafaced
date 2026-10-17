/**
 * The ONE place the portal turns a service decimal or timestamp into text. Pages never call Intl, toLocale*,
 * displayAmount or Number() on money themselves. Areas that need a figure as a string use these; areas that render
 * it use `<MoneyText>` and `<DateTime>`, which call these.
 *
 * MONEY (strings in, strings out, never a JS number):
 *   moneyPlaces(asset)                 2 for dollars, euros and stablecoins; 8 for anything else (BTC, ETH).
 *   formatMoney(value, asset, opts?)   "1,234.50", "−3.00", "0.50000000" -> "0.50". Number only, no asset code.
 *       opts.exact   true shows every digit the service sent (padded to the asset's places). Review dialogs use it.
 *       opts.sign    'minus' prefixes "−" to a positive value (a fee taken, a debit); 'plus' prefixes "+".
 *   isRounded(value, asset)            true when formatMoney (compact) hides digits, so a caller can show the exact one.
 *   effectiveFeeRate(fees, gross)      "1.50%": fees ÷ gross as exact bigint math, or null when gross is zero/unknown.
 *
 * TIME (ISO-8601 in, one format out, the zone always shown):
 *   formatDateTime(value, locale, timeZone?)  { short: "Oct 15, 2026, 10:40 PM GMT+8", full: "Thursday, …" } or null.
 *   formatDay(value, locale, timeZone?)       "Oct 15, 2026". Use for a day bucket, never a time such as "12:00 AM".
 *   Without `timeZone` the browser's zone is used and named. Statements, as-of times, limit resets and day buckets
 *   pass 'UTC' (the exported `UTC`) so the label reads "UTC".
 */
import { MINUS, PLUS, fmtAmount, fmtPct } from '../../../../data/format';
import { dec, ratio, str } from '../../../../data/decimal';
import { displayAmount } from '../../../../shared/money';

export const UTC = 'UTC';
const FIAT = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SGD', 'USDT', 'USDC', 'DAI', 'PYUSD', 'EURC']);

export function moneyPlaces(asset: string): 2 | 8 {
  return FIAT.has(asset.toUpperCase()) ? 2 : 8;
}

export type MoneyOptions = { exact?: boolean; sign?: 'minus' | 'plus' };

/** The number part of an amount: thousands separators, the asset's decimals, a real minus sign. Invalid input is "—". */
export function formatMoney(value: string, asset: string, opts: MoneyOptions = {}): string {
  const places = moneyPlaces(asset);
  let body: string;
  if (opts.exact) {
    try {
      const abs = value.startsWith('-') ? value.slice(1) : value;
      body = displayAmount(abs, 2);
      if (value.startsWith('-')) body = `${MINUS}${body}`;
    } catch {
      return '—';
    }
  } else {
    // Fiat is fixed at 2 places. Other assets show at least 2 and at most 8, so 20 BTC reads "20.00" not "20".
    body = fmtAmount(value, { places, fixed: places === 2 });
    if (places === 8 && !body.includes('.') && body !== '—') body = `${body}.00`;
    else if (places === 8 && /\.\d$/.test(body)) body = `${body}0`;
  }
  if (body === '—') return body;
  if (body.startsWith(MINUS)) return body;
  if (opts.sign && /[1-9]/.test(body)) return `${opts.sign === 'minus' ? MINUS : PLUS}${body}`;
  return body;
}

/** True when the compact figure hides digits the service sent (it rounded, or padded nothing away). */
export function isRounded(value: string, asset: string): boolean {
  const exact = formatMoney(value, asset, { exact: true });
  const compact = formatMoney(value, asset);
  return exact !== '—' && exact.replace(/,/g, '') !== compact.replace(/,/g, '');
}

/** Fees ÷ gross as a percent with two places, exact. Null when either is missing, invalid, or gross is not above zero. */
export function effectiveFeeRate(fees: string, gross: string): string | null {
  const f = dec(fees);
  const g = dec(gross);
  if (f === null || g === null || g <= 0n || f < 0n) return null;
  const r = ratio(f, g);
  return r === null ? null : fmtPct(str(r), { signed: false });
}

type Zone = { timeZone?: string };
const zoneOf = (timeZone?: string): Zone => (timeZone ? { timeZone } : {});

function parse(value: string): Date | null {
  const date = new Date(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(date.getTime()) ? date : null;
}

export function formatDateTime(value: string, locale: string, timeZone?: string): { short: string; full: string } | null {
  const date = parse(value);
  if (!date) return null;
  return {
    short: date.toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      ...zoneOf(timeZone),
    }),
    full: date.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'long', ...zoneOf(timeZone) }),
  };
}

/** A calendar day, "Oct 15, 2026". Pass 'UTC' when the value is a UTC day bucket. */
export function formatDay(value: string, locale: string, timeZone?: string): string | null {
  const date = parse(value);
  if (!date) return null;
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', ...zoneOf(timeZone) });
}
