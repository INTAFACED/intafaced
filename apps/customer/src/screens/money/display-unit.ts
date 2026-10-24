import { createContext, useContext } from 'react';
import { dec, fmtUsd, toFixedString } from './deps';

/**
 * The display unit of the Money screen's values (PF-overview-03). USD is the base every value is worked out in. BTC is the
 * same value divided by the BTC price the bank's summary used for its own BTC total (`btc.priceUsd`), rounded half-up to
 * 8 places the way the bank rounds that total; nothing else is priced here. Any other currency has no rate: the bank
 * refuses it (`bank.fx_rate_unset`) and the values stay in USD.
 */
export type ValueUnit = { code: 'USD' } | { code: 'BTC'; priceUsd: string };

export const USD_UNIT: ValueUnit = { code: 'USD' };

const BTC_DP = 8n;
const SCALE_DOWN = 10n ** (18n - BTC_DP);

/** A USD value in BTC at `priceUsd`, as an 8-place string; null when either is unknown or the price is not positive. */
export function usdToBtc(usd: string | null, priceUsd: string): string | null {
  const value = dec(usd);
  const price = dec(priceUsd);
  if (value === null || price === null || price <= 0n) return null;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  // One rounding, half-up, straight to 8 decimals: value / price in units of 10^-8 (the bank's btcValuation).
  const sats = (abs * 10n ** BTC_DP * 2n + price) / (price * 2n);
  return toFixedString((negative ? -sats : sats) * SCALE_DOWN, 8);
}

/** The text for a USD value in the chosen unit: "$1,234.56" through `usd`, or "₿0.01234567". Null stays null. */
export function valueText(unit: ValueUnit, value: string | null, usd: (value: string) => string): string | null {
  if (value === null) return null;
  if (unit.code === 'USD') return usd(value);
  const btc = usdToBtc(value, unit.priceUsd);
  return btc === null ? null : `₿${btc}`;
}

/**
 * A change line ("+$12.30 (1.20%)") in the chosen unit: in BTC the amount is converted like any value and the percent is
 * the same. `usdLine` is the screen's own dollar line; `pctText` formats the percent the way it does.
 */
export function changeText(
  unit: ValueUnit,
  usd: string | null,
  pct: string | null,
  usdLine: (usd: string | null, pct: string | null) => string,
  pctText: (pct: string) => string,
): string {
  if (unit.code === 'USD' || usd === null) return usdLine(usd, pct);
  const btc = usdToBtc(usd, unit.priceUsd);
  if (btc === null) return usdLine(null, pct);
  const negative = btc.startsWith('-');
  const zero = /^-?0\.0+$/.test(btc);
  const amount = `${zero ? '' : negative ? '−' : '+'}₿${negative ? btc.slice(1) : btc}`;
  return pct !== null && dec(pct) !== null ? `${amount} (${pctText(pct)})` : amount;
}

/** The unit every value on the Money screen is shown in (USD, or BTC at the bank's own BTC price). */
export const UnitContext = createContext<ValueUnit>(USD_UNIT);

/** A USD value as the Money screen shows it, in the chosen unit. */
export function useValueText(): (usd: string | null) => string | null {
  const unit = useContext(UnitContext);
  return (usd) => valueText(unit, usd, fmtUsd);
}
