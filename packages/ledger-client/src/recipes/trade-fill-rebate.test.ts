import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, orderHoldAccount, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes, type TradeFillInput } from './index.js';

/**
 * SP-fees-vip-01 maker rebate on `tradeFill`. Amounts are worked examples, not recomputed inside the assertion.
 *
 * Fill: taker buys 1 BTC for 900 USDT from a resting maker. The maker pays BTC, so the taker fee and the rebate
 * are both in BTC: taker fee 10 bps of 1 BTC = 0.001 BTC, maker rebate 5 bps = 0.0005 BTC, the house keeps 0.0005.
 */

const TAKER = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);

function fill(fillId: string, over: Partial<TradeFillInput> = {}): TradeFillInput {
  return {
    fillId,
    makerId: MAKER,
    takerId: TAKER,
    makerOrderId: `maker-${fillId}`,
    takerOrderId: `taker-${fillId}`,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: amt('1'),
    quoteAmount: amt('900'),
    takerSide: 'buy',
    makerFeeBps: 0,
    takerFeeBps: 10,
    makerRebateBps: 5,
    ...over,
  };
}

async function fund(fillId: string) {
  await ledger.post(recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `usdt-${fillId}` }));
  await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'BTC', amount: amt('2'), rail: 'test', railRef: `btc-${fillId}` }));
  await ledger.post(recipes.orderHold({ orderId: `taker-${fillId}`, userId: TAKER, assetId: 'USDT', amount: amt('900') }));
  await ledger.post(recipes.orderHold({ orderId: `maker-${fillId}`, userId: MAKER, assetId: 'BTC', amount: amt('1') }));
}

describe('tradeFill maker rebate', () => {
  it('pays the maker a rebate out of the same fill taker fee, as its own leg, and the books close', async () => {
    await fund('f1');
    const tx = await ledger.post(recipes.tradeFill(fill('f1')));

    expect(tx.entries).toHaveLength(6);
    expect(await bal(userAvailable(MAKER, 'USDT'))).toBe('900');
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('1.0005');
    expect(await bal(userAvailable(TAKER, 'BTC'))).toBe('0.999');
    expect(await bal(houseFees('trade', 'BTC'))).toBe('0.0005');
    expect(await bal(houseFees('trade', 'USDT'))).toBe('0');
    expect(await bal(orderHoldAccount(MAKER, 'BTC', 'maker-f1'))).toBe('0');
    expect(await bal(orderHoldAccount(TAKER, 'USDT', 'taker-f1'))).toBe('0');
    expect(ledger.totalsByAsset()).toEqual({ USDT: '0', BTC: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('names the rebate in the post meta, so the fill detail reads it from the ledger', () => {
    const post = recipes.tradeFill(fill('f2'));
    expect(post.idempotencyKey).toBe('trade.fill:f2');
    expect(post.meta).toMatchObject({ makerRebateBps: 5, makerRebateAsset: 'BTC', makerRebate: amt('0.0005').toString() });
  });

  it('a retry of the same fill returns the first post and pays the rebate once', async () => {
    await fund('f3');
    const first = await ledger.post(recipes.tradeFill(fill('f3')));
    const again = await ledger.post(recipes.tradeFill(fill('f3')));
    expect(again.id).toBe(first.id);
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('1.0005');
    expect(await bal(houseFees('trade', 'BTC'))).toBe('0.0005');
  });

  it('a taker selling is the mirror: the rebate is in the quote the maker paid', async () => {
    await ledger.post(recipes.deposit({ userId: TAKER, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: 'btc-f4' }));
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: amt('900'), rail: 'test', railRef: 'usdt-f4' }));
    await ledger.post(recipes.orderHold({ orderId: 'taker-f4', userId: TAKER, assetId: 'BTC', amount: amt('1') }));
    await ledger.post(recipes.orderHold({ orderId: 'maker-f4', userId: MAKER, assetId: 'USDT', amount: amt('900') }));
    await ledger.post(recipes.tradeFill(fill('f4', { takerSide: 'sell' })));

    // Taker fee 10 bps of 900 USDT = 0.9; rebate 5 bps = 0.45.
    expect(await bal(userAvailable(TAKER, 'USDT'))).toBe('899.1');
    expect(await bal(userAvailable(MAKER, 'USDT'))).toBe('0.45');
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('1');
    expect(await bal(houseFees('trade', 'USDT'))).toBe('0.45');
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
  });

  it('refuses a rebate equal to the taker fee: the house always keeps a leg on a rebate fill', async () => {
    await fund('f5');
    expect(() => recipes.tradeFill(fill('f5', { makerRebateBps: 10 }))).toThrow(/below the taker fee/);
    expect(await ledger.getTxByKey('trade.fill:f5')).toBeNull();
  });

  it('rounds the rebate down, so dust never makes the house pay the whole taker fee', () => {
    // 3 wei × 5 bps: the taker fee rounds up to 1 wei, the rebate down to 0, so no rebate leg posts.
    const post = recipes.tradeFill(fill('f6', { qty: 3n, quoteAmount: 3n }));
    expect(post.entries).toHaveLength(5);
    expect(post.meta).toMatchObject({ makerRebate: '0' });
  });

  it('refuses a rebate above the taker fee, before anything posts', async () => {
    await fund('f7');
    expect(() => recipes.tradeFill(fill('f7', { makerRebateBps: 11 }))).toThrow(InvalidEntryError);
    expect(() => recipes.tradeFill(fill('f7', { makerRebateBps: 11 }))).toThrow(/below the taker fee/);
    expect(await ledger.getTxByKey('trade.fill:f7')).toBeNull();
    expect(await bal(orderHoldAccount(MAKER, 'BTC', 'maker-f7'))).toBe('1');
  });

  it('refuses a rebate on a maker who also pays a fee', () => {
    expect(() => recipes.tradeFill(fill('f8', { makerFeeBps: 2 }))).toThrow(/maker fee of 0 bps/);
  });

  it('refuses a negative or fractional rebate rate', () => {
    expect(() => recipes.tradeFill(fill('f9', { makerRebateBps: -1 }))).toThrow(/non-negative integer/);
    expect(() => recipes.tradeFill(fill('f9', { makerRebateBps: 2.5 }))).toThrow(/non-negative integer/);
  });

  it('a fill without a rebate posts exactly as before', () => {
    const plain = recipes.tradeFill(fill('f10', { makerFeeBps: 10, takerFeeBps: 20, makerRebateBps: undefined }));
    const zero = recipes.tradeFill(fill('f10', { makerFeeBps: 10, takerFeeBps: 20, makerRebateBps: 0 }));
    expect(zero).toEqual(plain);
    expect(plain.meta).not.toHaveProperty('makerRebate');
  });
});
