import { fmtAmount, fmtPrice } from '../../../data/format';
import type { P2pFiat } from '../../../preview/fixtures/p2p';

/** A fiat amount or price with its currency sign: "$1.0010", "₺342.00", "Rp158,200.00". One format per amount. */
export function fiatText(fiat: P2pFiat, value: string, tick: string): string {
  const sign = fiat.sign.length > 1 ? `${fiat.sign} ` : fiat.sign;
  return `${sign}${fmtPrice(value, tick)}`;
}

/** Coins held by an advertiser: "4,250" (USDT) or "0.42" (BTC). */
export function coinText(value: string): string {
  return fmtAmount(value, { places: 8 });
}

/** A whole-number count with group separators, from a plain integer. */
export function countText(value: number): string {
  return fmtAmount(String(value), { places: 0 });
}

/** Percent completed, from a decimal string like "98.40" -> "98.4". */
export function pctText(value: string): string {
  return fmtAmount(value, { places: 1 });
}
