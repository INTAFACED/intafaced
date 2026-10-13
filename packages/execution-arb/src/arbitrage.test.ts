import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Amount, formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import type { SorCostTerms, VenueKind } from '@intafaced/venue-adapter';
import type { RestLatencyGrade } from '@intafaced/venue-contracts';
import {
  CROSS_EXCHANGE_DEFAULT_MID,
  CROSS_EXCHANGE_DEFAULT_SPREAD_BPS,
  HOUSE_ARB_PREFERENCE_BPS,
  isExternalVenueKind,
  isHouseBookKind,
  scanExternalCrossExchangeArb,
  type ArbVenueQuote,
  type ScanExternalArbInput,
  type ScanExternalArbResult,
} from './arbitrage.js';

const FRESH_NOW_MS = 1_000_000;
const OWNER_MAX_QUOTE_AGE_MS = 5_000;

function graded(letter: 'A' | 'B' | 'C' | 'D' | 'F' = 'A'): RestLatencyGrade {
  return {
    venueId: 'v',
    measurement: 'rest-round-trip',
    grade: letter,
    provisional: false,
    samples: 20,
    p50Ms: 30,
    p95Ms: 40,
    rejectRateBps: 0,
    errorRateBps: 0,
    staleMs: 0,
    reasons: [],
  };
}

function ungraded(): RestLatencyGrade {
  return {
    venueId: 'v',
    measurement: 'rest-round-trip',
    grade: null,
    provisional: false,
    samples: 0,
    p50Ms: null,
    p95Ms: null,
    rejectRateBps: null,
    errorRateBps: null,
    staleMs: null,
    reasons: ['no observations'],
  };
}

function completeTerms(over: Partial<SorCostTerms> = {}): SorCostTerms {
  return {
    feeBps: 5,
    expectedImpactBps: 2,
    transferCostBps: 1,
    latencyGrade: graded(),
    ...over,
  };
}

function q(over: { venueId: string; kind: VenueKind; price: string | null; amount?: Amount; asOfMs?: number | null }): ArbVenueQuote {
  return {
    venueId: over.venueId,
    kind: over.kind,
    price: over.price === null ? null : amt(over.price),
    amount: over.amount ?? amt('1'),
    asOfMs: over.asOfMs === undefined ? FRESH_NOW_MS : over.asOfMs,
  };
}

function scanArb(
  input: Omit<ScanExternalArbInput, 'nowMs' | 'maxQuoteAgeMs'> & Partial<Pick<ScanExternalArbInput, 'nowMs' | 'maxQuoteAgeMs'>>,
): ScanExternalArbResult {
  return scanExternalCrossExchangeArb({
    nowMs: FRESH_NOW_MS,
    maxQuoteAgeMs: OWNER_MAX_QUOTE_AGE_MS,
    ...input,
  });
}

describe('isExternalVenueKind — D26-P0-01', () => {
  it('treats internal as non-external', () => {
    expect(isExternalVenueKind('internal')).toBe(false);
    expect(isExternalVenueKind('external-cex')).toBe(true);
    expect(isExternalVenueKind('external-dex')).toBe(true);
    expect(isHouseBookKind('internal')).toBe(true);
    expect(isHouseBookKind('external-cex')).toBe(false);
  });
});

