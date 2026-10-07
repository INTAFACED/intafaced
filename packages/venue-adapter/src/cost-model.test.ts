import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import type { RestLatencyGrade } from '@intafaced/venue-contracts';
import { allInEffectivePrice, scoreSorCost, type SorCostTerms } from './cost-model.js';
import { routingWeightFromGrade } from './fabric/latency.js';
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
const sell = (amount: string): QuoteRequest => ({ symbol: 'BTC/USDT', side: 'sell', amount: amt(amount) });

describe('scoreSorCost — §28 complete model honesty (D26-P1-X3)', () => {
  it('accepts complete terms and sums fee + impact + transfer', () => {
    const scored = scoreSorCost(completeTerms());
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    expect(scored.routingWeight).toBe(1);
    expect(scored.totalCostBps).toBe(17);
  });

  it('unscored latency → routing weight zero (D-S-18 / D26-P1-X2 door)', () => {
    const grade = ungraded();
    expect(routingWeightFromGrade(grade)).toBe(0);
    const scored = scoreSorCost(completeTerms({ latencyGrade: grade }));
    expect(scored.ok).toBe(false);
    if (scored.ok) return;
    expect(scored.routingWeight).toBe(0);
    expect(scored.reason).toBe('unscored_latency');
  });

  it('null latency grade → zero weight', () => {
    const scored = scoreSorCost(completeTerms({ latencyGrade: null }));
    expect(scored.ok).toBe(false);
    if (scored.ok) return;
    expect(scored.routingWeight).toBe(0);
    expect(scored.reason).toBe('unscored_latency');
  });

  it('ungraded latency cannot invent routing bps — letter is not a cost term', () => {
    const refused = scoreSorCost(completeTerms({ latencyGrade: ungraded() }));
    expect(refused).toMatchObject({ ok: false, routingWeight: 0, reason: 'unscored_latency' });
    expect(refused).not.toHaveProperty('totalCostBps');

    const letters = ['A', 'B', 'C', 'D', 'F'] as const;
    const totals = letters.map((letter) => {
      const scored = scoreSorCost(completeTerms({ latencyGrade: graded(letter) }));
      expect(scored.ok).toBe(true);
      if (!scored.ok) return Number.NaN;
      expect(scored.routingWeight).toBe(1);
      expect(scored).not.toHaveProperty('latencyBps');
      return scored.totalCostBps;
    });

    // Same fee + impact + transfer for every letter. A mapping A→cheap / F→dear
    // would split this set. D-S-14: do not invent letter→bps on this surface.
    expect(new Set(totals)).toEqual(new Set([17]));
  });

  it('missing fee refuses rather than assuming 0', () => {
    const scored = scoreSorCost(completeTerms({ feeBps: null }));
    expect(scored).toMatchObject({ ok: false, routingWeight: 0, reason: 'missing_fee' });
  });

  it('missing expected impact refuses rather than assuming 0', () => {
    const scored = scoreSorCost(completeTerms({ expectedImpactBps: null }));
    expect(scored).toMatchObject({ ok: false, routingWeight: 0, reason: 'missing_impact' });
  });

  it('missing transfer cost refuses rather than assuming 0', () => {
    const scored = scoreSorCost(completeTerms({ transferCostBps: null }));
    expect(scored).toMatchObject({ ok: false, routingWeight: 0, reason: 'missing_transfer' });
  });

  it('negative terms refuse', () => {
    expect(scoreSorCost(completeTerms({ feeBps: -1 }))).toMatchObject({ ok: false, reason: 'negative_term' });
  });
});

describe('allInEffectivePrice', () => {
  it('adds total cost bps on the buy side', () => {
    // 100 + 17 bps = 100.17
    expect(formatAmount(allInEffectivePrice(amt('100'), 17, 'buy'))).toBe('100.17');
  });

  it('subtracts on the sell side', () => {
    expect(formatAmount(allInEffectivePrice(amt('100'), 17, 'sell'))).toBe('99.83');
  });
});

