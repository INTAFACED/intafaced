/**
 * The token buyback's IOC buy on Postgres (J-dex-protocol-17): the rewards engine's swept quote is held for one order,
 * a customer ask fills it, the remainder goes back, and a house market-maker ask is refused before and at settlement.
 * Every amount here is TEST.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  buybackOrderHoldAccount,
  houseFees,
  orderHoldAccount,
  parseAmount as amt,
  recipes,
  rewardsEngine,
  userAvailable,
  type AccountRef,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { principalFor, StubMatching } from './testing.js';
import { HOUSE_MM_USER_UUID } from './ids.js';
import { MM_MATCHING_ACCOUNT_ID } from '../mm/fill-account.js';
import { BUYBACK_MATCHING_ACCOUNT_ID, HOUSE_BUYBACK_USER_UUID } from './buyback-order.js';
import { TradeError } from './types.js';
import { UNPUBLISHED_FEE_SCHEDULE } from './fee-schedule.js';
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

const bal = async (ref: AccountRef) => (await ledger.balance(ref)).amount;

/** A TEST fee taken from ALICE, then swept into the rewards engine the way svc-token's buyback run does. */
async function sweepIntoRewards(amount: string): Promise<void> {
  await fund(ledger, ALICE, 'USDT', amount);
  await ledger.post(
    recipes.feeCharge({ mode: 'asset', module: 'trade', chargeId: 'buyback-test', userId: ALICE, assetId: 'USDT', amount: amt(amount) }),
  );
  await ledger.post(recipes.sweepFeesToRewards({ windowId: 'buyback-test', sourceModule: 'trade', assetId: 'USDT', amount: amt(amount) }));
}

async function bobAsk(qty: string, price: string) {
  return tradeOver(database(), ledger, matching).placeOrder(principalFor(BOB), {
    marketId: MARKET_ID,
    side: 'sell',
    type: 'limit',
    qty: amt(qty),
    price: amt(price),
    clientOrderId: `ask-${qty}-${price}`,
  });
}

async function refusal(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (err) {
    return err instanceof TradeError ? err.code : String(err);
  }
}

