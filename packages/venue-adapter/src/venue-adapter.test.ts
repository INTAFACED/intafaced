import { describe, expect, it } from 'vitest';
import { parseAmount as amt, formatAmount } from '@intafaced/ledger-client';
import type { OrderBook } from '@intafaced/exchange-contract';
import type { LiquiditySource, QuoteRequest, VenueHealth } from './source.js';
import { isRoutable } from './source.js';
import {
  planRoute,
  effectivePrice,
  priceDriftBps,
  explainRoute,
  ACCEPTED_INTERNAL_PREFERENCE_BPS,
  capInternalPreferenceBps,
} from './router.js';
import { consolidateBook, topOfBook, isCrossed, sweepCost } from './consolidated-book.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

interface FakeOpts {
  id: string;
  kind: LiquiditySource['kind'];
  price: string;
  amount: string;
  feeBps: number;
  healthy?: boolean;
  latencyMs?: number;
  ageMs?: number;
  book?: { bids: Array<[string, string]>; asks: Array<[string, string]> };
  throws?: boolean;
}

function venue(o: FakeOpts): LiquiditySource {
  const now = Date.now();
  const health: VenueHealth = {
    healthy: o.healthy ?? true,
    latencyMs: o.latencyMs ?? 10,
    lastUpdate: new Date(now - (o.ageMs ?? 0)),
  };

  return {
    id: o.id,
    kind: o.kind,
    capabilities: ['quote', 'orderbook', 'submit'],
    health: () => health,
    markets: async () => [],
    quote: async (req: QuoteRequest) => {
      if (o.throws) throw new Error('venue exploded');
      return {
        venueId: o.id,
        symbol: req.symbol,
        side: req.side,
        amount: amt(o.amount),
        price: amt(o.price),
        feeBps: o.feeBps,
        expiresAt: new Date(now + 30_000),
      };
    },
    orderBook: async (symbol: string): Promise<OrderBook> => {
      if (o.throws) throw new Error('venue exploded');
      return {
        symbol,
        bids: o.book?.bids ?? [[o.price, o.amount]],
        asks: o.book?.asks ?? [[o.price, o.amount]],
        timestamp: now,
        datetime: new Date(now).toISOString(),
        nonce: 1,
      };
    },
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

// ── Effective pricing ────────────────────────────────────────────────────────

describe('effective price — what the user actually pays', () => {
  it('adds the fee when buying', () => {
    expect(formatAmount(effectivePrice(amt('100'), 10, 'buy'))).toBe('100.1');
  });

  it('subtracts the fee when selling', () => {
    expect(formatAmount(effectivePrice(amt('100'), 10, 'sell'))).toBe('99.9');
  });

  it('rounds the fee against the user, never in their favour', () => {
    // An estimate that under-promises is fine; one that over-promises is a lie.
    const e = effectivePrice(amt('0.000000000000000001'), 1, 'buy');
    expect(formatAmount(e)).toBe('0.000000000000000002');
  });

  it('makes a cheap-looking venue with high fees lose to a dearer one with low fees', () => {
    const cheapButExpensive = effectivePrice(amt('100'), 50, 'buy'); // 100.5
    const dearButCheap = effectivePrice(amt('100.2'), 5, 'buy'); // 100.2501
    expect(dearButCheap).toBeLessThan(cheapButExpensive);
  });
});

describe('priceDriftBps', () => {
  it('measures how much worse a price is', () => {
    expect(priceDriftBps(amt('100'), amt('101'), 'buy')).toBe(100);
    expect(priceDriftBps(amt('100'), amt('99'), 'sell')).toBe(100);
  });

  it('reports zero when the price is better or equal', () => {
    expect(priceDriftBps(amt('100'), amt('99'), 'buy')).toBe(0);
    expect(priceDriftBps(amt('100'), amt('100'), 'buy')).toBe(0);
  });

  it('a zero reference does not let a later price through', () => {
    // Slippage keeps a leg only when drift is within maxSlippageBps. Returning 0
    // for a zero reference made every later price look no worse, including a
    // sell measured against a best effective of 0. The cap here is the largest
    // finite limit the router will honour.
    const maxSlippageBps = Number.MAX_VALUE;
    expect(priceDriftBps(amt('0'), amt('100'), 'sell')).toBeGreaterThan(maxSlippageBps);
    expect(priceDriftBps(amt('0'), amt('50'), 'sell')).toBeGreaterThan(maxSlippageBps);
    expect(priceDriftBps(amt('0'), amt('100'), 'buy')).toBeGreaterThan(maxSlippageBps);
    expect(priceDriftBps(amt('0'), amt('0'), 'sell')).toBeGreaterThan(maxSlippageBps);
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe('smart order router', () => {
  it('routes to the cheapest effective price', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 10 }),
      venue({ id: 'kraken', kind: 'external-cex', price: '89900', amount: '10', feeBps: 10 }),
    ]);

    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]?.venueId).toBe('kraken');
    expect(formatAmount(plan.routedAmount)).toBe('1');
  });

  it('splits across venues when one cannot fill it alone', async () => {
    const plan = await planRoute(buy('10'), [
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '3', feeBps: 10 }),
      venue({ id: 'binance', kind: 'external-cex', price: '90010', amount: '4', feeBps: 10 }),
      venue({ id: 'kraken', kind: 'external-cex', price: '90020', amount: '5', feeBps: 10 }),
    ]);

    expect(plan.legs).toHaveLength(3);
    expect(plan.legs.map((l) => l.venueId)).toEqual(['internal', 'binance', 'kraken']);
    expect(plan.legs.map((l) => formatAmount(l.amount))).toEqual(['3', '4', '3']);
    expect(formatAmount(plan.routedAmount)).toBe('10');
    expect(formatAmount(plan.unfilledAmount)).toBe('0');
  });

  it('reports what it could not fill instead of pretending', async () => {
    const plan = await planRoute(buy('100'), [venue({ id: 'internal', kind: 'internal', price: '90000', amount: '2', feeBps: 10 })]);

    expect(formatAmount(plan.routedAmount)).toBe('2');
    expect(formatAmount(plan.unfilledAmount)).toBe('98');
  });

  it('prices the whole route as a quantity-weighted average', async () => {
    // Slippage tolerance widened so this test isolates the averaging maths —
    // the guard has its own test below.
    const plan = await planRoute(
      buy('2'),
      [
        venue({ id: 'a', kind: 'external-cex', price: '100', amount: '1', feeBps: 0 }),
        venue({ id: 'b', kind: 'external-cex', price: '102', amount: '1', feeBps: 0 }),
      ],
      { maxSlippageBps: 1000 },
    );

    expect(plan.averageEffectivePrice).not.toBeNull();
    expect(formatAmount(plan.averageEffectivePrice!)).toBe('101');
    expect(formatAmount(plan.totalCost)).toBe('202');
  });

  it('reports the cost of splitting versus the single best venue', async () => {
    const plan = await planRoute(
      buy('2'),
      [
        venue({ id: 'a', kind: 'external-cex', price: '100', amount: '1', feeBps: 0 }),
        venue({ id: 'b', kind: 'external-cex', price: '102', amount: '1', feeBps: 0 }),
      ],
      { maxSlippageBps: 1000 },
    );

    // Averaging 101 against a best price of 100 is 100 bps worse — reported as
    // a negative improvement rather than quietly omitted.
    expect(plan.improvementBps).toBe(-100);
  });
});

