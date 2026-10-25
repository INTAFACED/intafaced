/**
 * Paying a spot fee in the platform token, on Postgres (RC-cex-spot-11, J-cex-spot-10 #9): what placement keeps and
 * refuses before anything is held, a retry that changes the choice, and two settles of the same fill at once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { InsufficientFundsError, MemoryLedger, houseFees, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { parseFeeScheduleJson } from './fee-schedule.js';
import { UNWIRED_IFC_DISCOUNT, type IfcDiscountSource } from './fee-ifc.js';
import { principalFor, StubMatching } from './testing.js';
import { orderIdFor } from './ids.js';
import { TradeError } from './types.js';
import {
  ALICE,
  BOB,
  MARKET_ID,
  fund,
  openTradeDatabase,
  publishTestCreditLimits,
  resetAndListMarket,
  tradeOver,
} from './__tests__/saga-trade-fixture.js';

const schedule = (ifcFee: unknown) =>
  parseFeeScheduleJson(
    JSON.stringify({
      published: true,
      version: 'test-ifc',
      defaultPairGroup: 'test-ifc',
      rows: [{ pairGroup: 'test-ifc', tierId: 'regular', zeroFee: false, makerBps: '5', takerBps: '10', minFee: null }],
      ...(ifcFee === undefined ? {} : { ifcFee }),
    }),
  );
const WITH_TERMS = schedule({ tokenAsset: 'IFC', perUnit: { BTC: '50000', USDT: '2' } });
const ifcDiscount: IfcDiscountSource = { discountBps: async () => 2000 };

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;
let restoreLimits: () => void = () => undefined;
let ledger = new MemoryLedger();
let matching = new StubMatching();

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

beforeEach(async () => {
  ledger = new MemoryLedger();
  matching = new StubMatching();
  await resetAndListMarket(database(), ledger, matching);
  await fund(ledger, BOB, 'BTC', '5');
  await fund(ledger, ALICE, 'USDT', '1000');
  await fund(ledger, ALICE, 'IFC', '1000');
});

const buy = (clientOrderId: string, extra: Record<string, unknown> = {}) => ({
  marketId: MARKET_ID,
  side: 'buy' as const,
  type: 'limit',
  qty: amt('2'),
  price: amt('100'),
  clientOrderId,
  ...extra,
});

async function refusal(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return err instanceof TradeError ? err.code : String(err);
  }
}

async function heldUsdt(): Promise<bigint> {
  return (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
}

describe('placing an order that pays its fees in the token', () => {
  it('keeps the token and the stake discount on the row', async () => {
    const order = await tradeOver(database(), ledger, matching, WITH_TERMS, { ifcDiscount }).placeOrder(
      principalFor(ALICE),
      buy('p-1', { feeCurrency: 'IFC' }),
    );
    const [row] = await database().sql<Array<{ fee_currency: string | null; fee_ifc_discount_bps: number | null }>>`
      SELECT fee_currency, fee_ifc_discount_bps FROM trade.orders WHERE id = ${order.id}
    `;
    expect(row).toEqual({ fee_currency: 'IFC', fee_ifc_discount_bps: 2000 });
  });

  it.each([
    ['the owner terms are not published', schedule(undefined), ifcDiscount, {}, 'trade.fee_currency_ifc_unset'],
    ['the stake discount cannot be read', WITH_TERMS, UNWIRED_IFC_DISCOUNT, {}, 'trade.fee_ifc_discount_unavailable'],
    [
      'the order is a sub-account',
      WITH_TERMS,
      ifcDiscount,
      { subAccountId: '33333333-3333-4333-8333-333333333333' },
      'trade.fee_currency_unsupported',
    ],
    ['the token is not the one the terms name', WITH_TERMS, ifcDiscount, { feeCurrency: 'ETH' }, 'trade.fee_currency_unsupported'],
  ])('refuses before any row or hold when %s', async (_name, fees, discount, extra, code) => {
    const before = await heldUsdt();
    const trade = tradeOver(database(), ledger, matching, fees, { ifcDiscount: discount });
    expect(await refusal(() => trade.placeOrder(principalFor(ALICE), buy('p-2', { feeCurrency: 'IFC', ...extra })))).toBe(code);
    expect(await database().sql`SELECT id FROM trade.orders WHERE user_id = ${ALICE}`).toHaveLength(0);
    expect(await heldUsdt()).toBe(before);
  });

  it('keeps the token choice on a replacement that does not name a fee currency', async () => {
    const trade = tradeOver(database(), ledger, matching, WITH_TERMS, { ifcDiscount });
    const original = await trade.placeOrder(principalFor(ALICE), buy('p-4', { feeCurrency: 'IFC' }));
    const outcome = await trade.replaceOrder(principalFor(ALICE), original.id, buy('p-4-r', { price: amt('99') }));
    expect(outcome.replacement?.feeCurrency).toBe('IFC');
    expect(outcome.replacement?.feeIfcDiscountBps).toBe(2000);
  });

  it('refuses a retry under the same client id that changes the fee currency', async () => {
    const trade = tradeOver(database(), ledger, matching, WITH_TERMS, { ifcDiscount });
    await trade.placeOrder(principalFor(ALICE), buy('p-3', { feeCurrency: 'IFC' }));
    expect(await refusal(() => trade.placeOrder(principalFor(ALICE), buy('p-3')))).toBe('trade.client_order_id_conflict');
    // The same request again returns the order it placed.
    expect((await trade.placeOrder(principalFor(ALICE), buy('p-3', { feeCurrency: 'ifc' }))).feeCurrency).toBe('IFC');
  });
});

describe('settling a fill whose taker pays in the token', () => {
  it('charges the token once when the inline settle and a redelivery run at the same time', async () => {
    const trade = tradeOver(database(), ledger, matching, WITH_TERMS, { ifcDiscount });
    await trade.placeOrder(principalFor(BOB), { ...buy('m-1'), side: 'sell' });
    await trade.placeOrder(principalFor(ALICE), buy('t-1', { feeCurrency: 'IFC' }));
    const event = {
      marketId: MARKET_ID,
      makerOrderId: orderIdFor(BOB, MARKET_ID, 'm-1'),
      takerOrderId: orderIdFor(ALICE, MARKET_ID, 't-1'),
      price: '100',
      qty: '2',
      sequence: 1,
      makerAccountId: BOB,
      takerAccountId: ALICE,
    };
    await Promise.all([trade.settleFillEvent(event), trade.settleFillEvent(event), trade.settleFillEvent(event)]);
    expect((await ledger.balance(userAvailable(ALICE, 'IFC'))).amount).toBe(amt('920'));
    expect((await ledger.balance(userAvailable(ALICE, 'BTC'))).amount).toBe(amt('2'));
    expect((await ledger.balance(houseFees('trade', 'IFC'))).amount).toBe(amt('80'));
    const legs = await database().sql<Array<{ liquidity: string; fee_asset: string; fee_amount: string }>>`
      SELECT liquidity, fee_asset, fee_amount FROM trade.fills ORDER BY liquidity
    `;
    expect(legs.map((l) => [l.liquidity, l.fee_asset, amt(l.fee_amount)])).toEqual([
      ['maker', 'USDT', amt('0.1')],
      ['taker', 'IFC', amt('80')],
    ]);
  });

  it('decides each leg once: a settle refused for funds is not overtaken by one that runs while it decides', async () => {
    // The first token charge waits, then is refused for funds; a second settle of the same fill starts meanwhile, when
    // the balance would cover it. Unserialized, the second would charge IFC while the first writes "paid in BTC".
    let reached!: () => void;
    const firstCharge = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let charges = 0;
    const racing = Object.assign(Object.create(ledger) as MemoryLedger, {
      post: async (req: Parameters<MemoryLedger['post']>[0]) => {
        if (req.reason === 'trade.fill.fee_ifc' && ++charges === 1) {
          reached();
          await gate;
          throw new InsufficientFundsError('user:test', 'IFC', '80', '0');
        }
        return ledger.post(req);
      },
    });
    const setup = tradeOver(database(), ledger, matching, WITH_TERMS, { ifcDiscount });
    await setup.placeOrder(principalFor(BOB), { ...buy('m-2'), side: 'sell' });
    await setup.placeOrder(principalFor(ALICE), buy('t-2', { feeCurrency: 'IFC' }));
    const trade = tradeOver(database(), racing, matching, WITH_TERMS);
    const event = {
      marketId: MARKET_ID,
      makerOrderId: orderIdFor(BOB, MARKET_ID, 'm-2'),
      takerOrderId: orderIdFor(ALICE, MARKET_ID, 't-2'),
      price: '100',
      qty: '2',
      sequence: 1,
      makerAccountId: BOB,
      takerAccountId: ALICE,
    };
    const first = trade.settleFillEvent(event);
    await firstCharge;
    const second = trade.settleFillEvent(event).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await first;
    expect(await second).toBeUndefined();
    expect((await ledger.balance(userAvailable(ALICE, 'IFC'))).amount).toBe(amt('1000'));
    expect((await ledger.balance(userAvailable(ALICE, 'BTC'))).amount).toBe(amt('1.998'));
    expect((await ledger.balance(houseFees('trade', 'IFC'))).amount).toBe(0n);
    const [taker] = await database().sql<Array<{ fee_asset: string; fee_fallback: string | null }>>`
      SELECT fee_asset, fee_fallback FROM trade.fills WHERE liquidity = 'taker'
    `;
    expect(taker).toEqual({ fee_asset: 'BTC', fee_fallback: 'trade.fee_ifc_insufficient' });
  });
});
