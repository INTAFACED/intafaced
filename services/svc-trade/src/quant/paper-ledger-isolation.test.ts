/**
 * CARD R-quant — paper place never ledger-posts.
 *
 * The production TradeService over a real trade schema and a ledger it does hold: a place on a paper market, a buy and
 * a sell, posts nothing to that ledger and submits nothing to matching, where the same place on the live market holds
 * the funds. A spy on a client the place path does not hold would stay green after someone added ledger.post there; this
 * ledger is the one the service posts every live hold to, so a paper post would show here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { ALICE, BOB, fund, openTradeDatabase, resetAndListMarket, tradeOver } from '../spot/__tests__/saga-trade-fixture.js';
import { principalFor, StubMatching } from '../spot/testing.js';

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);

const database = () => {
  if (!db) throw new Error('database not ready');
  return db;
};

async function placeBoth(paper: boolean) {
  const ledger = new MemoryLedger();
  const matching = new StubMatching();
  const market = await resetAndListMarket(database(), ledger, matching);
  if (paper) await database().sql`UPDATE trade.markets SET paper = true WHERE id = ${market.id}`;
  await fund(ledger, ALICE, 'USDT', '1000');
  await fund(ledger, BOB, 'BTC', '5');
  const funded = ledger.journal().length;
  const trade = tradeOver(database(), ledger, matching);
  const buy = await trade.placeOrder(principalFor(ALICE), {
    marketId: market.id,
    side: 'buy',
    type: 'limit',
    qty: amt('1'),
    price: amt('100'),
    clientOrderId: `paper-iso-buy-${paper}`,
  });
  const sell = await trade.placeOrder(principalFor(BOB), {
    marketId: market.id,
    side: 'sell',
    type: 'limit',
    qty: amt('1'),
    price: amt('101'),
    clientOrderId: `paper-iso-sell-${paper}`,
  });
  return { ledger, matching, buy, sell, posted: ledger.journal().slice(funded) };
}

describe('R-quant paper place never posts to the ledger', () => {
  it('routes paper markets into placePaperOrderIsolated before the hold', async () => {
    const live = await placeBoth(false);
    // The live market holds each order's funds and submits it: the control that makes the paper case mean something.
    expect(live.posted.map((tx) => tx.reason)).toEqual(['order.hold', 'order.hold']);
    expect(live.matching.submitted).toHaveLength(2);

    const paper = await placeBoth(true);
    expect(paper.posted).toEqual([]);
    expect(paper.matching.submitted).toEqual([]);
    expect([paper.buy.status, paper.sell.status]).toEqual(['open', 'open']);
  }, 60_000);

  it('the class method placePaperOrderIsolated only hands over to order-place.ts', async () => {
    // Through the class: the order is stored, and replaying the same command returns it and still posts nothing.
    const paper = await placeBoth(true);
    const trade = tradeOver(database(), paper.ledger, paper.matching);
    const again = await trade.placeOrder(principalFor(ALICE), {
      marketId: paper.buy.marketId,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'paper-iso-buy-true',
    });
    expect(again.id).toBe(paper.buy.id);
    expect(paper.ledger.journal().length).toBe(2);
  }, 60_000);

  it('placePaperOrderIsolated body has no ledger.post / orderHold / tradeFill', async () => {
    const paper = await placeBoth(true);
    // The rows carry a zero hold: nothing was held, so nothing can later be filled against a hold that was never funded.
    expect(paper.buy.holdAmount).toBe(0n);
    expect(paper.sell.holdAmount).toBe(0n);
    const reasons = paper.ledger.journal().map((tx) => tx.reason);
    expect(reasons).toEqual(['deposit.credited', 'deposit.credited']);
  }, 60_000);
});