describe('internal-first preference', () => {
  it('wins an exact tie', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 10 }),
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '10', feeBps: 10 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('internal');
  });

  it('wins when it is worse by less than the preference', async () => {
    // internal is 2 bps dearer; preference is 5 bps.
    const plan = await planRoute(buy('1'), [
      venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 0 }),
      venue({ id: 'internal', kind: 'internal', price: '90018', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('internal');
  });

  it('LOSES when it is genuinely worse — the thumb is bounded', async () => {
    // internal is 50 bps dearer; preference is 5 bps. The user gets the better price.
    const plan = await planRoute(buy('1'), [
      venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 0 }),
      venue({ id: 'internal', kind: 'internal', price: '90450', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('binance');
  });

  it('never distorts the effective price it reports', async () => {
    const plan = await planRoute(buy('1'), [venue({ id: 'internal', kind: 'internal', price: '100', amount: '10', feeBps: 10 })]);
    // Reported price is the TRUE 100 + 10bps, not the preference-adjusted one.
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('100.1');
  });

  it('can be switched off entirely', async () => {
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 0 }),
        venue({ id: 'internal', kind: 'internal', price: '90018', amount: '10', feeBps: 0 }),
      ],
      { internalPreferenceBps: 0 },
    );
    expect(plan.legs[0]?.venueId).toBe('binance');
  });

  it('applies on the sell side symmetrically', async () => {
    const plan = await planRoute(sell('1'), [
      venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 0 }),
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('internal');
  });
});

