import { formatAmount, parseAmount } from '../../../shared/money';
import type { ProtectionKind, ProtectionSource } from '../../../features/trade/venue-api';

/**
 * A position's protections on the venue desk (J-derivatives-03): where a kind rests, which fields it takes, and how much
 * of the position it covers. Pure, so each rule is tested on its own.
 */

/** The price fields each kind takes beside its size (svc-trade protections.ts `FIELDS`); any other is refused there. */
export const PROTECTION_FIELDS: Readonly<Record<ProtectionKind, readonly ('triggerPrice' | 'limitPrice' | 'trailingDistance')[]>> = {
  take_profit: ['triggerPrice'],
  stop_loss: ['triggerPrice'],
  stop_market: ['triggerPrice'],
  stop_limit: ['triggerPrice', 'limitPrice'],
  trailing_stop: ['trailingDistance'],
};

/**
 * Where a protection of this kind, judged on this source, rests: on the venue as its own trigger order when the venue
 * judges triggers on that source (never a trailing stop, which the venue lacks); on our engine for a trailing stop or a
 * stop market judged on the mark or the index, the only prices the engine reads; otherwise nowhere.
 */
export function whereItRests(
  kind: ProtectionKind,
  source: ProtectionSource,
  triggerSources: readonly string[] | undefined,
): 'venue' | 'engine' | 'none' {
  if (kind !== 'trailing_stop' && (triggerSources ?? []).includes(source)) return 'venue';
  if ((kind === 'stop_market' || kind === 'trailing_stop') && (source === 'mark' || source === 'index')) return 'engine';
  return 'none';
}

/** How much of a position a protection's size covers: all of it, or a part and the rest it leaves; null when unreadable. */
export type Coverage = { whole: true } | { whole: false; covers: string; of: string; rest: string };

export function coverage(quantity: string, positionSize: string): Coverage | null {
  let q: bigint;
  let size: bigint;
  try {
    q = parseAmount(quantity.trim());
    size = parseAmount(positionSize);
  } catch {
    return null;
  }
  if (q <= 0n || size <= 0n) return null;
  if (q >= size) return { whole: true };
  return { whole: false, covers: formatAmount(q), of: formatAmount(size), rest: formatAmount(size - q) };
}

/** The side that closes a position: a sell closes a long, a buy a short. */
export const closingSide = (side: 'long' | 'short'): 'buy' | 'sell' => (side === 'long' ? 'sell' : 'buy');

/** A canonical decimal for display (`1.0` is `1`), or the text as given when it is not a decimal. */
export function canonical(value: string): string {
  try {
    return formatAmount(parseAmount(value.trim()));
  } catch {
    return value;
  }
}

/** A protection's own id for one arm press: letters, digits and dashes, unique per press. */
export function protectionClientId(now: number, counter: number): string {
  return `p-${now.toString(36)}${counter.toString(36)}`;
}
