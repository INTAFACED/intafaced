import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL,
  DEFAULT_MIN_BEST_LEVEL_NOTIONAL,
  bestFromDepth,
  bestLevelIsQuotable,
  depthRequirement,
  markSourceFromDepth,
  requiredBestLevelSize,
} from './mark-from-depth.js';
import type { EngineDepth } from '../spot/matching-client.js';

/** One wei. The smallest order the ledger's 18-decimal scale can express. */
const DUST = '0.000000000000000001';

describe('bestFromDepth', () => {
  it('reads top of book when the best levels carry real size', () => {
    const d: EngineDepth = { bids: [['99', '10']], asks: [['101', '20']], sequence: 1 };
    expect(bestFromDepth(d, depthRequirement(null))).toEqual({ bestBid: '99', bestAsk: '101' });
  });

  it('empty book → null sides', () => {
    expect(bestFromDepth({ bids: [], asks: [], sequence: 0 }, depthRequirement(null))).toEqual({
      bestBid: null,
      bestAsk: null,
    });
    expect(bestFromDepth(null, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
  });

  /**
   * THE DEFECT, AT THE LEVEL IT LIVED AT.
   *
   * `bestFromDepth` read index 0 of each level — the price — and discarded index
   * 1, the quantity. One wei at 1000 and one wei at 3000 therefore read as a
   * perfectly ordinary two-sided book.
   */
  it('a best level carrying dust is not a level', () => {
    const d: EngineDepth = { bids: [['1000', DUST]], asks: [['3000', DUST]], sequence: 1 };
    expect(bestFromDepth(d, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
  });

  it('reads the QUANTITY, not just the price — same prices, different sizes, different answer', () => {
    const thin: EngineDepth = { bids: [['1000', '0.001']], asks: [['3000', '0.001']], sequence: 1 };
    const thick: EngineDepth = { bids: [['1000', '1']], asks: [['3000', '1']], sequence: 1 };
    expect(bestFromDepth(thin, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
    expect(bestFromDepth(thick, depthRequirement(null))).toEqual({ bestBid: '1000', bestAsk: '3000' });
  });

  it('one thin side is enough to make the book one-sided', () => {
    const d: EngineDepth = { bids: [['1000', '10']], asks: [['3000', DUST]], sequence: 1 };
    expect(bestFromDepth(d, depthRequirement(null))).toEqual({ bestBid: '1000', bestAsk: null });
  });

  /** The threshold is a parameter, and the mechanism honours whatever it is set to. */
  it('honours a configured threshold in both directions', () => {
    const d: EngineDepth = { bids: [['100', '0.5']], asks: [['102', '0.5']], sequence: 1 };
    // 50 quote units a side: under the default 100, over a configured 10.
    expect(bestFromDepth(d, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
    expect(bestFromDepth(d, depthRequirement(null, { minBestLevelNotional: '10' }))).toEqual({ bestBid: '100', bestAsk: '102' });
    expect(bestFromDepth(d, depthRequirement(null, { minBestLevelNotional: '1000' }))).toEqual({ bestBid: null, bestAsk: null });
  });

  /** The unsafe reading must not be the one you get by leaving an argument off. */
  it('applies the threshold by DEFAULT — omitting the policy does not disable it', () => {
    expect(DEFAULT_MIN_BEST_LEVEL_NOTIONAL).toBe('100');
    const d: EngineDepth = { bids: [['1000', DUST]], asks: [['3000', DUST]], sequence: 1 };
    expect(bestFromDepth(d, depthRequirement(null)).bestBid).toBeNull();
  });

  it('an unreadable threshold falls back to the default rather than to no check', () => {
    const d: EngineDepth = { bids: [['1000', DUST]], asks: [['3000', DUST]], sequence: 1 };
    expect(bestFromDepth(d, depthRequirement(null, { minBestLevelNotional: 'not-a-number' }))).toEqual({ bestBid: null, bestAsk: null });
  });

  it('a malformed or non-positive quantity is no size at all', () => {
    expect(bestFromDepth({ bids: [['1000', '0']], asks: [['3000', '99']], sequence: 1 }, depthRequirement(null)).bestBid).toBeNull();
    expect(bestFromDepth({ bids: [['1000', 'abc']], asks: [['3000', '99']], sequence: 1 }, depthRequirement(null)).bestBid).toBeNull();
    expect(bestFromDepth({ bids: [['1000', '']], asks: [['3000', '99']], sequence: 1 }, depthRequirement(null)).bestBid).toBeNull();
  });
});

/**
 * THE RELATIVE REQUIREMENT — the half the absolute floor could not cover.
 *
 * The arithmetic only. What it is worth in money is measured against real
 * balances in `orderable-path.test.ts`; these assertions pin the RULE so that a
 * change to the rule cannot be mistaken for a change to a test fixture.
 */
describe('the best level must scale with the position it authorises', () => {
  const amt = parseAmount;

  /**
   * THE EXPLOITED LEVEL, IN ONE PAIR OF ASSERTIONS.
   *
   * 0.06 BTC at 1999 is 119.94 quote units — over the absolute floor by twenty
   * percent, which is exactly how it got through. Against a 500-contract
   * position it is 0.012% of what it would be pricing, and it is refused.
   */
  it('the same level passes for a small position and is refused for a large one', () => {
    const price = amt('1999');
    const qty = amt('0.06');
    expect(bestLevelIsQuotable(price, qty, depthRequirement(null))).toBe(true);
    expect(bestLevelIsQuotable(price, qty, depthRequirement(amt('1')))).toBe(true);
    // 1% of 500 contracts is 5; the level carries 0.06.
    expect(bestLevelIsQuotable(price, qty, depthRequirement(amt('500')))).toBe(false);
  });

  /** Both halves apply. A level under the ABSOLUTE floor fails however small the position. */
  it('the absolute floor still refuses dust that is a large fraction of a tiny position', () => {
    // 100% of this position rests at the level, and it is worth 1e-15 quote units.
    expect(bestLevelIsQuotable(amt('1000'), amt(DUST), depthRequirement(amt(DUST)))).toBe(false);
  });

  it('states the requirement in base units, and rounds it UP', () => {
    expect(DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL).toBe(100);
    expect(requiredBestLevelSize(depthRequirement(amt('500')))).toBe(amt('5'));
    expect(requiredBestLevelSize(depthRequirement(amt('10')))).toBe(amt('0.1'));
    // No position in scope → no relative requirement to state.
    expect(requiredBestLevelSize(depthRequirement(null))).toBeNull();
    // Rounds up: the last scaled unit is never rounded away.
    expect(requiredBestLevelSize(depthRequirement(1n))).toBe(1n);
  });

  /** A boundary is a place to be exact. `>=` the requirement passes; one unit under does not. */
  it('is exact on its own boundary', () => {
    const need = requiredBestLevelSize(depthRequirement(amt('500')))!;
    expect(bestLevelIsQuotable(amt('1999'), need, depthRequirement(amt('500')))).toBe(true);
    expect(bestLevelIsQuotable(amt('1999'), need - 1n, depthRequirement(amt('500')))).toBe(false);
  });

  /** Unreadable / negative bps is not permission to skip the check — same rule as the floor. */
  it('falls back to the default rather than to no relative check', () => {
    const broken = { minBestLevelNotional: '100', minBestLevelBpsOfNotional: -5 };
    expect(bestLevelIsQuotable(amt('1999'), amt('0.06'), depthRequirement(amt('500'), broken))).toBe(false);
    // Zero is reachable only by an operator writing zero, and it is honoured.
    const off = { minBestLevelNotional: '100', minBestLevelBpsOfNotional: 0 };
    expect(bestLevelIsQuotable(amt('1999'), amt('0.06'), depthRequirement(amt('500'), off))).toBe(true);
  });

  /**
   * THE PRE-CHANGE CALL SHAPE CANNOT SILENTLY RESTORE THE OLD BEHAVIOUR.
   *
   * The third argument used to be a bare `Amount`. Passed to today's signature
   * every field reads `undefined`, both checks fall through, and the function
   * would return TRUE — the exploited reading, back, from a call site that looks
   * fine. It throws instead.
   */
  it('refuses to be called with the pre-change argument shape', () => {
    expect(() => bestLevelIsQuotable(amt('1999'), amt('0.06'), amt('100') as never)).toThrow(/DepthQuoteRequirement/);
  });
});

describe('markSourceFromDepth', () => {
  const observedAt = new Date('2026-08-06T12:00:00.000Z');

  it('mids two-sided book', async () => {
    const src = markSourceFromDepth(async () => ({
      bids: [['100', '5']],
      asks: [['102', '5']],
      sequence: 3,
      observedAt,
    }));
    expect(await src.markPrice({ marketId: 'm1', at: observedAt })).toBe('101');
    expect((await src.quote({ marketId: 'm1', at: observedAt }))?.provenance).toBe('depth');
  });

  it('empty matching book → null (never invent)', async () => {
    const src = markSourceFromDepth(async () => ({ bids: [], asks: [], sequence: 0 }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('null depth reader → null', async () => {
    const src = markSourceFromDepth(async () => null);
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('one-sided book → null under default mid-only policy', async () => {
    const src = markSourceFromDepth(async () => ({
      bids: [['100', '5']],
      asks: [],
      sequence: 1,
    }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  /**
   * THE WHOLE OF DEFECT B, IN ONE ASSERTION.
   *
   * Before the fix this returned '2000' — a payout-grade `mid`, quality and all,
   * minted from two orders worth about four femto-cents. Two dust orders and no
   * capital at risk was a price the platform would pay on.
   */
  it('refuses to mint a mid from two dust orders (it used to answer 2000)', async () => {
    const src = markSourceFromDepth(async () => ({
      bids: [['1000', DUST]],
      asks: [['3000', DUST]],
      sequence: 1,
    }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
    expect(await src.quote({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  /**
   * REFUSES, rather than downgrading to `last`. A downgraded quote would still
   * clear `acceptableForMarking` and reach margin-call arithmetic and a trader's
   * screen as though somebody had quoted it. There is no quote here at all.
   */
  it('a thin book yields no quote of any quality — not a downgraded one', async () => {
    const src = markSourceFromDepth(async () => ({
      bids: [['1000', DUST]],
      asks: [['3000', DUST]],
      sequence: 1,
    }));
    expect(await src.quote({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('the same book with real size behind it still quotes normally', async () => {
    const src = markSourceFromDepth(async () => ({
      bids: [['1000', '1']],
      asks: [['3000', '1']],
      sequence: 1,
      observedAt,
    }));
    expect(await src.markPrice({ marketId: 'm1', at: observedAt })).toBe('2000');
  });

  /**
   * `authorisesSize` REACHES THE LEVEL CHECK, and it is the only thing that
   * differs between these three reads. One book, one moment, three stakes.
   */
  it('answers the same book differently depending on what the mark would authorise', async () => {
    const book = { bids: [['1000', '1']] as const, asks: [['3000', '1']] as const, sequence: 1 };
    const src = markSourceFromDepth(async () => ({ bids: [...book.bids], asks: [...book.asks], sequence: 1, observedAt }));
    const at = observedAt;
    // No position in scope — a ticker read. Absolute floor only.
    expect(await src.markPrice({ marketId: 'm1', at })).toBe('2000');
    // 1% of 50 contracts is 0.5; the level carries 1.
    expect(await src.markPrice({ marketId: 'm1', at, authorisesSize: parseAmount('50') })).toBe('2000');
    // 1% of 500 contracts is 5; the level carries 1. No mid, and no quote at all.
    expect(await src.markPrice({ marketId: 'm1', at, authorisesSize: parseAmount('500') })).toBeNull();
    expect(await src.quote({ marketId: 'm1', at, authorisesSize: parseAmount('500') })).toBeNull();
  });
});