describe('D26-P2-06 one-book 5bps cap — D-S-06 residual', () => {
  it('defaults internalPreferenceBps to the accepted 5 bps', () => {
    expect(ACCEPTED_INTERNAL_PREFERENCE_BPS).toBe(5);
    expect(capInternalPreferenceBps()).toBe(5);
    expect(capInternalPreferenceBps(undefined)).toBe(5);
  });

  it('cannot silently raise the house thumb above 5 bps', async () => {
    expect(capInternalPreferenceBps(500)).toBe(5);
    expect(capInternalPreferenceBps(Number.POSITIVE_INFINITY)).toBe(5);
    // Internal is 10 bps dearer. An uncapped 10_000 bps thumb would hide that.
    // The cap keeps the accepted 5 bps, so the worse internal book still loses.
    const plan = await planRoute(
      buy('1'),
      [
        venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 0 }),
        venue({ id: 'internal', kind: 'internal', price: '90090', amount: '10', feeBps: 0 }),
      ],
      { internalPreferenceBps: 10_000 },
    );
    expect(plan.legs[0]?.venueId).toBe('binance');
  });

  it('a worse internal book still loses under the default 5 bps', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'binance', kind: 'external-cex', price: '90000', amount: '10', feeBps: 0 }),
      venue({ id: 'internal', kind: 'internal', price: '90450', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('binance');
  });

  it('ranks internal vs external through one LiquiditySource interface', async () => {
    const internal = venue({ id: 'book', kind: 'internal', price: '90100', amount: '10', feeBps: 0 });
    const dex = venue({ id: 'pool', kind: 'external-dex', price: '90000', amount: '10', feeBps: 0 });
    const amm = venue({ id: 'amm', kind: 'amm', price: '90050', amount: '10', feeBps: 0 });

    const plan = await planRoute(buy('1'), [internal, dex, amm]);

    expect(plan.legs[0]?.venueId).toBe('pool');
    expect(plan.legs[0]?.kind).toBe(dex.kind);
    expect(internal.quote).toBeTypeOf('function');
    expect(dex.quote).toBeTypeOf('function');
    expect(amm.quote).toBeTypeOf('function');
    // Preference follows kind on the shared interface, not a parallel internal ranker.
    const swapped = await planRoute(buy('1'), [
      venue({ id: 'book', kind: 'external-cex', price: '90100', amount: '10', feeBps: 0 }),
      venue({ id: 'pool', kind: 'internal', price: '90000', amount: '10', feeBps: 0 }),
    ]);
    expect(swapped.legs[0]?.venueId).toBe('pool');
    expect(swapped.legs[0]?.kind).toBe('internal');
  });
});

