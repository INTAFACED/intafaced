import type { ProtocolSwapPool } from '@intafaced/contracts/protocol-swap';

/** Pure swap arithmetic for the form. Base units are bigint; nothing here goes through a JavaScript number. */

export const BPS = 10_000n;

/** The pools that trade exactly this pair, in the factory's order. */
export function poolsFor(pools: readonly ProtocolSwapPool[], tokenIn: string, tokenOut: string): ProtocolSwapPool[] {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  return pools.filter((pool) => {
    const pair = [pool.token0.toLowerCase(), pool.token1.toLowerCase()];
    return a !== b && pair.includes(a) && pair.includes(b);
  });
}

/** The least the swap may deliver: the quote less `bps` basis points, floored. Null when that rounds to nothing. */
export function minimumOut(amountOut: bigint, bps: number): bigint | null {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000 || amountOut <= 0n) return null;
  const floor = (amountOut * (BPS - BigInt(bps))) / BPS;
  return floor > 0n ? floor : null;
}

/** A slippage the person types as a percentage ("1", "0.5", "0.25") in whole basis points; null when it is not one. */
export function percentToBps(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Basis points as a percentage for reading: 300 → "3", 25 → "0.25". */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return rest ? `${whole}.${rest}` : String(whole);
}

/** Base units as a decimal for reading, at most `places` decimals, trailing zeros dropped, thousands grouped. */
export function formatUnits(units: bigint, decimals: number, places = 6): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (value % scale).toString().padStart(decimals, '0').slice(0, Math.min(places, decimals)).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** ERC-20 `Transfer(address,address,uint256)`. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}
/** What `token` paid `to` in a receipt, summed from its Transfer logs: what the swap actually delivered. */
export function receivedIn(logs: readonly ReceiptLog[], token: string, to: string): bigint {
  const recipient = `0x${to.slice(2).toLowerCase().padStart(64, '0')}`;
  return logs
    .filter(
      (log) =>
        log.address.toLowerCase() === token.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase() === recipient,
    )
    .reduce((sum, log) => sum + BigInt(log.data === '0x' ? 0 : log.data), 0n);
}

/**
 * A USD price (a decimal string) for reading, rounded half up: two places from one cent up, and six significant places
 * below a cent, so a tiny price never reads as $0.00.
 */
export function formatUsd(usd: string): string {
  const [whole = '0', fraction = ''] = usd.split('.');
  const lead = /^0*/.exec(fraction)![0].length;
  const places = whole === '0' && lead >= 2 ? lead + 6 : 2;
  const scale = 10n ** BigInt(places);
  const digits = BigInt(whole + fraction.padEnd(places + 1, '0').slice(0, places + 1));
  const rounded = (digits + 5n) / 10n;
  const shownWhole = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let shownFraction = (rounded % scale).toString().padStart(places, '0');
  if (places > 2) shownFraction = shownFraction.replace(/0+$/, '');
  return `$${shownWhole}.${shownFraction}`;
}
