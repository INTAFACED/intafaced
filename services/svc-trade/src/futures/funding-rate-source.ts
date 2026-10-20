/**
 * Funding rate feed (trade.futures residual).
 *
 * PURE PORT: supplies period rates to runFundingTick.
 * Never invents a rate. Missing / stale / invalid → null (tick skips).
 *
 * Period identity: periodId is supplied by the publisher (e.g. market + ISO
 * period start). This file does not invent period boundaries or rates.
 */
import type { FundingRateQuote, FundingRateSource } from './funding-tick.js';

export interface FundingRateEntry extends FundingRateQuote {
  /** When the rate was observed/published (ms epoch). */
  asOfMs: number;
  /** Publisher-supplied end of this period. Omitted means the deadline is unknown. */
  periodEndIso?: string;
}

export interface FundingRatePolicy {
  /**
   * Max age in ms before a quote is treated as missing.
   * Omitted → quote is missing (D2: do not invent an 8h "typical" interval).
   * Set 0 to disable the age check after an explicit caller choice.
   */
  maxAgeMs?: number;
}

function isFiniteDecimal(s: string): boolean {
  // Allow optional leading minus; require at least one digit.
  return /^-?\d+(\.\d+)?$/.test(s.trim());
}

export function isRateFresh(entry: FundingRateEntry, atMs: number, maxAgeMs: number): boolean {
  if (maxAgeMs <= 0) return true;
  return atMs - entry.asOfMs <= maxAgeMs && atMs >= entry.asOfMs;
}

/**
 * In-memory rate book for tests and single-process dev.
 * Production replaces with an external funding-rate oracle — same port.
 */
export function memoryFundingRateBook(opts?: { now?: () => number; policy?: FundingRatePolicy }): {
  /** Publish an external rate for a period. */
  set(entry: FundingRateEntry): void;
  clear(marketId: string): void;
  /** Latest entry for a market (may be stale). */
  peek(marketId: string): FundingRateEntry | null;
  source(policy?: FundingRatePolicy): FundingRateSource;
} {
  const byMarket = new Map<string, FundingRateEntry>();
  const now = opts?.now ?? (() => Date.now());
  const defaultPolicy = opts?.policy ?? {};

  function resolve(marketId: string, atMs: number, policy?: FundingRatePolicy): FundingRateQuote | null {
    const e = byMarket.get(marketId);
    if (!e) return null;
    if (e.marketId !== marketId) return null;
    const maxAge = policy?.maxAgeMs ?? defaultPolicy.maxAgeMs;
    if (maxAge === undefined) return null;
    if (!isRateFresh(e, atMs, maxAge)) return null;
    if (!isFiniteDecimal(e.rate)) return null;
    if (!e.periodId || e.periodId.trim() === '') return null;
    return {
      rate: e.rate.trim(),
      periodId: e.periodId,
      marketId: e.marketId,
    };
  }

  return {
    set(entry) {
      byMarket.set(entry.marketId, entry);
    },
    clear(marketId) {
      byMarket.delete(marketId);
    },
    peek(marketId) {
      return byMarket.get(marketId) ?? null;
    },
    source(policy) {
      return {
        async quote({ marketId, at }) {
          return resolve(marketId, at.getTime(), policy);
        },
      };
    },
  };
}

/**
 * Fixed external quote source — for tests and injectors that already resolved
 * the period rate elsewhere. Returns null when quote is null (no invent).
 */
export function fixedFundingRateSource(quote: FundingRateQuote | null): FundingRateSource {
  return {
    async quote({ marketId }) {
      if (!quote) return null;
      if (quote.marketId !== marketId) return null;
      if (!isFiniteDecimal(quote.rate)) return null;
      return quote;
    },
  };
}

/**
 * Build a periodId from market + period window start (caller supplies window).
 * Does not invent the rate — only names the period for idempotency.
 */
export function periodIdFor(marketId: string, periodStartIso: string): string {
  return `${marketId}:${periodStartIso}`;
}

/**
 * Ask `primary` first; when it has no rate for this market, ask `fallback`. Used to put the computed-rate book in
 * front of the S2S-published one only when the funding rate computer is switched on. Neither source is asked to
 * invent anything: null from both stays null.
 */
export function preferFundingRateSource(primary: FundingRateSource, fallback: FundingRateSource): FundingRateSource {
  return {
    async quote(input) {
      return (await primary.quote(input)) ?? fallback.quote(input);
    },
  };
}