describe('venue exclusion — the failures that cost money', () => {
  it('excludes an unhealthy venue', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'down', kind: 'external-cex', price: '1', amount: '10', feeBps: 0, healthy: false }),
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('internal');
    expect(plan.rejected.find((r) => r.venueId === 'down')?.reason).toBe('unhealthy');
  });

  it('excludes a stale venue even though it still answers', async () => {
    // The dangerous case: it quotes an unbeatable price from 30 seconds ago.
    const plan = await planRoute(buy('1'), [
      venue({ id: 'frozen', kind: 'external-cex', price: '1', amount: '10', feeBps: 0, ageMs: 30_000 }),
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('internal');
    expect(plan.rejected.find((r) => r.venueId === 'frozen')?.reason).toBe('stale');
  });

  it('routes around a venue that throws', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'broken', kind: 'external-cex', price: '1', amount: '10', feeBps: 0, throws: true }),
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs[0]?.venueId).toBe('internal');
    expect(plan.rejected.find((r) => r.venueId === 'broken')?.reason).toBe('no_quote');
  });

  it('refuses a zero-price quote as no_quote — 0 is not a fillable price', async () => {
    const plan = await planRoute(buy('1'), [venue({ id: 'free', kind: 'external-cex', price: '0', amount: '1', feeBps: 0 })]);
    expect(plan.legs).toHaveLength(0);
    expect(plan.rejected.find((r) => r.venueId === 'free')?.reason).toBe('no_quote');
  });

  it('refuses a negative-price quote as no_quote', async () => {
    const plan = await planRoute(buy('1'), [venue({ id: 'neg', kind: 'external-cex', price: '-1', amount: '1', feeBps: 0 })]);
    expect(plan.legs).toHaveLength(0);
    expect(plan.rejected.find((r) => r.venueId === 'neg')?.reason).toBe('no_quote');
  });

  it('refuses a sell whose fee consumes the price — 10000 bps is 100%', async () => {
    const plan = await planRoute(sell('1'), [
      venue({ id: 'consumed', kind: 'external-cex', price: '100', amount: '1', feeBps: 10_000 }),
      venue({ id: 'live', kind: 'external-cex', price: '100', amount: '1', feeBps: 10 }),
    ]);
    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['live']);
    expect(plan.rejected.find((r) => r.venueId === 'consumed')?.reason).toBe('no_quote');
    expect(plan.routedAmount > 0n).toBe(true);
    expect(plan.averageEffectivePrice).not.toBeNull();
    expect(plan.averageEffectivePrice! > 0n).toBe(true);
    expect(formatAmount(plan.averageEffectivePrice!)).toBe('99.9');
  });

  it('refuses a sell at a 100% fee and leaves an empty plan average null', async () => {
    const plan = await planRoute(sell('1'), [
      venue({ id: 'consumed', kind: 'external-cex', price: '100', amount: '1', feeBps: 10_000 }),
    ]);
    expect(plan.legs).toHaveLength(0);
    expect(plan.routedAmount).toBe(0n);
    expect(plan.averageEffectivePrice).toBeNull();
    expect(plan.rejected.find((r) => r.venueId === 'consumed')?.reason).toBe('no_quote');
  });

  it('routes a sell whose fee stays under 100%', async () => {
    // 9999 bps of 100 is 99.99, so the seller still receives 0.01.
    const plan = await planRoute(sell('1'), [
      venue({ id: 'thin', kind: 'external-cex', price: '100', amount: '1', feeBps: 9_999 }),
    ]);
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]?.venueId).toBe('thin');
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('0.01');
    expect(plan.routedAmount > 0n).toBe(true);
    expect(formatAmount(plan.averageEffectivePrice!)).toBe('0.01');
  });

  it('refuses a sell whose sub-wei notional rounds the average to zero', async () => {
    // effectivePrice is 0.01, but mul half-up of that price times 1 wei is 0.
    const plan = await planRoute(sell('0.000000000000000001'), [
      venue({ id: 'dust', kind: 'external-cex', price: '100', amount: '0.000000000000000001', feeBps: 9_999 }),
    ]);
    expect(plan.legs).toHaveLength(0);
    expect(plan.routedAmount).toBe(0n);
    expect(plan.averageEffectivePrice).toBeNull();
    expect(plan.rejected.find((r) => r.venueId === 'dust')?.reason).toBe('no_quote');
  });

  it('refuses a sell at a 1-wei price when the size rounds the average to zero', async () => {
    const plan = await planRoute(sell('0.4'), [
      venue({ id: 'wei', kind: 'external-cex', price: '0.000000000000000001', amount: '0.4', feeBps: 0 }),
    ]);
    expect(plan.legs).toHaveLength(0);
    expect(plan.routedAmount).toBe(0n);
    expect(plan.averageEffectivePrice).toBeNull();
    expect(plan.rejected.find((r) => r.venueId === 'wei')?.reason).toBe('no_quote');
  });

  it('routes a size-1 sell at a 1-wei price when the fee stays under 100%', async () => {
    const plan = await planRoute(sell('1'), [
      venue({ id: 'wei', kind: 'external-cex', price: '0.000000000000000001', amount: '1', feeBps: 0 }),
    ]);
    expect(plan.legs).toHaveLength(1);
    expect(plan.routedAmount > 0n).toBe(true);
    expect(plan.averageEffectivePrice).not.toBeNull();
    expect(plan.averageEffectivePrice! > 0n).toBe(true);
  });

  it('routes that size-1 sell when the better quote is refused for a zero average', async () => {
    // Price 0.4 ranks ahead of 1 wei on a sell, but its 1-wei size rounds the
    // average to zero. That refusal is not a slippage benchmark.
    const plan = await planRoute(sell('1'), [
      venue({ id: 'dust', kind: 'external-cex', price: '0.4', amount: '0.000000000000000001', feeBps: 0 }),
      venue({ id: 'wei', kind: 'external-cex', price: '0.000000000000000001', amount: '1', feeBps: 0 }),
    ]);
    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['wei']);
    expect(plan.routedAmount > 0n).toBe(true);
    expect(plan.averageEffectivePrice).not.toBeNull();
    expect(plan.averageEffectivePrice! > 0n).toBe(true);
    expect(plan.rejected.find((r) => r.venueId === 'wei')).toBeUndefined();
    expect(plan.rejected.find((r) => r.venueId === 'dust')).toMatchObject({
      reason: 'no_quote',
      detail: 'average effective price rounds to zero',
    });
  });

  it('keeps a positive sell and refuses only the leg whose notional rounds to zero', async () => {
    const plan = await planRoute(
      sell('1.000000000000000001'),
      [
        venue({ id: 'live', kind: 'external-cex', price: '100', amount: '1', feeBps: 10 }),
        venue({ id: 'dust', kind: 'external-cex', price: '100', amount: '0.000000000000000001', feeBps: 9_999 }),
      ],
      { maxSlippageBps: 1_000_000 },
    );
    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['live']);
    expect(plan.rejected.find((r) => r.venueId === 'dust')?.reason).toBe('no_quote');
    expect(formatAmount(plan.routedAmount)).toBe('1');
    expect(formatAmount(plan.averageEffectivePrice!)).toBe('99.9');
  });

  it('routes a buy when the fee is 100% — the buyer pays more', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'dear', kind: 'external-cex', price: '100', amount: '1', feeBps: 10_000 }),
    ]);
    expect(plan.legs).toHaveLength(1);
    expect(formatAmount(plan.legs[0]!.effectivePrice)).toBe('200');
    expect(plan.routedAmount > 0n).toBe(true);
    expect(formatAmount(plan.averageEffectivePrice!)).toBe('200');
  });

  it('does not rank a free-looking zero price ahead of a real book', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'free', kind: 'external-cex', price: '0', amount: '1', feeBps: 0 }),
      venue({ id: 'real', kind: 'internal', price: '90000', amount: '10', feeBps: 0 }),
    ]);
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0]?.venueId).toBe('real');
    expect(plan.rejected.find((r) => r.venueId === 'free')?.reason).toBe('no_quote');
  });

  it('drops legs beyond the slippage tolerance rather than filling at any price', async () => {
    const plan = await planRoute(
      buy('10'),
      [
        venue({ id: 'good', kind: 'external-cex', price: '90000', amount: '1', feeBps: 0 }),
        venue({ id: 'awful', kind: 'external-cex', price: '99000', amount: '100', feeBps: 0 }),
      ],
      { maxSlippageBps: 50 },
    );

    expect(plan.legs).toHaveLength(1);
    expect(formatAmount(plan.unfilledAmount)).toBe('9');
    expect(plan.rejected.find((r) => r.venueId === 'awful')?.reason).toBe('slippage');
  });

  it('caps the number of venues in one route', async () => {
    const plan = await planRoute(
      buy('10'),
      [
        venue({ id: 'a', kind: 'external-cex', price: '100', amount: '1', feeBps: 0 }),
        venue({ id: 'b', kind: 'external-cex', price: '101', amount: '1', feeBps: 0 }),
        venue({ id: 'c', kind: 'external-cex', price: '102', amount: '1', feeBps: 0 }),
      ],
      { maxVenues: 2, maxSlippageBps: 1000 },
    );

    expect(plan.legs).toHaveLength(2);
    expect(plan.rejected.find((r) => r.venueId === 'c')?.reason).toBe('venue_cap');
  });

  it('drops a worse leg when maxSlippageBps is undefined or NaN', async () => {
    // 99000 vs 90000 is 1000 bps worse. The house default is 50 bps.
    // An explicit undefined or NaN must not replace that default: drift > NaN is false.
    const sources = [
      venue({ id: 'good', kind: 'external-cex', price: '90000', amount: '1', feeBps: 0 }),
      venue({ id: 'awful', kind: 'external-cex', price: '99000', amount: '100', feeBps: 0 }),
    ];
    for (const maxSlippageBps of [undefined, Number.NaN]) {
      const plan = await planRoute(buy('10'), sources, { maxSlippageBps });
      expect(plan.legs).toHaveLength(1);
      expect(plan.legs[0]?.venueId).toBe('good');
      expect(formatAmount(plan.unfilledAmount)).toBe('9');
      expect(plan.rejected.find((r) => r.venueId === 'awful')?.reason).toBe('slippage');
    }
  });

  it('keeps the four-venue cap when maxVenues is undefined or NaN', async () => {
    // Each step is 10 bps, so all five sit inside the 50 bps slippage default.
    // An explicit undefined or NaN must not lift the cap of 4: length >= NaN is false.
    const sources = [
      venue({ id: 'a', kind: 'external-cex', price: '100', amount: '1', feeBps: 0 }),
      venue({ id: 'b', kind: 'external-cex', price: '100.1', amount: '1', feeBps: 0 }),
      venue({ id: 'c', kind: 'external-cex', price: '100.2', amount: '1', feeBps: 0 }),
      venue({ id: 'd', kind: 'external-cex', price: '100.3', amount: '1', feeBps: 0 }),
      venue({ id: 'e', kind: 'external-cex', price: '100.4', amount: '1', feeBps: 0 }),
    ];
    for (const maxVenues of [undefined, Number.NaN]) {
      const plan = await planRoute(buy('10'), sources, { maxVenues });
      expect(plan.legs).toHaveLength(4);
      expect(plan.legs.map((leg) => leg.venueId)).toEqual(['a', 'b', 'c', 'd']);
      expect(plan.rejected.find((r) => r.venueId === 'e')?.reason).toBe('venue_cap');
    }
  });

  it('returns an empty plan when nothing is routable, without throwing', async () => {
    const plan = await planRoute(buy('1'), [
      venue({ id: 'down', kind: 'external-cex', price: '1', amount: '1', feeBps: 0, healthy: false }),
    ]);
    expect(plan.legs).toHaveLength(0);
    expect(formatAmount(plan.unfilledAmount)).toBe('1');
    expect(plan.averageEffectivePrice).toBeNull();
    expect(explainRoute(plan)).toMatch(/No route/);
  });
});

