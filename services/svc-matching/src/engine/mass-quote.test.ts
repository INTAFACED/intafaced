import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal } from './journal.js';
import type { EngineOrder, OrderSide } from './types.js';
import {
  QUOTE_PAIR_INCOMPLETE,
  QUOTE_PAIR_REJECTED,
  QUOTE_PAIR_REJECTED_MESSAGE,
  QUOTE_SET_MISSING,
  installMassQuote,
  type MassQuoteCommand,
  type MassQuoteResult,
} from './mass-quote.js';

installMassQuote();

/**
 * CARD E3 hitch. Mass quote API.
 * Required two-sided set: one side rejected → cancel/reject the pair. oneSided explicit.
 */

const MARKET = 'BTC/USDT';
const BID = '11111111-1111-4111-8111-111111111111';
const ASK = '22222222-2222-4222-8222-222222222222';
const SET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type QuoteEngine = MatchingEngine & {
  massQuote(cmd: MassQuoteCommand): Promise<MassQuoteResult>;
};

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string | null }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: parseAmount(spec.qty),
    price: spec.price === null ? null : parseAmount(spec.price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function build() {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0 }) as QuoteEngine;
  return { journal, bus, engine };
}

function liveIds(engine: MatchingEngine): string[] {
  return engine.restingOrders(MARKET).map((row) => row.orderId);
}

describe('mass quote — paired set, oneSided explicit, qty is Amount', () => {
  it('two-sided set, both apply → two live rests, one setId', async () => {
    const { engine } = build();
    const bid = order({ id: BID, side: 'buy', qty: '1', price: '99' });
    const ask = order({ id: ASK, side: 'sell', qty: '1', price: '101' });
    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      bid,
      ask,
    });

    expect(result.setId).toBe(SET);
    expect(result.oneSided).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((row) => row.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(result.results.map((row) => row.orderId).sort()).toEqual([ASK, BID].sort());
    expect(result.rejected).toBeUndefined();
    expect(liveIds(engine).sort()).toEqual([ASK, BID].sort());
  });

  it('two-sided set, ask rejected (invalid price) → bid cancelled, liveIds empty, pair refused', async () => {
    const { engine } = build();
    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      bid: order({ id: BID, side: 'buy', qty: '1', price: '99' }),
      ask: order({ id: ASK, side: 'sell', qty: '1', price: null }),
    });

    expect(result.setId).toBe(SET);
    expect(result.rejected?.code).toBe(QUOTE_PAIR_REJECTED);
    expect(result.results.map((row) => row.status)).toEqual(['REFUSED', 'REFUSED']);
    expect(result.results[0]!.rejected?.code).toBe(QUOTE_PAIR_REJECTED);
    expect(result.results[1]!.rejected?.code).toBe('missing_price');
    expect(liveIds(engine)).toEqual([]);
  });

  it('missing ask on two-sided → quote_pair_incomplete, nothing rests', async () => {
    const { engine } = build();
    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      bid: order({ id: BID, side: 'buy', qty: '1', price: '99' }),
    });

    expect(result.rejected?.code).toBe(QUOTE_PAIR_INCOMPLETE);
    expect(result.results.every((row) => row.status === 'REFUSED')).toBe(true);
    expect(result.results.every((row) => row.rejected?.code === QUOTE_PAIR_INCOMPLETE)).toBe(true);
    expect(liveIds(engine)).toEqual([]);
  });

  it('oneSided:true with only bid → bid rests, no invented ask', async () => {
    const { engine } = build();
    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      oneSided: true,
      bid: order({ id: BID, side: 'buy', qty: '1', price: '99' }),
    });

    expect(result.setId).toBe(SET);
    expect(result.oneSided).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ side: 'bid', status: 'APPLIED', orderId: BID });
    expect(result.rejected).toBeUndefined();
    expect(liveIds(engine)).toEqual([BID]);
    expect(liveIds(engine)).not.toContain(ASK);
  });

  it('missing setId refuses both sides', async () => {
    const { engine } = build();
    const result = await engine.massQuote({
      setId: '',
      marketId: MARKET,
      accountId: 'desk',
      bid: order({ id: BID, side: 'buy', qty: '1', price: '99' }),
      ask: order({ id: ASK, side: 'sell', qty: '1', price: '101' }),
    });

    expect(result.setId).toBeNull();
    expect(result.rejected?.code).toBe(QUOTE_SET_MISSING);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((row) => row.status === 'REFUSED')).toBe(true);
    expect(result.results.every((row) => row.rejected?.code === QUOTE_SET_MISSING)).toBe(true);
    expect(liveIds(engine)).toEqual([]);
  });

  it('qty is bigint', async () => {
    const bid = order({ id: BID, side: 'buy', qty: '1', price: '99' });
    expect(typeof bid.qty).toBe('bigint');
    expect(bid.qty).toBe(parseAmount('1'));
    expect(typeof bid.qty === 'number').toBe(false);

    const { engine } = build();
    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      oneSided: true,
      bid,
    });
    expect(result.results[0]!.status).toBe('APPLIED');
    expect(typeof bid.qty).toBe('bigint');
    expect(engine.restingOrders(MARKET)[0]!.remaining).toBe('1');
  });

  it('a thrown cancel that leaves the order resting does not claim the side was unwound', async () => {
    const { engine } = build();
    const orig = engine.cancel.bind(engine);
    engine.cancel = (async (marketId, orderId) => {
      if (orderId === BID) throw new Error('cancel boom');
      return orig(marketId, orderId);
    }) as typeof engine.cancel;

    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      bid: order({ id: BID, side: 'buy', qty: '1', price: '99' }),
      ask: order({ id: ASK, side: 'sell', qty: '1', price: null }),
    });

    expect(liveIds(engine)).toEqual([BID]);
    expect(result.results[0]).toMatchObject({ side: 'bid', status: 'APPLIED', orderId: BID });
    expect(result.rejected).toBeUndefined();
    expect(result.results.every((row) => row.rejected?.message !== QUOTE_PAIR_REJECTED_MESSAGE)).toBe(true);
    expect(result.results[1]!.rejected?.code).toBe('missing_price');
  });

  it('a thrown submit that already rested the order is applied so the pair can unwind it', async () => {
    const { engine } = build();
    const orig = engine.submit.bind(engine);
    engine.submit = (async (marketId, order, proof) => {
      const result = await orig(marketId, order, proof);
      if (order.orderId === BID) throw new Error('submit boom');
      return result;
    }) as typeof engine.submit;

    const result = await engine.massQuote({
      setId: SET,
      marketId: MARKET,
      accountId: 'desk',
      bid: order({ id: BID, side: 'buy', qty: '1', price: '99' }),
      ask: order({ id: ASK, side: 'sell', qty: '1', price: null }),
    });

    expect(liveIds(engine)).toEqual([]);
    expect(result.rejected?.code).toBe(QUOTE_PAIR_REJECTED);
    expect(result.rejected?.message).toBe(QUOTE_PAIR_REJECTED_MESSAGE);
    expect(result.results[0]).toMatchObject({ side: 'bid', status: 'REFUSED', orderId: BID });
    expect(result.results[0]!.rejected?.code).toBe(QUOTE_PAIR_REJECTED);
    expect(result.results[1]!.rejected?.code).toBe('missing_price');
  });
});
