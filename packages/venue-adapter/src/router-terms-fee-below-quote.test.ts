import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import type { RestLatencyGrade } from '@intafaced/venue-contracts';
import type { SorCostTerms } from './cost-model.js';
import { planRoute } from './router.js';
import type { LiquiditySource, QuoteRequest, VenueHealth } from './source.js';

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

function completeTerms(over: Partial<SorCostTerms> = {}): SorCostTerms {
  return {
    feeBps: 10,
    expectedImpactBps: 5,
    transferCostBps: 2,
    latencyGrade: graded(),
    ...over,
  };
}

interface FakeOpts {
  id: string;
  kind: LiquiditySource['kind'];
  price: string;
  amount: string;
  feeBps: number;
  latencyMs?: number;
}

function venue(o: FakeOpts): LiquiditySource {
  const now = Date.now();
  const health: VenueHealth = {
    healthy: true,
    latencyMs: o.latencyMs ?? 10,
    lastUpdate: new Date(now),
  };
  return {
    id: o.id,
    kind: o.kind,
    capabilities: ['quote', 'orderbook', 'submit'],
    health: () => health,
    markets: async () => [],
    quote: async (req: QuoteRequest) => ({
      venueId: o.id,
      symbol: req.symbol,
      side: req.side,
      amount: amt(o.amount),
      price: amt(o.price),
      feeBps: o.feeBps,
      expiresAt: new Date(now + 30_000),
    }),
    orderBook: async () => ({
      symbol: 'BTC/USDT',
      bids: [[o.price, o.amount]],
      asks: [[o.price, o.amount]],
      timestamp: now,
      datetime: new Date(now).toISOString(),
      nonce: 1,
    }),
    submit: async () => ({
      venueId: o.id,
      venueOrderId: 'v-1',
      filledAmount: amt(o.amount),
      averagePrice: amt(o.price),
      feeAmount: amt('0'),
      feeAsset: 'USDT',
      status: 'filled' as const,
      executedAt: new Date(),
    }),
  };
}

const buy = (amount: string): QuoteRequest => ({ symbol: 'BTC/USDT', side: 'buy', amount: amt(amount) });

describe('planRoute — terms fee below the live quote fee (L1363)', () => {
  it('does not let a lower terms fee outrank a better displayed effective price', async () => {
    // Same price. Stale quote fee is 10 and its terms fee is 0, so the
    // displayed effective is 100.1. Honest fees match at 0, so its displayed
    // effective is 100. Impact 5 and transfer 2 stay on the scored total.
    // Stale is faster; that tie-break must not save a worse displayed price.
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'stale', kind: 'external-cex', price: '100', amount: '10', feeBps: 10, latencyMs: 1 }),
        venue({ id: 'honest', kind: 'external-cex', price: '100', amount: '10', feeBps: 0, latencyMs: 10 }),
      ],
      {
        costTermsByVenue: {
          stale: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
          honest: completeTerms({ feeBps: 0, expectedImpactBps: 5, transferCostBps: 2 }),
        },
      },
    );

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['honest']);
    expect(plan.legs[0]?.feeBps).toBe(0);
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('100');
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('100.07');
    expect(plan.legs[0]?.expectedImpactBps).toBe(5);
    expect(plan.legs[0]?.transferCostBps).toBe(2);
    expect(plan.rejected.find((row) => row.venueId === 'stale')?.reason).toBe('filled');
  });

  it('reports the quote fee on the chosen leg, not the lower terms fee', async () => {
    // Chosen venue: quote fee 10, terms fee 0. The leg still shows 10 and the
    // fee-only effective 100.1. Ranking uses that quote fee, not the terms fee.
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'heavier', kind: 'external-cex', price: '100', amount: '10', feeBps: 10, latencyMs: 1 }),
        venue({ id: 'shown', kind: 'external-cex', price: '100', amount: '10', feeBps: 10, latencyMs: 10 }),
      ],
      {
        costTermsByVenue: {
          heavier: completeTerms({ feeBps: 10, expectedImpactBps: 50, transferCostBps: 0 }),
          shown: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['shown']);
    expect(plan.legs[0]?.feeBps).toBe(10);
    expect(formatAmount(plan.legs[0]!.price)).toBe('100');
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('100.1');
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('100.1');
  });

  it('keeps a higher terms fee on the scored total', async () => {
    // Dear terms fee is 10 against a quote fee of 0, so the scored total is
    // 17 bps. Matched fees are 0, so its total is 7 bps. Lowering the dear
    // fee to the quote would tie them; dear is listed first and is faster.
    const plan = await planRoute(
      buy('2'),
      [
        venue({ id: 'dear', kind: 'external-cex', price: '100', amount: '1', feeBps: 0, latencyMs: 1 }),
        venue({ id: 'matched', kind: 'external-cex', price: '100', amount: '1', feeBps: 0, latencyMs: 10 }),
      ],
      {
        costTermsByVenue: {
          dear: completeTerms({ feeBps: 10, expectedImpactBps: 5, transferCostBps: 2 }),
          matched: completeTerms({ feeBps: 0, expectedImpactBps: 5, transferCostBps: 2 }),
        },
      },
    );

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['matched', 'dear']);
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('100.07');
    expect(plan.legs[1]?.feeBps).toBe(0);
    expect(formatAmount(plan.legs[1]!.effectivePrice)).toBe('100');
    expect(formatAmount(plan.legs[1]!.allInEffectivePrice)).toBe('100.17');
    expect(plan.legs[1]?.expectedImpactBps).toBe(5);
    expect(plan.legs[1]?.transferCostBps).toBe(2);
  });

  it('ranks equal fees on the scored total, including impact', async () => {
    // Both quote fees match their terms fees at 10. Heavier impact is 50
    // against 5, with the same transfer 2. Heavier is listed first and is
    // faster, so a fee-only rank would pick it.
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'heavier-impact', kind: 'external-cex', price: '100', amount: '10', feeBps: 10, latencyMs: 1 }),
        venue({ id: 'with-impact', kind: 'external-cex', price: '100', amount: '10', feeBps: 10, latencyMs: 10 }),
      ],
      {
        costTermsByVenue: {
          'heavier-impact': completeTerms({ feeBps: 10, expectedImpactBps: 50, transferCostBps: 2 }),
          'with-impact': completeTerms({ feeBps: 10, expectedImpactBps: 5, transferCostBps: 2 }),
        },
      },
    );

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['with-impact']);
    expect(plan.legs[0]?.feeBps).toBe(10);
    expect(plan.legs[0]?.expectedImpactBps).toBe(5);
    expect(plan.legs[0]?.transferCostBps).toBe(2);
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('100.1');
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('100.17');
    expect(plan.rejected.find((row) => row.venueId === 'heavier-impact')?.reason).toBe('filled');
  });
});