describe('isRoutable', () => {
  it('requires health and freshness together', () => {
    const now = new Date();
    expect(isRoutable(venue({ id: 'a', kind: 'internal', price: '1', amount: '1', feeBps: 0 }), now)).toBe(true);
    expect(isRoutable(venue({ id: 'b', kind: 'internal', price: '1', amount: '1', feeBps: 0, healthy: false }), now)).toBe(false);
    expect(isRoutable(venue({ id: 'c', kind: 'internal', price: '1', amount: '1', feeBps: 0, ageMs: 60_000 }), now)).toBe(false);
  });
});

// ── Consolidated book ────────────────────────────────────────────────────────

describe('consolidated book', () => {
  const a = venue({
    id: 'venue-a',
    kind: 'external-cex',
    price: '100',
    amount: '1',
    feeBps: 0,
    book: {
      bids: [
        ['99', '2'],
        ['98', '3'],
      ],
      asks: [
        ['101', '2'],
        ['102', '3'],
      ],
    },
  });

  const b = venue({
    id: 'venue-b',
    kind: 'internal',
    price: '100',
    amount: '1',
    feeBps: 0,
    book: {
      bids: [
        ['99', '5'],
        ['97', '1'],
      ],
      asks: [
        ['101', '5'],
        ['103', '1'],
      ],
    },
  });

  it('merges identical price levels and keeps attribution', async () => {
    const book = await consolidateBook('BTC/USDT', [a, b], { depth: 8 });
    const topBid = book.bids[0]!;

    expect(formatAmount(topBid.price)).toBe('99');
    expect(formatAmount(topBid.amount)).toBe('7');
    expect(topBid.sources.map((s) => s.venueId).sort()).toEqual(['venue-a', 'venue-b']);
    // Largest contributor first.
    expect(topBid.sources[0]?.venueId).toBe('venue-b');
  });

  it('sorts bids descending and asks ascending', async () => {
    const book = await consolidateBook('BTC/USDT', [a, b], { depth: 8 });
    expect(book.bids.map((l) => formatAmount(l.price))).toEqual(['99', '98', '97']);
    expect(book.asks.map((l) => formatAmount(l.price))).toEqual(['101', '102', '103']);
  });

  it('treats 100.50 and 100.5 as the same level', async () => {
    const x = venue({ id: 'x', kind: 'external-cex', price: '1', amount: '1', feeBps: 0, book: { bids: [['100.50', '1']], asks: [] } });
    const y = venue({ id: 'y', kind: 'external-cex', price: '1', amount: '1', feeBps: 0, book: { bids: [['100.5', '2']], asks: [] } });
    const book = await consolidateBook('BTC/USDT', [x, y], { depth: 8 });

    expect(book.bids).toHaveLength(1);
    expect(formatAmount(book.bids[0]!.amount)).toBe('3');
  });

  it('excludes venues that fail, and says which', async () => {
    const broken = venue({ id: 'broken', kind: 'external-cex', price: '1', amount: '1', feeBps: 0, throws: true });
    const book = await consolidateBook('BTC/USDT', [a, broken], { depth: 8 });

    expect(book.venues).toEqual(['venue-a']);
    expect(book.excluded[0]?.venueId).toBe('broken');
  });

  it('reports top of book and spread', async () => {
    const { bid, ask, spread } = topOfBook(await consolidateBook('BTC/USDT', [a, b], { depth: 8 }));
    expect(formatAmount(bid!.price)).toBe('99');
    expect(formatAmount(ask!.price)).toBe('101');
    expect(formatAmount(spread!)).toBe('2');
  });

  it('detects a crossed book — a real arbitrage, not a bug', async () => {
    const high = venue({ id: 'high', kind: 'external-cex', price: '1', amount: '1', feeBps: 0, book: { bids: [['105', '1']], asks: [] } });
    const low = venue({ id: 'low', kind: 'external-cex', price: '1', amount: '1', feeBps: 0, book: { bids: [], asks: [['100', '1']] } });

    expect(isCrossed(await consolidateBook('BTC/USDT', [high, low], { depth: 8 }))).toBe(true);
    expect(isCrossed(await consolidateBook('BTC/USDT', [a, b], { depth: 8 }))).toBe(false);
  });

  it('respects the depth limit', async () => {
    const book = await consolidateBook('BTC/USDT', [a, b], { depth: 1 });
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(1);
  });
});

