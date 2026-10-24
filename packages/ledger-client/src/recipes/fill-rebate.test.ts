import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import { makerRebateFor, recipes, type TradeFillMakerRebateInput } from './index.js';

/**
 * SP-fees-vip-01 maker rebate. Amounts are worked examples, not recomputed inside the assertion.
 *
 * Fill: a taker buys 1 BTC for 900 USDT from a resting maker. The maker paid BTC, so the taker fee and the rebate
 * are both BTC: taker fee 10 bps of 1 BTC = 0.001 BTC, maker rebate 5 bps = 0.0005 BTC, the house keeps 0.0005.
 */

const TAKER = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);

function fill(fillId: string, over: Partial<TradeFillMakerRebateInput> = {}): TradeFillMakerRebateInput {
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

async function postedFill(input: TradeFillMakerRebateInput) {
  const takerPays = input.takerSide === 'buy' ? 'USDT' : 'BTC';
  const makerPays = input.takerSide === 'buy' ? 'BTC' : 'USDT';
  const takerAmount = input.takerSide === 'buy' ? input.quoteAmount : input.qty;
  const makerAmount = input.takerSide === 'buy' ? input.qty : input.quoteAmount;
  await ledger.post(
    recipes.deposit({ userId: TAKER, assetId: takerPays, amount: takerAmount, rail: 'test', railRef: `t-${input.fillId}` }),
  );
  await ledger.post(
    recipes.deposit({ userId: MAKER, assetId: makerPays, amount: makerAmount, rail: 'test', railRef: `m-${input.fillId}` }),
  );
  await ledger.post(recipes.orderHold({ orderId: input.takerOrderId, userId: TAKER, assetId: takerPays, amount: takerAmount }));
  await ledger.post(recipes.orderHold({ orderId: input.makerOrderId, userId: MAKER, assetId: makerPays, amount: makerAmount }));
  return ledger.post(recipes.tradeFill(input));
}

describe('tradeFillMakerRebate', () => {
  it('pays the maker out of the fill taker fee, under its own key, and the fill itself is unchanged', async () => {
    const input = fill('f1');
    const fillTx = await postedFill(input);
    const rebate = recipes.tradeFillMakerRebate(input);

    expect(rebate.idempotencyKey).toBe('trade.fill.rebate:f1');
    expect(rebate.reason).toBe('trade.fill.rebate');
    expect(fillTx.entries).toHaveLength(5);
    await ledger.post(rebate);

    expect(await bal(userAvailable(MAKER, 'USDT'))).toBe('900');
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('0.0005');
    expect(await bal(userAvailable(TAKER, 'BTC'))).toBe('0.999');
    expect(await bal(houseFees('trade', 'BTC'))).toBe('0.0005');
    expect(ledger.totalsByAsset()).toEqual({ USDT: '0', BTC: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a retry posts once', async () => {
    const input = fill('f2');
    await postedFill(input);
    const first = await ledger.post(recipes.tradeFillMakerRebate(input));
    const again = await ledger.post(recipes.tradeFillMakerRebate(input));
    expect(again.id).toBe(first.id);
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('0.0005');
    expect(await bal(houseFees('trade', 'BTC'))).toBe('0.0005');
  });

  it('a taker selling is the mirror: the rebate is in the quote the maker paid', async () => {
    const input = fill('f3', { takerSide: 'sell' });
    await postedFill(input);
    await ledger.post(recipes.tradeFillMakerRebate(input));
    // Taker fee 10 bps of 900 USDT = 0.9; rebate 5 bps = 0.45.
    expect(await bal(userAvailable(TAKER, 'USDT'))).toBe('899.1');
    expect(await bal(userAvailable(MAKER, 'USDT'))).toBe('0.45');
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('1');
    expect(await bal(houseFees('trade', 'USDT'))).toBe('0.45');
    expect(ledger.totalsByAsset()).toEqual({ BTC: '0', USDT: '0' });
  });

  it('with no fee in the house account it refuses and moves nothing', async () => {
    await expect(ledger.post(recipes.tradeFillMakerRebate(fill('f4')))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(userAvailable(MAKER, 'BTC'))).toBe('0');
    expect(await ledger.getTxByKey('trade.fill.rebate:f4')).toBeNull();
  });

  it('names the fill, its rates and the amount in the meta', () => {
    expect(recipes.tradeFillMakerRebate(fill('f5')).meta).toEqual({
      fillId: 'f5',
      makerOrderId: 'maker-f5',
      makerRebateBps: 5,
      takerFeeBps: 10,
      makerRebate: amt('0.0005').toString(),
    });
  });

  it('rounds down: 3 base units at 5 bps is nothing, and a post of nothing is refused', () => {
    expect(makerRebateFor(fill('f6', { qty: 3n, quoteAmount: 3n }))).toEqual({ assetId: 'BTC', amount: 0n });
    expect(() => recipes.tradeFillMakerRebate(fill('f6', { qty: 3n, quoteAmount: 3n }))).toThrow(/rounds to nothing/);
  });

  it('stays below the fill own taker fee at the smallest amount the rate pays anything', async () => {
    // 2000 base units: rebate floor(2000 × 5 / 10000) = 1, taker fee ceil(2000 × 6 / 10000) = 2.
    const input = fill('f7', { qty: 2000n, quoteAmount: 2000n, takerFeeBps: 6 });
    const fillTx = await postedFill(input);
    const houseLeg = recipes.tradeFill(input).entries.find((e) => e.account.ownerType === 'house');
    expect(fillTx.entries).toHaveLength(5);
    expect(houseLeg?.amount).toBe(2n);
    expect(makerRebateFor(input).amount).toBe(1n);
    await ledger.post(recipes.tradeFillMakerRebate(input));
    expect((await ledger.balance(houseFees('trade', 'BTC'))).amount).toBe(1n);
  });

  it.each([
    ['a rate equal to the taker fee', { makerRebateBps: 10 }, /below the taker fee/],
    ['a rate above the taker fee', { makerRebateBps: 11 }, /below the taker fee/],
    ['a maker who also pays a fee', { makerFeeBps: 2 }, /maker fee of 0 bps/],
    ['a rate of 0', { makerRebateBps: 0 }, /no rebate/],
    ['a negative rate', { makerRebateBps: -1 }, /whole number of bps/],
    ['a fractional rate', { makerRebateBps: 2.5 }, /whole number of bps/],
    ['a fractional taker rate', { takerFeeBps: 10.5 }, /whole number of bps/],
    ['no fill id', { fillId: ' ' }, /fillId is required/],
    ['a padded fill id', { fillId: ' f8' }, /no surrounding spaces/],
    ['no maker', { makerId: '' }, /makerId is required/],
    ['an empty fill', { qty: 0n }, /must be positive/],
  ] as const)('refuses %s with InvalidEntryError, before anything posts', (_label, over, message) => {
    const input = fill('f8', over as Partial<TradeFillMakerRebateInput>);
    expect(() => recipes.tradeFillMakerRebate(input)).toThrow(InvalidEntryError);
    expect(() => recipes.tradeFillMakerRebate(input)).toThrow(message);
  });
});
