/**
 * Unit card — D26-P0-14 dust floor stays shipped 100 / 100 bps, not "awaiting"
 * 1. Promise: production keeps DEFAULT_MIN_BEST_LEVEL_* in force by default (ADR 2026-08-13-mark-dust-floor)
 * 2. Break: change '100', or leave the pair blank as if it awaited an owner ruling
 * 3. Done bar: the constants hold the shipped pair and every default path applies them
 * 4. Class N
 * 5. Paths: mark-from-depth.ts · mark-from-venue.ts · mm/mid-source.ts
 * 6. RED: DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '500', or no floor applied when the policy is omitted
 * 7. Collision: none — does not retune the pair (ADR forbids)
 */

import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { EngineDepth } from '../spot/matching-client.js';
import {
  DEFAULT_DEPTH_QUOTE_POLICY,
  DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL,
  DEFAULT_MIN_BEST_LEVEL_NOTIONAL,
  bestFromDepth,
  depthRequirement,
  minBestLevelBpsOfNotional,
  minBestLevelNotional,
} from './mark-from-depth.js';

describe('D26-P0-14 dust floor is sealed, not awaiting', () => {
  it('keeps the shipped pair', () => {
    expect(DEFAULT_MIN_BEST_LEVEL_NOTIONAL).toBe('100');
    expect(DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL).toBe(100);
    // The default policy is that pair, and reading it with no policy named gives the pair, never nothing.
    expect(minBestLevelNotional()).toBe(parseAmount('100'));
    expect(minBestLevelNotional(DEFAULT_DEPTH_QUOTE_POLICY)).toBe(parseAmount('100'));
    expect(minBestLevelBpsOfNotional()).toBe(100);
    expect(minBestLevelBpsOfNotional(DEFAULT_DEPTH_QUOTE_POLICY)).toBe(100);
  });

  it('cites the seal ADR and does not call the pair an open placeholder', () => {
    // Sealed means in force: with no policy named, a best level just under 100 quote units does not quote, and one at
    // 100 does. A pair still awaiting a ruling would leave the default path with no floor at all.
    const under: EngineDepth = { bids: [['99', '1']], asks: [['99.99', '1']], sequence: 1 };
    const at: EngineDepth = { bids: [['100', '1']], asks: [['100', '1']], sequence: 1 };
    expect(bestFromDepth(under, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
    expect(bestFromDepth(at, depthRequirement(null))).toEqual({ bestBid: '100', bestAsk: '100' });
    // The relative half: a position of 10,000 contracts needs 100 bps of it, 100 contracts, at the best level.
    const position = parseAmount('10000');
    const thin: EngineDepth = { bids: [['100', '99']], asks: [['100', '99']], sequence: 1 };
    const deep: EngineDepth = { bids: [['100', '100']], asks: [['100', '100']], sequence: 1 };
    expect(bestFromDepth(thin, depthRequirement(position))).toEqual({ bestBid: null, bestAsk: null });
    expect(bestFromDepth(deep, depthRequirement(position))).toEqual({ bestBid: '100', bestAsk: '100' });
  });

  it('venue and MM paths do not claim the floor is still awaiting a ruling', () => {
    // Both read the same pair by default: mark-from-venue.test.ts ("two dust orders on the NEW venue mint nothing
    // either — same threshold, no second policy") and mm/mid-source.test.ts ("refuses a dust book — two 1-wei orders
    // do not mint a seed mid") drive those paths. Here: an unreadable floor falls back to the shipped pair, not to none.
    const dust: EngineDepth = { bids: [['1000', '0.000000000000000001']], asks: [['3000', '0.000000000000000001']], sequence: 1 };
    expect(bestFromDepth(dust, depthRequirement(null, { minBestLevelNotional: 'not-a-number' }))).toEqual({ bestBid: null, bestAsk: null });
    expect(bestFromDepth(dust, depthRequirement(null, DEFAULT_DEPTH_QUOTE_POLICY))).toEqual({ bestBid: null, bestAsk: null });
  });
});
