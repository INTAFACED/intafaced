/**
 * Pure helpers for Convert's cost breakdown (TRMKT R3, BEG-0009). Money stays an exact decimal string: nothing here
 * parses an amount into a JS number.
 */
import { dec } from '../buy/trade-math';

/** The parts of a quote the breakdown needs. Loose on purpose: a reply may be missing a field. */
export interface BreakdownQuote {
  inAmount?: string | null;
  outAmount?: string | null;
  convertSpreadBps?: number | null;
}

const isBlankAmount = (value: string | null | undefined): boolean => {
  if (value === null || value === undefined || value.trim() === '') return true;
  return dec(value) === null;
};

/** Spread in basis points as a percent with two decimals, integer math only: 20 is "0.20%", 125 is "1.25%". */
export function spreadPercent(bps: number | null | undefined): string | null {
  if (bps === null || bps === undefined || typeof bps !== 'number' || !Number.isSafeInteger(bps) || bps < 0) return null;
  const whole = Math.floor(bps / 100);
  const part = String(bps % 100).padStart(2, '0');
  return `${whole}.${part}%`;
}

/** Names of the figures that are blank or unreadable. Empty means the quote may be accepted. */
export function blankParts(quote: BreakdownQuote | null | undefined): Array<'pay' | 'get' | 'spread'> {
  const missing: Array<'pay' | 'get' | 'spread'> = [];
  if (!quote || isBlankAmount(quote.inAmount)) missing.push('pay');
  if (!quote || isBlankAmount(quote.outAmount)) missing.push('get');
  if (!quote || spreadPercent(quote.convertSpreadBps) === null) missing.push('spread');
  return missing;
}

/** BEG-0009: Convert is refused while pay, get or spread is blank or unreadable. */
export function canAccept(quote: BreakdownQuote | null | undefined): boolean {
  return blankParts(quote).length === 0;
}

/** Wall-clock time the price stops being firm, in the viewer's zone (or `timeZone`). Null when `expiresAt` is unreadable. */
export function validUntilClock(expiresAt: string, options: { timeZone?: string; locale?: string } = {}): string | null {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: options.timeZone,
  });
}

/** Progress-bar numbers: whole seconds left against the length of the hold. Never outside 0..max. */
export function holdProgress(secondsLeft: number | null, holdLengthMs: number): { now: number; max: number } {
  const max = Math.max(1, Math.ceil((holdLengthMs > 0 ? holdLengthMs : 15_000) / 1000));
  const now = Math.min(max, Math.max(0, secondsLeft ?? 0));
  return { now, max };
}