/** A ledger whose buyback hold post times out with no answer, after (`booked`) or before it commits. */
function timingOutHold(base: MemoryLedger, booked: boolean): LedgerClient {
  return new Proxy(base, {
    get(target, key) {
      if (key === 'post') {
        return async (req: PostRequest) => {
          if (!req.idempotencyKey.startsWith('order.hold.buyback:')) return target.post(req);
          if (booked) await target.post(req);
          throw new Error('ledger request timed out');
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as LedgerClient;
}

beforeEach(async () => {
  ledger = new MemoryLedger();
  matching = new StubMatching();
  await resetAndListMarket(database(), ledger, matching);
  await fund(ledger, BOB, 'BTC', '5');
  await sweepIntoRewards('200');
});

describe('the buyback IOC buy', () => {
  it('fills a customer ask from the rewards engine, returns the remainder and strands nothing', async () => {
    const ask = await bobAsk('1', '100');
    const trade = tradeOver(database(), ledger, matching);
    matching.scriptFills([{ makerOrderId: ask.id, makerAccountId: BOB, price: '100', qty: '1' }], { cancelRemainder: '0.5' });

    const result = await trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1.5'), price: amt('100'), clientOrderId: 'run-1' });

    expect(matching.submitted.at(-1)?.request).toMatchObject({
      accountId: BUYBACK_MATCHING_ACCOUNT_ID,
      side: 'buy',
      tif: 'IOC',
      qty: '1.5',
      price: '100',
    });
    expect(result.status).toBe('cancelled');
    expect(result.filledQty).toBe(amt('1'));
    expect(result.held).toBe(amt('150'));
    expect(result.spent).toBe(amt('100'));

    const [fill] = await database().sql<Array<{ fee_bps: number }>>`SELECT fee_bps FROM trade.fills WHERE order_id = ${ask.id}`;
    const makerFee = (amt('100') * BigInt(fill!.fee_bps)) / 10_000n;
    expect(makerFee).toBeGreaterThan(0n);

    // Bob sold 1 BTC for 100 USDT less the maker fee; the bought BTC sits in the rewards engine for the burn.
    expect(await bal(userAvailable(BOB, 'USDT'))).toBe(amt('100') - makerFee);
    expect(await bal(userAvailable(BOB, 'BTC'))).toBe(amt('4'));
    expect(await bal(orderHoldAccount(BOB, 'BTC', ask.id))).toBe(0n);
    expect(await bal(rewardsEngine('BTC'))).toBe(amt('1'));
    expect(await bal(houseFees('trade', 'USDT'))).toBe(makerFee);
    // 200 swept, 150 held, 100 spent, 50 back.
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('100'));
    expect(await bal(buybackOrderHoldAccount('USDT', result.orderId))).toBe(0n);

    // The house taker leg pays no fee and names the house, never a customer.
    const legs = await database().sql<Array<{ user_id: string; fee_amount: string }>>`
      SELECT user_id, fee_amount::text FROM trade.fills WHERE order_id = ${result.orderId}
    `;
    expect(legs.map((l) => [l.user_id, amt(l.fee_amount)])).toEqual([[HOUSE_BUYBACK_USER_UUID, 0n]]);
    expect(ledger.journal().some((tx) => tx.reason === 'trade.fill.buyback')).toBe(true);
    expect(ledger.totalsByAsset()).toEqual({ USDT: '0', BTC: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('returns the first order on a retry with the same run id, and refuses another command under it', async () => {
    const trade = tradeOver(database(), ledger, matching);
    matching.scriptFills([], { cancelRemainder: '1' });
    const first = await trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-2' });
    expect(first.status).toBe('cancelled');
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));

    const again = await trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-2' });
    expect(again).toEqual(first);
    expect(matching.submitted).toHaveLength(1);
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('101'), clientOrderId: 'run-2' })),
    ).toBe('trade.buyback_conflict');
  });

  it('refuses a hold the rewards engine cannot fund, and leaves no row', async () => {
    const trade = tradeOver(database(), ledger, matching);
    const code = await refusal(() =>
      trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('3'), price: amt('100'), clientOrderId: 'run-3' }),
    );
    expect(code).toMatch(/InsufficientFunds/);
    expect(await database().sql`SELECT id FROM trade.orders WHERE user_id = ${HOUSE_BUYBACK_USER_UUID}`).toHaveLength(0);
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));
    expect(matching.submitted).toHaveLength(0);
  });

  it('refuses before any hold when a house market-maker ask would cross', async () => {
    const trade = tradeOver(database(), ledger, matching);
    matching.listOrders = async (marketId: string) => ({
      marketId,
      orders: [
        {
          marketId,
          orderId: 'mm-ask',
          accountId: MM_MATCHING_ACCOUNT_ID,
          kind: 'book',
          side: 'sell',
          price: '99',
          remaining: '1',
          sequence: 1,
          version: 1,
        },
      ],
    });
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-4' })),
    ).toBe('trade.buyback_house_maker');
    expect(await database().sql`SELECT id FROM trade.orders WHERE user_id = ${HOUSE_BUYBACK_USER_UUID}`).toHaveLength(0);
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));
    expect(matching.submitted).toHaveLength(0);
  });

  it('refuses when the book cannot be read for house asks', async () => {
    const trade = tradeOver(database(), ledger, matching);
    matching.listOrders = async () => {
      throw new Error('engine down');
    };
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-5' })),
    ).toBe('trade.buyback_book_unreadable');
    expect(matching.submitted).toHaveLength(0);
  });

  it('refuses at settlement a fill against a house market-maker order, and posts no fill', async () => {
    // A recorded house market-maker ask that appeared between the pre-check and the match.
    await database().sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, seeded)
      VALUES ('55555555-5555-4555-8555-555555555555', ${HOUSE_MM_USER_UUID}, ${MARKET_ID}, 'mm-1', 'sell', 'limit', 100, 1, 'open', 'GTC', 'BTC', 1, true)
    `;
    const trade = tradeOver(database(), ledger, matching);
    matching.scriptFills([
      { makerOrderId: '55555555-5555-4555-8555-555555555555', makerAccountId: MM_MATCHING_ACCOUNT_ID, price: '100', qty: '1' },
    ]);
    const code = await refusal(() =>
      trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-6' }),
    );
    expect(code).toBe('trade.buyback_house_maker');
    const [row] = await database().sql<Array<{ recovery_reason: string | null }>>`
      SELECT recovery_reason FROM trade.orders WHERE user_id = ${HOUSE_BUYBACK_USER_UUID}
    `;
    expect(row?.recovery_reason).toBe('RECONCILIATION_REQUIRED');
    // The quote stays in the rewards engine's own hold for an operator; nothing reached a customer.
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('100'));
    expect(ledger.journal().some((tx) => tx.reason === 'trade.fill.buyback')).toBe(false);
    expect(await database().sql`SELECT id FROM trade.fills`).toHaveLength(0);
    expect(await bal(rewardsEngine('BTC'))).toBe(0n);
  });

  it('refuses a paper or unknown market and a bad run id before anything is read', async () => {
    const trade = tradeOver(database(), ledger, matching);
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'NOPE/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'r' })),
    ).toBe('trade.market_not_found');
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: ' r' })),
    ).toBe('trade.buyback_invalid');
    expect(await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: '' }))).toBe(
      'trade.buyback_invalid',
    );
  });
  it('keeps the row for reconcile when the hold post times out unbooked, and holds nothing', async () => {
    const trade = tradeOver(database(), timingOutHold(ledger, false), matching);
    const code = await refusal(() =>
      trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-7' }),
    );
    expect(code).toBe('trade.hold_unknown');
    const rows = await database().sql<
      Array<{ status: string }>
    >`SELECT status FROM trade.orders WHERE user_id = ${HOUSE_BUYBACK_USER_UUID}`;
    expect(rows.map((r) => r.status)).toEqual(['pending']);
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));
    expect(matching.submitted).toHaveLength(0);
    // A retry under the same run id waits; it never posts a second hold or resubmits.
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-7' })),
    ).toBe('trade.buyback_in_flight');
  });

  it('goes on to the engine when a timed-out hold post did book', async () => {
    matching.scriptFills([], { cancelRemainder: '1' });
    const trade = tradeOver(database(), timingOutHold(ledger, true), matching);
    const result = await trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-8' });
    expect(result.status).toBe('cancelled');
    expect(matching.submitted).toHaveLength(1);
    expect(await bal(buybackOrderHoldAccount('USDT', result.orderId))).toBe(0n);
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('settles a customer fill and refuses the house fill after it in the same batch, touching no customer funds', async () => {
    const ask = await bobAsk('1', '99');
    await database().sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, status, tif, hold_asset, hold_amount, seeded)
      VALUES ('66666666-6666-4666-8666-666666666666', ${HOUSE_MM_USER_UUID}, ${MARKET_ID}, 'mm-2', 'sell', 'limit', 100, 1, 'open', 'GTC', 'BTC', 1, true)
    `;
    const trade = tradeOver(database(), ledger, matching);
    matching.scriptFills([
      { makerOrderId: ask.id, makerAccountId: BOB, price: '99', qty: '1' },
      { makerOrderId: '66666666-6666-4666-8666-666666666666', makerAccountId: MM_MATCHING_ACCOUNT_ID, price: '100', qty: '1' },
    ]);
    const code = await refusal(() =>
      trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('2'), price: amt('100'), clientOrderId: 'run-9' }),
    );
    expect(code).toBe('trade.buyback_house_maker');
    // Bob's fill settled in full; the house fill posted nothing.
    expect(await bal(userAvailable(BOB, 'BTC'))).toBe(amt('4'));
    expect(await bal(orderHoldAccount(BOB, 'BTC', ask.id))).toBe(0n);
    expect(await bal(rewardsEngine('BTC'))).toBe(amt('1'));
    const [row] = await database().sql<Array<{ id: string; recovery_reason: string | null }>>`
      SELECT id, recovery_reason FROM trade.orders WHERE user_id = ${HOUSE_BUYBACK_USER_UUID}
    `;
    expect(row?.recovery_reason).toBe('RECONCILIATION_REQUIRED');
    // 200 swept, 200 held, 99 spent; the other 101 stays in the buyback's own hold for reconcile, never a customer's.
    expect(await bal(rewardsEngine('USDT'))).toBe(0n);
    expect(await bal(buybackOrderHoldAccount('USDT', row!.id))).toBe(amt('101'));
    expect(ledger.totalsByAsset()).toEqual({ USDT: '0', BTC: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses the buyback house user on the customer order path', async () => {
    const code = await refusal(() =>
      tradeOver(database(), ledger, matching).placeOrder(principalFor(HOUSE_BUYBACK_USER_UUID), {
        marketId: MARKET_ID,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'not-a-customer',
      }),
    );
    expect(code).toBe('trade.buyback_invalid');
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));
  });
  it('refuses before any row or hold while the fee schedule is blank', async () => {
    const trade = tradeOver(database(), ledger, matching, UNPUBLISHED_FEE_SCHEDULE);
    expect(
      await refusal(() => trade.placeBuybackIocBuy({ symbol: 'BTC/USDT', qty: amt('1'), price: amt('100'), clientOrderId: 'run-10' })),
    ).toBe('trade.fee_schedule_blank');
    expect(await database().sql`SELECT id FROM trade.orders WHERE user_id = ${HOUSE_BUYBACK_USER_UUID}`).toHaveLength(0);
    expect(await bal(rewardsEngine('USDT'))).toBe(amt('200'));
    expect(matching.submitted).toHaveLength(0);
  });
});