describe('sweepCost', () => {
  const deep = venue({
    id: 'deep',
    kind: 'internal',
    price: '1',
    amount: '1',
    feeBps: 0,
    book: {
      bids: [],
      asks: [
        ['100', '1'],
        ['101', '1'],
        ['102', '1'],
      ],
    },
  });

  it('walks levels and averages correctly', async () => {
    const book = await consolidateBook('BTC/USDT', [deep], { depth: 8 });
    const result = sweepCost(book, 'buy', amt('2'));

    expect(formatAmount(result.filled)).toBe('2');
    expect(formatAmount(result.cost)).toBe('201');
    expect(formatAmount(result.averagePrice)).toBe('100.5');
    expect(result.levelsConsumed).toBe(2);
  });

  it('fills partially rather than inventing depth', async () => {
    const book = await consolidateBook('BTC/USDT', [deep], { depth: 8 });
    const result = sweepCost(book, 'buy', amt('10'));

    expect(formatAmount(result.filled)).toBe('3');
    expect(formatAmount(result.cost)).toBe('303');
  });

  it('handles an empty side', async () => {
    const book = await consolidateBook('BTC/USDT', [deep], { depth: 8 });
    const result = sweepCost(book, 'sell', amt('1'));
    expect(formatAmount(result.filled)).toBe('0');
    expect(() => result.averagePrice).toThrow(/no averagePrice/);
  });

  it('empty sweep does not invent averagePrice 0 — 0 would read as filled-at-zero', async () => {
    const empty = venue({
      id: 'empty',
      kind: 'internal',
      price: '1',
      amount: '1',
      feeBps: 0,
      book: { bids: [], asks: [] },
    });
    const book = await consolidateBook('BTC/USDT', [empty], { depth: 8 });
    const buySweep = sweepCost(book, 'buy', amt('1'));
    const sellSweep = sweepCost(book, 'sell', amt('1'));
    expect(buySweep.filled).toBe(0n);
    expect(() => buySweep.averagePrice).toThrow(/filled-at-zero/);
    expect(sellSweep.filled).toBe(0n);
    expect(() => sellSweep.averagePrice).toThrow(/filled-at-zero/);
  });

  it('does not fill a zero-price ask — 0 is not a price', async () => {
    const free = venue({
      id: 'free',
      kind: 'internal',
      price: '1',
      amount: '1',
      feeBps: 0,
      book: {
        bids: [],
        asks: [
          ['0', '10'],
          ['-1', '10'],
          ['100', '1'],
        ],
      },
    });
    const book = await consolidateBook('BTC/USDT', [free], { depth: 8 });
    expect(book.asks.map((l) => formatAmount(l.price))).toEqual(['100']);
    const result = sweepCost(book, 'buy', amt('1'));
    expect(formatAmount(result.filled)).toBe('1');
    expect(formatAmount(result.averagePrice)).toBe('100');
  });

  it('sweep of only zero-price levels does not invent averagePrice 0', async () => {
    const free = venue({
      id: 'free',
      kind: 'internal',
      price: '1',
      amount: '1',
      feeBps: 0,
      book: { bids: [], asks: [['0', '10']] },
    });
    const book = await consolidateBook('BTC/USDT', [free], { depth: 8 });
    const result = sweepCost(book, 'buy', amt('1'));
    expect(result.filled).toBe(0n);
    expect(() => result.averagePrice).toThrow(/filled-at-zero/);
  });
});

describe('explainRoute — what the terminal shows before you confirm', () => {
  it('names every venue, price, and fee', async () => {
    const plan = await planRoute(buy('4'), [
      venue({ id: 'internal', kind: 'internal', price: '90000', amount: '3', feeBps: 10 }),
      venue({ id: 'binance', kind: 'external-cex', price: '90010', amount: '5', feeBps: 20 }),
    ]);

    const text = explainRoute(plan);
    expect(text).toContain('internal');
    expect(text).toContain('binance');
    expect(text).toContain('2 venue(s)');
    expect(text).toContain('average');
  });
});
