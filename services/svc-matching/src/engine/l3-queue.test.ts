import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal } from './journal.js';
import type { EngineOrder, OrderSide } from './types.js';
import {
  L4_UNPUBLISHED,
  MAKER_IDENTITY_UNPUBLISHED,
  QUEUE_PROBABILITY_L2,
  QUEUE_PROBABILITY_UNSET,
  installL3Queue,
  type L2Depth,
  type L3Queue,
  type L4Result,
  type PublicMakerIdentityResult,
  type QueueProbabilityInput,
  type QueueProbabilityResult,
} from './l3-queue.js';

installL3Queue();

/**
 * CARD C5 hitch. Native L3/queue is matching truth.
 * depth() is L2 aggregates and is not labeled L3.
 * Queue-probability from L2 refuses. L4 / public maker identity unpublished refuse.
 */

const MARKET = 'BTC/USDT';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

type L3Engine = MatchingEngine & {
  l3Queue(marketId: string): L3Queue;
  l2Depth(marketId: string, n?: number): L2Depth;
  queueProbability(input: QueueProbabilityInput): QueueProbabilityResult;
  publicMakerIdentity(marketId: string): PublicMakerIdentityResult;
  l4(marketId: string): L4Result;
};

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: parseAmount(spec.price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 }) as L3Engine;
  return { journal, bus, engine };
}

describe('native L3/queue is matching truth — never call L2 L3', () => {
  it('two rests at the same price list both orderIds in sequence order as L3 decimal remaining', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: FIRST, account: 'maker-a', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ id: SECOND, account: 'maker-b', side: 'sell', qty: '2', price: '100' }));

    const l3 = engine.l3Queue(MARKET);
    expect(l3.level).toBe('L3');
    expect(l3.marketId).toBe(MARKET);
    expect(l3.asks).toHaveLength(1);
    expect(l3.asks[0]!.price).toBe('100');
    expect(l3.asks[0]!.orders.map((row) => row.orderId)).toEqual([FIRST, SECOND]);
    expect(l3.asks[0]!.orders[0]!.remaining).toBe('1');
    expect(l3.asks[0]!.orders[1]!.remaining).toBe('2');
    expect(l3.asks[0]!.orders[0]!.sequence).toBeLessThan(l3.asks[0]!.orders[1]!.sequence);
    expect(l3.asks[0]!.orders[0]!).not.toHaveProperty('accountId');
    expect(l3.asks[0]!.orders[1]!).not.toHaveProperty('accountId');
  });

  it('carries the book sequence the queue was read at, the same number /depth answers', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: FIRST, account: 'maker-a', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ id: SECOND, account: 'maker-b', side: 'sell', qty: '2', price: '100' }));
    const l3 = engine.l3Queue(MARKET);
    const depth = engine.book(MARKET).depth(1) as { sequence: number };
    expect(l3.sequence).toBe(depth.sequence);
    expect(l3.sequence).toBeGreaterThanOrEqual(l3.asks[0]!.orders[1]!.sequence);
  });

  it('book.depth / l2 is aggregated size and is not labeled L3', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: FIRST, account: 'maker-a', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ id: SECOND, account: 'maker-b', side: 'sell', qty: '2', price: '100' }));

    const depth = engine.book(MARKET).depth(50);
    expect(depth.asks).toEqual([['100', '3']]);
    expect(depth).not.toHaveProperty('level');
    expect((depth as { level?: string }).level).not.toBe('L3');

    const l2 = engine.l2Depth(MARKET, 50);
    expect(l2.level).toBe('L2');
    expect(l2.asks).toEqual([['100', '3']]);

    const l3 = engine.l3Queue(MARKET);
    expect(l3.level).toBe('L3');
    expect(l3).not.toEqual(depth);
    expect(l3.asks[0]!).toHaveProperty('orders');
    expect(Array.isArray(l2.asks[0])).toBe(true);
    expect(l2.asks[0]).not.toHaveProperty('orders');
  });

  it('queueProbability from L2-only aggregates refuses queue_probability_l2 and invents no percent', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: FIRST, account: 'maker-a', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ id: SECOND, account: 'maker-b', side: 'sell', qty: '2', price: '100' }));

    const refused = engine.queueProbability({ bids: [], asks: [['100', '3']] });
    expect(refused.accepted).toBe(false);
    expect(refused.rejected.code).toBe(QUEUE_PROBABILITY_L2);
    expect(refused).not.toHaveProperty('probability');
    expect((refused as { probability?: number }).probability).toBeUndefined();

    const fromL2 = engine.queueProbability(engine.l2Depth(MARKET, 50));
    expect(fromL2.rejected.code).toBe(QUEUE_PROBABILITY_L2);
    expect(fromL2).not.toHaveProperty('probability');
  });

  it('queueProbability from native L3 queue refuses queue_probability_unset rather than inventing a fill %', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: FIRST, account: 'maker-a', side: 'sell', qty: '1', price: '100' }));
    await engine.submit(MARKET, order({ id: SECOND, account: 'maker-b', side: 'sell', qty: '2', price: '100' }));

    const refused = engine.queueProbability(engine.l3Queue(MARKET));
    expect(refused.accepted).toBe(false);
    expect(refused.rejected.code).toBe(QUEUE_PROBABILITY_UNSET);
    expect(refused).not.toHaveProperty('probability');
    expect((refused as { probability?: number }).probability).toBeUndefined();
  });

  it('publicMakerIdentity and l4 refuse unpublished; no maker accountId leaked as public identity', async () => {
    const { engine } = build();
    await engine.submit(MARKET, order({ id: FIRST, account: 'secret-maker', side: 'sell', qty: '1', price: '100' }));

    const ident = engine.publicMakerIdentity(MARKET);
    expect(ident.accepted).toBe(false);
    expect(ident.rejected.code).toBe(MAKER_IDENTITY_UNPUBLISHED);
    expect(ident.identity).toBeNull();
    expect(ident).not.toHaveProperty('accountId');
    expect(JSON.stringify(ident)).not.toContain('secret-maker');

    const unpublished = engine.l4(MARKET);
    expect(unpublished.accepted).toBe(false);
    expect(unpublished.rejected.code).toBe(L4_UNPUBLISHED);
    expect(unpublished).not.toHaveProperty('level');
    expect((unpublished as { level?: string }).level).not.toBe('L4');
    expect(JSON.stringify(unpublished)).not.toContain('secret-maker');

    const l3 = engine.l3Queue(MARKET);
    expect(JSON.stringify(l3)).not.toContain('secret-maker');
    expect(l3.asks[0]!.orders[0]!).not.toHaveProperty('accountId');
  });

  it('missing market is empty L3, not a fake book', () => {
    const { engine } = build();
    const missing = 'ETH/USDT';
    expect(engine.hasMarket(missing)).toBe(false);
    const l3 = engine.l3Queue(missing);
    expect(l3).toEqual({ level: 'L3', marketId: missing, sequence: 0, bids: [], asks: [] });
    expect(engine.hasMarket(missing)).toBe(false);
    expect(engine.markets).toEqual([]);
  });
});
