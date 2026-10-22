import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine.js';
import { MemoryJournal } from './journal.js';
import { MARKET_HALTED } from './halt.js';
import { replayOpenedMarkets } from './prelaunch.js';
import type { EngineOrder } from './types.js';

/**
 * Deadlock pin. svc-trade refuses every order unless svc-matching already lists
 * the market (`trade.matching_market_missing`), and svc-matching used to create
 * a book only from an order submit. The approved OPEN door is now what lists a
 * market. Listing is control state (journaled, replayed), not an invented book.
 */

const MARKET = 'BTC/USDT';
const OTHER = 'ETH/USDT';
const FIRST = '11111111-1111-4111-8111-111111111111';

function limit(id: string, side: 'buy' | 'sell', qty: string, price: string): EngineOrder {
  return {
    orderId: id,
    accountId: 'desk',
    type: 'limit',
    side,
    qty: parseAmount(qty),
    price: parseAmount(price),
    stopPrice: null,
    tif: 'GTC',
  };
}

function build(journal = new MemoryJournal()) {
  const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  return { journal, engine };
}

const DUAL = { operatorId: 'ops-1', confirmOperatorId: 'ops-2' } as const;

describe('approved open lists the market', () => {
  it('lists an opened market that has never taken an order, so trade can send the first one', async () => {
    const { engine } = build();
    expect(engine.markets).not.toContain(MARKET);

    const opened = await engine.open(MARKET, DUAL);

    expect(opened.accepted).toBe(true);
    expect(engine.markets).toEqual([MARKET]);
    expect(engine.isListed(MARKET)).toBe(true);
    expect(engine.isListed(OTHER)).toBe(false);
  });

  it('the listed market takes its first order, and stays listed when the empty never-traded book is dropped', async () => {
    const { engine } = build();
    await engine.open(MARKET, DUAL);

    const first = await engine.submit(MARKET, limit(FIRST, 'sell', '1', '100'));
    expect(first.accepted).toBe(true);
    expect(engine.hasMarket(MARKET)).toBe(true);

    // An IOC that cannot fill leaves an empty never-traded book: dropped.
    const { engine: other } = build();
    await other.open(MARKET, DUAL);
    await other.submit(MARKET, { ...limit(FIRST, 'buy', '1', '100'), tif: 'IOC' });
    expect(other.hasMarket(MARKET)).toBe(false);
    expect(other.markets).toEqual([MARKET]);
  });

  it('an opened market with no orders reads as an empty ladder, so its first order can be checked', async () => {
    const { engine } = build();
    expect(engine.depth(MARKET, 50)).toBeNull();

    await engine.open(MARKET, DUAL);

    expect(engine.depth(MARKET, 50)).toEqual({ bids: [], asks: [], sequence: 0 });
    expect(engine.depth(OTHER, 50)).toBeNull();
    expect(() => engine.depth(MARKET, null)).toThrow(/refuse to invent 50/);

    const first = await engine.submit(MARKET, limit(FIRST, 'buy', '1', '100'));
    expect(first.accepted).toBe(true);
    expect(engine.depth(MARKET, 50)?.bids).toEqual([['100', '1']]);
  });

  it('a delisted or expired empty market has no ladder', async () => {
    const { engine } = build();
    await engine.open(MARKET, DUAL);
    await engine.open(OTHER, DUAL);
    await engine.delist(MARKET, DUAL);
    await engine.expire(OTHER, DUAL);

    expect(engine.depth(MARKET, 50)).toBeNull();
    expect(engine.depth(OTHER, 50)).toBeNull();
  });

  it('survives a restart: a recovered engine still lists the opened empty market', async () => {
    const { journal, engine } = build();
    await engine.open(MARKET, DUAL);

    const { engine: recovered } = build(journal);
    await recovered.recover();

    expect(replayOpenedMarkets(journal.read()).has(MARKET)).toBe(true);
    expect(recovered.markets).toEqual([MARKET]);
    expect(recovered.isListed(MARKET)).toBe(true);
  });

  it('prelaunch alone does not list; open after prelaunch does', async () => {
    const { engine } = build();
    await engine.prelaunch(MARKET, DUAL);
    expect(engine.markets).not.toContain(MARKET);

    await engine.open(MARKET, DUAL);
    expect(engine.markets).toEqual([MARKET]);
  });

  it('an unapproved open (missing or same confirm operator) lists nothing and journals nothing', async () => {
    const { journal, engine } = build();

    const same = await engine.open(MARKET, { operatorId: 'ops-1', confirmOperatorId: 'ops-1' });
    const missing = await engine.open(MARKET, { operatorId: 'ops-1' });

    expect(same.accepted).toBe(false);
    expect(missing.accepted).toBe(false);
    expect(engine.markets).toEqual([]);
    expect(journal.length).toBe(0);
  });

  it('a halted opened market stays listed and still refuses as halted', async () => {
    const { engine } = build();
    await engine.open(MARKET, DUAL);
    await engine.halt(MARKET, DUAL);

    expect(engine.markets).toEqual([MARKET]);
    const refused = await engine.submit(MARKET, limit(FIRST, 'sell', '1', '100'));
    expect(refused.accepted).toBe(false);
    expect(refused.rejected?.code).toBe(MARKET_HALTED);
  });

  it('a delisted or expired empty market is not listed, before or after a restart', async () => {
    const { journal, engine } = build();
    await engine.open(MARKET, DUAL);
    await engine.open(OTHER, DUAL);
    await engine.delist(MARKET, DUAL);
    await engine.expire(OTHER, DUAL);

    expect(engine.markets).toEqual([]);

    const { engine: recovered } = build(journal);
    await recovered.recover();
    expect(recovered.markets).toEqual([]);
  });
});
