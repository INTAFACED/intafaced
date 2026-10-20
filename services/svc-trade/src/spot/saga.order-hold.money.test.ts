/**
 * SAGATEST for svc-trade's spot order place: `orderHold` posted before the engine sees the order.
 * `describeMoneyDoor` replays it as a duplicate request, a lost acknowledgement on the hold post, and a crash before or
 * after it, and requires the book of one clean run every time (one `order.hold:<orderId>` post, once).
 *
 * The caller retries `placeOrder` with the same client order id, then the hold-unknown sweep runs, because that sweep is
 * the designed recovery for a hold that was booked while the caller never heard back. The database and the matching
 * engine survive a crash, as they would for real.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { TradeError } from './types.js';
import type { TestDatabase } from '@intafaced/db';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, orderHoldAccount, parseAmount as amt } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from '../ledger-client.js';
import { principalFor, StubMatching } from './testing.js';
import { orderIdFor } from './ids.js';
import {
  ALICE,
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

const ORDER_ID = orderIdFor(ALICE, MARKET_ID, 'saga-place-1');
let matching = new StubMatching();

const placeOrder: MoneyDoorScenario = {
  name: 'svc-trade spot order place (orderHold, then engine submit)',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    matching = new StubMatching();
    await resetAndListMarket(database(), ledger, matching);
    await fund(ledger, ALICE, 'USDT', '1000');
  },
  async run(fetchImpl) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const trade = tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching);
      try {
        await trade.placeOrder(principalFor(ALICE), {
          marketId: MARKET_ID,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'saga-place-1',
        });
      } finally {
        // The sweep is the recovery for a hold that was booked while the caller never heard back.
        await trade.sweepHoldUnknown();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  },
  async invariant(ledger) {
    // The hold funds exactly this order, the order is live at the engine once, and nothing is left half-done.
    expect((await ledger.balance(orderHoldAccount(ALICE, 'USDT', ORDER_ID))).amount).toBe(amt('200'));
    const rows = await database().sql<Array<{ status: string }>>`SELECT status FROM trade.orders`;
    expect(rows.map((r) => r.status)).toEqual(['open']);
    expect(matching.submitted.map((s) => s.request.orderId)).toEqual([ORDER_ID]);
  },
};

describeMoneyDoor(placeOrder, () => new MemoryLedger());

/**
 * The same door when the first attempt hears nothing back at all: the ledger books the hold, every answer is lost, and
 * the read-back by key fails too, so the order is parked as `hold_unknown` with the hold already booked. Only the
 * sweep (or a retry) may finish it, and it must do so without a second hold and without losing the one that is booked.
 * The harness then breaks the later attempts on top of this, as it does for the scenario above.
 */
let firstAttemptDone = false;

/** Books every post and then fails the answer; fails every read. The ledger saw the hold, the caller did not. */
function deafLedger(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path !== '/trpc/post') throw new TypeError('fetch failed');
    await inner(input, init);
    throw new TypeError('fetch failed');
  }) as typeof fetch;
}

const placeOrderUnheard: MoneyDoorScenario = {
  ...placeOrder,
  name: 'svc-trade spot order place, first answer never heard (hold_unknown, then sweep)',
  async setup(ledger) {
    firstAttemptDone = false;
    await placeOrder.setup(ledger);
  },
  async run(fetchImpl) {
    if (firstAttemptDone) return placeOrder.run(fetchImpl);
    firstAttemptDone = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = deafLedger(fetchImpl);
    try {
      const trade = tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching);
      await trade
        .placeOrder(principalFor(ALICE), {
          marketId: MARKET_ID,
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('100'),
          clientOrderId: 'saga-place-1',
        })
        .then(
          () => {
            throw new Error('the order must not be reported placed while the hold outcome is unknown');
          },
          (err: unknown) => {
            if (!(err instanceof TradeError) || err.code !== 'trade.hold_unknown') throw err;
          },
        );
    } finally {
      globalThis.fetch = realFetch;
    }
    // The caller timed out and does not retry here; the sweep alone must recover the booked hold.
    globalThis.fetch = fetchImpl;
    try {
      await tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching).sweepHoldUnknown();
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};

describeMoneyDoor(placeOrderUnheard, () => new MemoryLedger());