describe('planRoute sell — all-in cost must leave a positive price', () => {
  it('refuses a sell when all-in cost consumes the price', async () => {
    // Quote fee is 0, so fee-only effective stays 100. All-in is 10000 bps.
    const plan = await planRoute(
      sell('1'),
      [venue({ id: 'eaten', kind: 'external-cex', price: '100', amount: '1', feeBps: 0 })],
      {
        costTermsByVenue: {
          eaten: completeTerms({ feeBps: 10_000, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );
    expect(plan.legs).toHaveLength(0);
    expect(plan.routedAmount).toBe(0n);
    expect(plan.averageEffectivePrice).toBeNull();
    expect(plan.rejected.find((r) => r.venueId === 'eaten')?.reason).toBe('no_quote');
  });

  it('routes a sell when all-in cost stays under the price', async () => {
    const plan = await planRoute(
      sell('1'),
      [venue({ id: 'ok', kind: 'external-cex', price: '100', amount: '1', feeBps: 10 })],
      {
        costTermsByVenue: {
          ok: completeTerms({ feeBps: 10, expectedImpactBps: 5, transferCostBps: 2 }),
        },
      },
    );
    expect(plan.legs).toHaveLength(1);
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('99.9');
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('99.83');
    expect(plan.routedAmount > 0n).toBe(true);
    expect(plan.averageEffectivePrice! > 0n).toBe(true);
  });

  it('routes a buy when all-in cost is 100% — the buyer pays more', async () => {
    const plan = await planRoute(
      buy('1'),
      [venue({ id: 'dear', kind: 'external-cex', price: '100', amount: '1', feeBps: 0 })],
      {
        costTermsByVenue: {
          dear: completeTerms({ feeBps: 10_000, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );
    expect(plan.legs).toHaveLength(1);
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('200');
    expect(plan.averageEffectivePrice! > 0n).toBe(true);
  });
});

describe('planRoute + costTermsByVenue — D26-P1-X3 wiring', () => {
  it('routes on all-in cost: cheaper fee can lose to lower impact+transfer', async () => {
    // a: fee 0, impact 50, transfer 0 → 50 bps all-in
    // b: fee 10, impact 0, transfer 0 → 10 bps all-in — wins
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'a', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
        venue({ id: 'b', kind: 'external-cex', price: '100', amount: '10', feeBps: 10 }),
      ],
      {
        costTermsByVenue: {
          a: completeTerms({ feeBps: 0, expectedImpactBps: 50, transferCostBps: 0, latencyGrade: graded('A') }),
          b: completeTerms({ feeBps: 10, expectedImpactBps: 0, transferCostBps: 0, latencyGrade: graded('B') }),
        },
      },
    );

    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]?.venueId).toBe('b');
    expect(plan.legs[0]?.expectedImpactBps).toBe(0);
    expect(plan.legs[0]?.transferCostBps).toBe(0);
    // User-facing fee-only still reflects the venue fee.
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('100.1');
    expect(formatAmount(plan.legs[0]!.allInEffectivePrice)).toBe('100.1');
  });

  it('unscored latency venue gets zero weight even when its quote is cheaper', async () => {
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'cheap-ungraded', kind: 'external-cex', price: '90', amount: '10', feeBps: 0 }),
        venue({ id: 'dear-graded', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
      ],
      {
        costTermsByVenue: {
          'cheap-ungraded': completeTerms({
            feeBps: 0,
            expectedImpactBps: 0,
            transferCostBps: 0,
            latencyGrade: ungraded(),
          }),
          'dear-graded': completeTerms({
            feeBps: 0,
            expectedImpactBps: 0,
            transferCostBps: 0,
            latencyGrade: graded(),
          }),
        },
      },
    );

    expect(plan.legs.map((l) => l.venueId)).toEqual(['dear-graded']);
    expect(plan.rejected.find((r) => r.venueId === 'cheap-ungraded')?.reason).toBe('zero_weight');
    expect(formatAmount(plan.routedAmount)).toBe('1');
  });

  it('missing impact refuses the venue (incomplete_cost)', async () => {
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'no-impact', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
        venue({ id: 'ok', kind: 'external-cex', price: '101', amount: '10', feeBps: 0 }),
      ],
      {
        costTermsByVenue: {
          'no-impact': completeTerms({ expectedImpactBps: null }),
          ok: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );

    expect(plan.legs[0]?.venueId).toBe('ok');
    expect(plan.rejected.find((r) => r.venueId === 'no-impact')?.reason).toBe('incomplete_cost');
  });

  it('missing fee / transfer refuse with incomplete_cost', async () => {
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'no-fee', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
        venue({ id: 'no-xfer', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
        venue({ id: 'ok', kind: 'external-cex', price: '110', amount: '10', feeBps: 0 }),
      ],
      {
        costTermsByVenue: {
          'no-fee': completeTerms({ feeBps: null }),
          'no-xfer': completeTerms({ transferCostBps: null }),
          ok: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );

    expect(plan.legs[0]?.venueId).toBe('ok');
    expect(plan.rejected.find((r) => r.venueId === 'no-fee')?.reason).toBe('incomplete_cost');
    expect(plan.rejected.find((r) => r.venueId === 'no-xfer')?.reason).toBe('incomplete_cost');
  });

  it('venue absent from costTermsByVenue is refused, not zero-filled', async () => {
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'forgotten', kind: 'external-cex', price: '1', amount: '10', feeBps: 0 }),
        venue({ id: 'ok', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
      ],
      {
        costTermsByVenue: {
          ok: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );

    expect(plan.legs[0]?.venueId).toBe('ok');
    expect(plan.rejected.find((r) => r.venueId === 'forgotten')?.reason).toBe('incomplete_cost');
  });

  it('all-incomplete / all-unscored → zero routedAmount', async () => {
    const plan = await planRoute(buy('1'), [venue({ id: 'a', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 })], {
      costTermsByVenue: {
        a: completeTerms({ latencyGrade: ungraded() }),
      },
    });

    expect(plan.legs).toHaveLength(0);
    expect(formatAmount(plan.routedAmount)).toBe('0');
    expect(plan.rejected[0]?.reason).toBe('zero_weight');
  });

  it('no structural house preference beyond the accepted 5 bps tie-break', async () => {
    // Internal is 50 bps dearer on all-in — must lose (thumb is only 5 bps).
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'external', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
        venue({ id: 'internal', kind: 'internal', price: '100.5', amount: '10', feeBps: 0 }),
      ],
      {
        costTermsByVenue: {
          external: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
          internal: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );

    expect(plan.legs[0]?.venueId).toBe('external');
  });

  it('internal still wins an exact all-in tie under the disclosed 5 bps preference', async () => {
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'external', kind: 'external-cex', price: '100', amount: '10', feeBps: 0 }),
        venue({ id: 'internal', kind: 'internal', price: '100', amount: '10', feeBps: 0 }),
      ],
      {
        costTermsByVenue: {
          external: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
          internal: completeTerms({ feeBps: 0, expectedImpactBps: 0, transferCostBps: 0 }),
        },
      },
    );

    expect(plan.legs[0]?.venueId).toBe('internal');
  });
});
