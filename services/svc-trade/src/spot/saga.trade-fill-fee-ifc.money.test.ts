/**
 * SAGATEST for a spot fee paid in the platform token (RC-cex-spot-11, J-cex-spot-10 #9): a taker whose order chose IFC
 * is charged `feeCharge` in token mode, at the stake discount its order was placed with, before the fill rows; the one
 * `tradeFill` then takes no fee from what it receives. `describeMoneyDoor` replays the fill as a duplicate delivery, a lost
 * acknowledgement on each post and a crash after each post (between the token charge and the fill too), and requires the
 * book of one clean run every time: the fee taken once, in exactly one currency.
 *
 * Fill: Bob rests a sell of 2 BTC at 100, Alice takes it. Alice's taker fee is 10 bps of 2 BTC = 0.002 BTC. The TEST
 * terms say 1 BTC is 50 000 IFC, so the fee is 100 IFC before the discount; her stake earns 20% off, so 80 IFC. Bob, who
 * did not choose, pays 5 bps of the 200 USDT he receives = 0.1 USDT.
 *
 * The second scenario runs the same fill with Alice holding 10 IFC: the charge is refused for funds, the fill takes her
 * fee in BTC as always and her leg says why, and no IFC moves.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, houseFees, orderHoldAccount, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from '../ledger-client.js';
import type { AffiliateFeeLeg } from './affiliate-accrue.js';
import { parseFeeScheduleJson } from './fee-schedule.js';
import type { IfcDiscountSource } from './fee-ifc.js';
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

const IFC_SCHEDULE = parseFeeScheduleJson(
  JSON.stringify({
    published: true,
    version: 'test-ifc',
    defaultPairGroup: 'test-ifc',
    rows: [{ pairGroup: 'test-ifc', tierId: 'regular', zeroFee: false, makerBps: '5', takerBps: '10', minFee: null }],
    ifcFee: { tokenAsset: 'IFC', perUnit: { BTC: '50000', USDT: '2' } },
  }),
);

/** TEST stake discount: 20% off the token fee for Alice. */
const ifcDiscount: IfcDiscountSource = { discountBps: async (userId) => (userId === ALICE ? 2000 : 0) };

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

const MAKER_ID = orderIdFor(BOB, MARKET_ID, 'saga-ifc-maker');
const TAKER_ID = orderIdFor(ALICE, MARKET_ID, 'saga-ifc-taker');
let matching = new StubMatching();
let affiliateLegs: AffiliateFeeLeg[] = [];
const affiliateAccrue = { accrueTradeFee: async (leg: AffiliateFeeLeg) => void affiliateLegs.push(leg) };

function scenario(name: string, aliceIfc: string, invariant: MoneyDoorScenario['invariant']): MoneyDoorScenario {
  return {
    name,
    secret: SECRET,
    verify: verifyServiceHeaders,
    async setup(ledger) {
      matching = new StubMatching();
      affiliateLegs = [];
      await resetAndListMarket(database(), ledger, matching);
      await fund(ledger, BOB, 'BTC', '5');
      await fund(ledger, ALICE, 'USDT', '1000');
      await fund(ledger, ALICE, 'IFC', aliceIfc);
      const direct = tradeOver(database(), ledger, matching, IFC_SCHEDULE, { ifcDiscount });
      await direct.placeOrder(principalFor(BOB), {
        marketId: MARKET_ID,
        side: 'sell',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'saga-ifc-maker',
      });
      const taker = await direct.placeOrder(principalFor(ALICE), {
        marketId: MARKET_ID,
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('100'),
        clientOrderId: 'saga-ifc-taker',
        feeCurrency: 'ifc',
      });
      // The choice and the discount are the order's from placement on.
      expect([taker.feeCurrency, taker.feeIfcDiscountBps]).toEqual(['IFC', 2000]);
    },
    async run(fetchImpl) {
      const realFetch = globalThis.fetch;
      globalThis.fetch = fetchImpl;
      try {
        // No discount source on the settling process: a fill never reads the stake, it charges what the order kept.
        const trade = tradeOver(database(), createLedgerClient('http://ledger.test', SECRET), matching, IFC_SCHEDULE, {
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
    invariant,
  };
}

async function legs() {
  const rows = await database().sql<
    Array<{ liquidity: string; fee_asset: string; fee_amount: string; fee_bps: number; fee_fallback: string | null }>
  >`
    SELECT liquidity, fee_asset, fee_amount, fee_bps, fee_fallback FROM trade.fills ORDER BY liquidity
  `;
  return rows.map((l) => [l.liquidity, l.fee_asset, amt(l.fee_amount), Number(l.fee_bps), l.fee_fallback]);
}

describeMoneyDoor(
  scenario('svc-trade fill whose taker pays its fee in IFC (feeCharge token mode, then tradeFill)', '1000', async (ledger) => {
    const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => (await ledger.balance(ref)).amount;
    // Alice received all 2 BTC and paid 80 IFC once; Bob paid his fee in what he received, as before.
    expect(await bal(userAvailable(ALICE, 'BTC'))).toBe(amt('2'));
    expect(await bal(userAvailable(ALICE, 'IFC'))).toBe(amt('920'));
    expect(await bal(houseFees('trade', 'IFC'))).toBe(amt('80'));
    expect(await bal(houseFees('trade', 'BTC'))).toBe(0n);
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe(amt('199.9'));
    expect(await bal(houseFees('trade', 'USDT'))).toBe(amt('0.1'));
    expect(await bal(orderHoldAccount(BOB, 'BTC', MAKER_ID))).toBe(0n);
    expect(await bal(orderHoldAccount(ALICE, 'USDT', TAKER_ID))).toBe(0n);
    expect(await legs()).toEqual([
      ['maker', 'USDT', amt('0.1'), 5, null],
      ['taker', 'IFC', amt('80'), 10, null],
    ]);
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', IFC: '0', USDT: '0' });
    // Affiliates share the fee as it landed: the taker's in IFC.
    const taker = affiliateLegs.filter((leg) => leg.userId === ALICE);
    expect(taker.length).toBeGreaterThan(0);
    for (const leg of taker) expect(leg).toMatchObject({ feeAmount: amt('80'), feeAsset: 'IFC' });
  }),
  () => new MemoryLedger(),
);

describeMoneyDoor(
  scenario('svc-trade fill whose taker chose IFC and holds too little (fee in BTC, leg says why)', '10', async (ledger) => {
    const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => (await ledger.balance(ref)).amount;
    expect(await bal(userAvailable(ALICE, 'BTC'))).toBe(amt('1.998'));
    expect(await bal(userAvailable(ALICE, 'IFC'))).toBe(amt('10'));
    expect(await bal(houseFees('trade', 'IFC'))).toBe(0n);
    expect(await bal(houseFees('trade', 'BTC'))).toBe(amt('0.002'));
    expect(await legs()).toEqual([
      ['maker', 'USDT', amt('0.1'), 5, null],
      ['taker', 'BTC', amt('0.002'), 10, 'trade.fee_ifc_insufficient'],
    ]);
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', IFC: '0', USDT: '0' });
  }),
  () => new MemoryLedger(),
);