describe('scanExternalCrossExchangeArb — D26-P1-X4', () => {
  it('emits external CEX↔CEX opportunity when all-in edge is positive and inventory ready', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'binance', kind: 'external-cex', price: '100' }), q({ venueId: 'bybit', kind: 'external-cex', price: '101' })],
      costTermsByVenue: {
        binance: completeTerms({ feeBps: 5, expectedImpactBps: 0, transferCostBps: 0 }),
        bybit: completeTerms({ feeBps: 5, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { binance: true, bybit: true } },
    });

    // buy binance @100 all-in 100.05; sell bybit @101 all-in 100.9495… → positive edge
    expect(result.opportunities.length).toBe(1);
    const opp = result.opportunities[0]!;
    expect(opp.buyVenueId).toBe('binance');
    expect(opp.sellVenueId).toBe('bybit');
    expect(opp.edgePerUnit > 0n).toBe(true);
    expect(formatAmount(opp.buyAllIn)).toBe('100.05');
  });

  it('refuses internal house venue legs (external-only seal)', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'house', kind: 'internal', price: '99' }), q({ venueId: 'binance', kind: 'external-cex', price: '101' })],
      costTermsByVenue: {
        house: completeTerms(),
        binance: completeTerms(),
      },
      inventory: { prePositionedByVenue: { house: true, binance: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'internal_venue')).toBe(true);
  });

  it('unscored latency → zero_weight (no invent)', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ latencyGrade: ungraded() }),
        b: completeTerms(),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'zero_weight' && r.detail.includes('buy leg'))).toBe(true);
  });

  it('missing fee → incomplete_cost rather than assume 0', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: null }),
        b: completeTerms(),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.refused.some((r) => r.reason === 'incomplete_cost')).toBe(true);
    expect(result.opportunities).toHaveLength(0);
  });

  it('missing cost terms map entry refuses', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms(),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.refused.some((r) => r.reason === 'missing_cost_terms')).toBe(true);
  });

  it('DEX↔CEX without inventory both sides → bridge_fantasy', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'dex', kind: 'external-dex', price: '100' }), q({ venueId: 'cex', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        dex: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        cex: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { dex: true, cex: false } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'bridge_fantasy')).toBe(true);
  });

  it('DEX↔CEX with inventory both sides can emit when edge positive', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'dex', kind: 'external-dex', price: '100' }), q({ venueId: 'cex', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        dex: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        cex: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { dex: true, cex: true } },
    });

    expect(result.opportunities.some((o) => o.buyVenueId === 'dex' && o.sellVenueId === 'cex')).toBe(true);
  });

  it('CEX↔CEX without inventory → inventory_missing (not sized on implied transfer)', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'inventory_missing')).toBe(true);
  });

  it('refuses no_edge when all-in costs erase the spread', () => {
    // raw 10 bps spread, 20 bps all-in each side → no edge
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '100.1' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 20, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 20, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'no_edge')).toBe(true);
  });

  it('pins CROSS_EXCHANGE_DEFAULT_SPREAD_BPS as null (no sneak-in default)', () => {
    expect(CROSS_EXCHANGE_DEFAULT_SPREAD_BPS).toBeNull();
  });

  it('equal quotes refuse no_edge — default spread is not invented', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '100' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.every((r) => r.reason === 'no_edge')).toBe(true);
    expect(result.refused.some((r) => r.detail.includes('default spread not invented'))).toBe(true);
  });

  it('single quote does not invent a second venue or spread', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' })],
      costTermsByVenue: { a: completeTerms() },
      inventory: { prePositionedByVenue: { a: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused).toHaveLength(0);
  });

  it('missing impact refuses incomplete_cost rather than assume 0', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ expectedImpactBps: null }),
        b: completeTerms(),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'incomplete_cost' && r.detail.includes('missing_impact'))).toBe(true);
  });

  it('insufficient quoted size refuses rather than inventing depth', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('2'),
      quotes: [
        q({ venueId: 'a', kind: 'external-cex', price: '100', amount: amt('1') }),
        q({ venueId: 'b', kind: 'external-cex', price: '102', amount: amt('2') }),
      ],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.refused.some((r) => r.reason === 'insufficient_size')).toBe(true);
  });

  it('contemplated amount 0n refuses insufficient_size and is not emitted', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: 0n,
      quotes: [
        q({ venueId: 'a', kind: 'external-cex', price: '100', amount: amt('10') }),
        q({ venueId: 'b', kind: 'external-cex', price: '102', amount: amt('10') }),
      ],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.ok === false && r.reason === 'insufficient_size')).toBe(true);
  });

  it('negative contemplated amount refuses insufficient_size and is not emitted', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('-1'),
      quotes: [
        q({ venueId: 'a', kind: 'external-cex', price: '100', amount: amt('10') }),
        q({ venueId: 'b', kind: 'external-cex', price: '102', amount: amt('10') }),
      ],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.ok === false && r.reason === 'insufficient_size')).toBe(true);
  });

  it('positive contemplated amount passes the size check when both quotes are large enough', () => {
    const amount = amt('1');
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount,
      quotes: [
        q({ venueId: 'a', kind: 'external-cex', price: '100', amount: amt('10') }),
        q({ venueId: 'b', kind: 'external-cex', price: '102', amount: amt('10') }),
      ],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({ ok: true, amount });
    expect(result.refused.some((r) => r.reason === 'insufficient_size')).toBe(false);
  });

  it('skips house books even when they would be the cheap buy — no house prefer', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [
        q({ venueId: 'house', kind: 'internal', price: '90' }),
        q({ venueId: 'binance', kind: 'external-cex', price: '100' }),
        q({ venueId: 'bybit', kind: 'external-cex', price: '101' }),
      ],
      costTermsByVenue: {
        house: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        binance: completeTerms({ feeBps: 5, expectedImpactBps: 0, transferCostBps: 0 }),
        bybit: completeTerms({ feeBps: 5, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { house: true, binance: true, bybit: true } },
    });

    expect(result.opportunities.every((o) => o.buyVenueId !== 'house' && o.sellVenueId !== 'house')).toBe(true);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]!.buyVenueId).toBe('binance');
    expect(result.opportunities[0]!.sellVenueId).toBe('bybit');
    expect(result.refused.filter((r) => r.reason === 'internal_venue' && r.buyVenueId === 'house')).toHaveLength(1);
  });

  it('missing quote price does not invent a mid or spread against the live leg', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: null }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'missing_quote' && r.detail.includes('mid/spread not invented'))).toBe(true);
  });

  it('non-positive mid is not pairable — buy amt(0) vs sell amt(102) emits 0 opportunities', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '0' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'missing_quote' && r.detail.includes('non-positive'))).toBe(true);
  });

  it('negative mid is not pairable — refuse rather than invent a live price', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '-1' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'missing_quote' && r.detail.includes('non-positive'))).toBe(true);
  });

  it('missing asOf does not invent a live quote', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [
        q({ venueId: 'a', kind: 'external-cex', price: '100', asOfMs: null }),
        q({ venueId: 'b', kind: 'external-cex', price: '102' }),
      ],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'missing_quote')).toBe(true);
  });

  it('stale quote does not invent a spread from the remaining live book', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [
        q({ venueId: 'a', kind: 'external-cex', price: '100', asOfMs: FRESH_NOW_MS - OWNER_MAX_QUOTE_AGE_MS - 1 }),
        q({ venueId: 'b', kind: 'external-cex', price: '102' }),
      ],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.some((r) => r.reason === 'stale_quote')).toBe(true);
  });

  it('unset maxQuoteAgeMs refuses rather than inventing a freshness window', () => {
    const result = scanArb({
      symbol: 'BTC/USDT',
      amount: amt('1'),
      quotes: [q({ venueId: 'a', kind: 'external-cex', price: '100' }), q({ venueId: 'b', kind: 'external-cex', price: '102' })],
      costTermsByVenue: {
        a: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        b: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
      },
      inventory: { prePositionedByVenue: { a: true, b: true } },
      maxQuoteAgeMs: null,
    });

    expect(result.opportunities).toHaveLength(0);
    expect(result.refused.every((r) => r.reason === 'stale_quote')).toBe(true);
  });

  it('pins fail if house-prefer or invented mid/spread appears', () => {
    expect(HOUSE_ARB_PREFERENCE_BPS).toBeNull();
    expect(CROSS_EXCHANGE_DEFAULT_MID).toBeNull();
    expect(CROSS_EXCHANGE_DEFAULT_SPREAD_BPS).toBeNull();

    const src = readFileSync(fileURLToPath(new URL('./arbitrage.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/HOUSE_ARB_PREFERENCE_BPS:\s*(number|\d+)/);
    expect(src).not.toMatch(/CROSS_EXCHANGE_DEFAULT_MID:\s*(Amount|bigint|\d+)/);
    expect(src).not.toMatch(/CROSS_EXCHANGE_DEFAULT_SPREAD_BPS:\s*\d+/);
    expect(src).not.toMatch(/preferHouse|housePrefer|internalTieBreak/);
    expect(src).not.toMatch(/syntheticMid|\(\s*bid\s*\+\s*ask\s*\)\s*\/\s*2/);
    expect(src).not.toMatch(/DEFAULT_MID\s*=\s*(?!null)/);
    expect(src).toContain('isHouseBookKind');
    expect(src).toContain("'internal'");
  });
});
