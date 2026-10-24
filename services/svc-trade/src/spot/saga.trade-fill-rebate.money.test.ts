/**
 * SAGATEST for a maker rebate (SP-fees-vip-01, J-cex-spot-10 #4): one engine match on a rebate row becomes one
 * `tradeFill` (maker fee 0) and then one `tradeFillMakerRebate` from house trade fees to the maker, in the asset the
 * maker paid. `describeMoneyDoor` replays the fill event as a duplicate delivery, a lost acknowledgement on each post,
 * and a crash after each post (between the fill and the rebate too), and requires the book of one clean run every time:
 * the fill booked once, the rebate paid once, the house keeping the rest of that fill's taker fee.
 *
 * Fill: Bob rests a sell of 2 BTC at 100, Alice takes it. Taker fee 10 bps of 2 BTC = 0.002 BTC; rebate 5 bps of the
 * 2 BTC Bob paid = 0.001 BTC; the house keeps 0.001 BTC.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, houseFees, orderHoldAccount, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from '../ledger-client.js';
import type { AffiliateFeeLeg } from './affiliate-accrue.js';
import { parseFeeScheduleJson } from './fee-schedule.js';
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
} from './__tests__/saga-trade-fixture.js';

const REBATE_SCHEDULE = parseFeeScheduleJson(
  JSON.stringify({
    published: true,
    version: 'test-rebate',
    defaultPairGroup: 'test-rebate',
    rows: [
      { pairGroup: 'test-rebate', tierId: 'regular', zeroFee: false, makerBps: '0', takerBps: '10', makerRebateBps: '5', minFee: null },
    ],
  }),
);

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

const MAKER_ID = orderIdFor(BOB, MARKET_ID, 'saga-rebate-maker');
const TAKER_ID = orderIdFor(ALICE, MARKET_ID, 'saga-rebate-taker');
let matching = new StubMatching();
/** Every fee leg the fill reported to affiliates, across this scenario's replays. */
let affiliateLegs: AffiliateFeeLeg[] = [];
const affiliateAccrue = { accrueTradeFee: async (leg: AffiliateFeeLeg) => void affiliateLegs.push(leg) };

const settleRebateFill: MoneyDoorScenario = {
  name: 'svc-trade fill on a rebate row (tradeFill, then tradeFillMakerRebate)',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    matching = new StubMatching();
    affiliateLegs = [];
    await resetAndListMarket(database(), ledger, matching);
    await fund(ledger, BOB, 'BTC', '5');
    await fund(ledger, ALICE, 'USDT', '1000');
    const direct = tradeOver(database(), ledger, matching, REBATE_SCHEDULE);
    await direct.placeOrder(principalFor(BOB), {
      marketId: MARKET_ID,
      side: 'sell',
      type: 'limit',
      qty: amt('2'),
      price: amt('100'),
      clientOrderId: 'saga-rebate-maker',
    });
    await direct.placeOrder(principalFor(ALICE), {
      marketId: MARKET_ID,
      side: 'buy',
      type: 'limit',
      qty: amt('2'),
      price: amt('100'),
      clientOrderId: 'saga-rebate-taker',
    });
  },
  async run(fetchImpl) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const trade = tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching, REBATE_SCHEDULE, {
        affiliateAccrue,
      });
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
    const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => (await ledger.balance(ref)).amount;
    // Bob paid 2 BTC, received 200 USDT with no fee, and got 0.001 BTC back once.
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe(amt('200'));
    expect(await bal(userAvailable(BOB, 'BTC'))).toBe(amt('3.001'));
    expect(await bal(userAvailable(ALICE, 'BTC'))).toBe(amt('1.998'));
    expect(await bal(houseFees('trade', 'BTC'))).toBe(amt('0.001'));
    expect(await bal(houseFees('trade', 'USDT'))).toBe(0n);
    expect(await bal(orderHoldAccount(BOB, 'BTC', MAKER_ID))).toBe(0n);
    expect(await bal(orderHoldAccount(ALICE, 'USDT', TAKER_ID))).toBe(0n);
    const legs = await database().sql<
      Array<{ liquidity: string; fee_amount: string; rebate_bps: number | null; rebate_amount: string | null; rebate_asset: string | null }>
    >`
      SELECT liquidity, fee_amount, rebate_bps, rebate_amount, rebate_asset FROM trade.fills ORDER BY liquidity
    `;
    expect(
      legs.map((l) => [l.liquidity, amt(l.fee_amount), l.rebate_bps, l.rebate_amount ? amt(l.rebate_amount) : null, l.rebate_asset]),
    ).toEqual([
      ['maker', 0n, 5, amt('0.001'), 'BTC'],
      ['taker', amt('0.002'), null, null, null],
    ]);
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
    // Affiliates share what the house kept of the taker fee (0.002 - 0.001 BTC), never the part paid back as a rebate.
    // The maker paid no fee, so it reports none.
    expect(affiliateLegs.length).toBeGreaterThan(0);
    for (const leg of affiliateLegs) {
      expect(leg).toMatchObject({ userId: ALICE, feeAmount: amt('0.001'), feeAsset: 'BTC', feeEventId: expect.stringMatching(/:taker$/) });
    }
  },
};

describeMoneyDoor(settleRebateFill, () => new MemoryLedger());
