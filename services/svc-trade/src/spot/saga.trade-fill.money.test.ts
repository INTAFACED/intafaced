/**
 * SAGATEST for svc-trade's fill settlement: one engine match becomes one `tradeFill` post, and the taker's unused hold
 * (it bid above the fill price) is released when the order completes. `describeMoneyDoor` replays the fill event as a
 * duplicate delivery, a lost acknowledgement on each post, and a crash after each post, and requires the book of one
 * clean run every time: the fill booked once, the leftover hold released once, no hold stranded.
 *
 * `settleFillEvent` is the recovery path for a fill the process died before settling, so a redelivered event is the
 * natural retry. Both orders rest in setup. The database and the engine survive a crash.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, orderHoldAccount, parseAmount as amt } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from '../ledger-client.js';
import { principalFor, StubMatching } from './testing.js';
import { orderIdFor } from './ids.js';
import {
  ALICE,
  BOB,
  MARKET_ID,
  SECRET,
  fund,
  openTradeDatabase,
  publishTestCreditLimits,
  resetAndListMarket,
  tradeOver,
} from './saga-trade-fixture-test.js';

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

const MAKER_ID = orderIdFor(BOB, MARKET_ID, 'saga-fill-maker');
const TAKER_ID = orderIdFor(ALICE, MARKET_ID, 'saga-fill-taker');
let matching = new StubMatching();

const settleFill: MoneyDoorScenario = {
  name: 'svc-trade fill settlement (tradeFill, then leftover hold release)',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    matching = new StubMatching();
    await resetAndListMarket(database(), ledger, matching);
    await fund(ledger, BOB, 'BTC', '5');
    await fund(ledger, ALICE, 'USDT', '1000');
    const direct = tradeOver(database(), ledger, matching);
    await direct.placeOrder(principalFor(BOB), {
      marketId: MARKET_ID,
      side: 'sell',
      type: 'limit',
      qty: amt('2'),
      price: amt('100'),
      clientOrderId: 'saga-fill-maker',
    });
    // Bids 101, so the fill at 100 leaves 2 USDT of its hold unused for the release.
    await direct.placeOrder(principalFor(ALICE), {
      marketId: MARKET_ID,
      side: 'buy',
      type: 'limit',
      qty: amt('2'),
      price: amt('101'),
      clientOrderId: 'saga-fill-taker',
    });
  },
  async run(fetchImpl) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const trade = tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching);
      await trade.settleFillEvent({
        marketId: MARKET_ID,
        makerOrderId: MAKER_ID,
        takerOrderId: TAKER_ID,
        price: '100',
        qty: '2',
        sequence: 1,
        makerAccountId: BOB,
        takerAccountId: ALICE,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  },
  async invariant(ledger) {
    // Both orders are complete and neither hold is stranded; the fill is recorded once per side.
    expect((await ledger.balance(orderHoldAccount(ALICE, 'USDT', TAKER_ID))).amount).toBe(0n);
    expect((await ledger.balance(orderHoldAccount(BOB, 'BTC', MAKER_ID))).amount).toBe(0n);
    const orders = await database().sql<Array<{ id: string; status: string }>>`SELECT id, status FROM trade.orders ORDER BY id`;
    expect(orders.map((r) => r.status)).toEqual(['filled', 'filled']);
    expect(await database().sql`SELECT id FROM trade.fills`).toHaveLength(2);
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
  },
};

describeMoneyDoor(settleFill, () => new MemoryLedger());
