/**
 * SAGATEST for svc-trade's order cancel: the engine cancel, then `orderHoldRelease` for what the order still holds.
 * `describeMoneyDoor` replays it as a duplicate request, a lost acknowledgement on the release post, and a crash before
 * it, and requires the book of one clean run every time: the whole hold released once, none left stranded.
 *
 * The order is placed in setup (hold booked, resting at the engine). The database and the engine survive a crash.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, orderHoldAccount, parseAmount as amt } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from '../ledger-client.js';
import { principalFor, StubMatching } from './testing.js';
import { orderIdFor } from './ids.js';
import { TradeError } from './types.js';
import {
  ALICE,
  MARKET_ID,
  SECRET,
  fund,
  openTradeDatabase,
  publishTestCreditLimits,
  resetAndListMarket,
  tradeOver,
} from './saga.trade-fixture.js';

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;
let restoreLimits: () => void = () => undefined;

beforeAll(async () => {
  restoreLimits = publishTestCreditLimits();
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);

afterAll(async () => {
  restoreLimits();
  await db?.drop();
  await stop();
}, 30_000);

const database = () => {
  if (!db) throw new Error('database not ready');
  return db;
};

const ORDER_ID = orderIdFor(ALICE, MARKET_ID, 'saga-cancel-1');
let matching = new StubMatching();

const cancelOrder: MoneyDoorScenario = {
  name: 'svc-trade order cancel (engine cancel, then orderHoldRelease)',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    matching = new StubMatching();
    await resetAndListMarket(database(), ledger, matching);
    await fund(ledger, ALICE, 'USDT', '1000');
    await tradeOver(database(), ledger, matching).placeOrder(principalFor(ALICE), {
      marketId: MARKET_ID,
      side: 'buy',
      type: 'limit',
      qty: amt('2'),
      price: amt('100'),
      clientOrderId: 'saga-cancel-1',
    });
  },
  async run(fetchImpl) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const trade = tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching);
      try {
        await trade.cancelOrder(principalFor(ALICE), ORDER_ID);
      } catch (err) {
        // A cancel of an order that is already cancelled is a typed refusal with no money effect: the caller is done.
        if (!(err instanceof TradeError) || err.code !== 'trade.order_not_open') throw err;
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  },
  async invariant(ledger) {
    // Nothing is left encumbered for the cancelled order, and the user has all of the deposit back.
    expect((await ledger.balance(orderHoldAccount(ALICE, 'USDT', ORDER_ID))).amount).toBe(0n);
    const rows = await database().sql<Array<{ status: string }>>`SELECT status FROM trade.orders`;
    expect(rows.map((r) => r.status)).toEqual(['cancelled']);
  },
};

describeMoneyDoor(cancelOrder, () => new MemoryLedger());
