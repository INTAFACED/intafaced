import { beforeEach, describe, expect, it } from 'vitest';
import {
  futuresLossSink,
  houseFees,
  positionCollateralAccount,
  subAccountAvailable,
  subAccountPositionCollateral,
  userAvailable,
} from '../accounts.js';
import { IDEMPOTENCY_CONFLICT_CODE } from '../client.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { refusePostedFillPriceEdit } from './fill-correction.js';
import { recipes } from './index.js';

/**
 * S24 acceptance. Amounts are worked examples, not recomputed inside the assertion.
 *
 * Fill: taker buys 1 BTC for 900 USDT, maker fee 10 bps = 0.9 USDT, taker fee 20 bps = 0.002 BTC.
 * Correction returns 0.4 USDT of that maker fee. Loss examples are 10 USDT.
 */

const TAKER = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const SUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

const usdt = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);

function buyFillRequest(fillId: string, quoteAmount = '900') {
  return recipes.tradeFill({
    fillId,
    makerId: MAKER,
    takerId: TAKER,
    makerOrderId: `maker-${fillId}`,
    takerOrderId: `taker-${fillId}`,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: amt('1'),
    quoteAmount: amt(quoteAmount),
    takerSide: 'buy',
    makerFeeBps: 10,
    takerFeeBps: 20,
  });
}

async function postedBuyFill(fillId: string) {
  await ledger.post(recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `usdt-${fillId}` }));
  await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'BTC', amount: amt('2'), rail: 'test', railRef: `btc-${fillId}` }));
  await ledger.post(recipes.orderHold({ orderId: `taker-${fillId}`, userId: TAKER, assetId: 'USDT', amount: amt('900') }));
  await ledger.post(recipes.orderHold({ orderId: `maker-${fillId}`, userId: MAKER, assetId: 'BTC', amount: amt('1') }));
  return ledger.post(buyFillRequest(fillId));
}

function postedLegs(entries: ReadonlyArray<{ accountId: string; assetId: string; direction: string; amount: bigint }>) {
  return entries.map((entry) => ({
    accountId: entry.accountId,
    assetId: entry.assetId,
    direction: entry.direction,
    amount: formatAmount(entry.amount),
  }));
}

describe('TRD-0171 posted fill fee correction', () => {
  it('keeps the original trade.fill entries and moves the difference under a new key', async () => {
    const fill = await postedBuyFill('f1');
    const before = postedLegs(fill.entries);

    const correction = recipes.tradeFillFeeCorrection({
      fillId: 'f1',
      correctionId: 'c1',
      userId: MAKER,
      assetId: 'USDT',
      difference: amt('0.4'),
    });
    expect(correction.idempotencyKey).toBe('trade.fill.fee.correction:f1:c1');
    expect(correction.idempotencyKey).not.toBe('trade.fill:f1');

    const posted = await ledger.post(correction);
    expect(posted.idempotencyKey).toBe('trade.fill.fee.correction:f1:c1');
    expect(formatAmount(posted.entries[0]!.amount)).toBe('0.4');
    expect(formatAmount(posted.entries[1]!.amount)).toBe('0.4');

    const original = await ledger.getTxByKey('trade.fill:f1');
    expect(original?.id).toBe(fill.id);
    expect(postedLegs(original!.entries)).toEqual(before);
    const originalFee = original?.entries.find((entry) => entry.assetId === 'USDT' && formatAmount(entry.amount) === '0.9');
    expect(originalFee?.direction).toBe('debit');

    expect(await usdt(houseFees('trade', 'USDT'))).toBe('0.5');
    expect(await usdt(userAvailable(MAKER, 'USDT'))).toBe('899.5');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('does not post the fee again when the original fill id is replayed', async () => {
    const first = await postedBuyFill('f-replay');
    const second = await ledger.post(
      recipes.tradeFill({
        fillId: 'f-replay',
        makerId: MAKER,
        takerId: TAKER,
        makerOrderId: 'maker-f-replay',
        takerOrderId: 'taker-f-replay',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: amt('1'),
        quoteAmount: amt('900'),
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(await usdt(houseFees('trade', 'USDT'))).toBe('0.9');
    expect(await usdt(houseFees('trade', 'BTC'))).toBe('0.002');
  });

  it('rejects a fee that consumes the whole receivable before any fill row', async () => {
    expect(() =>
      recipes.tradeFill({
        fillId: 'f-dust',
        makerId: MAKER,
        takerId: TAKER,
        makerOrderId: 'maker-dust',
        takerOrderId: 'taker-dust',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        qty: 1n,
        quoteAmount: 1n,
        takerSide: 'buy',
        makerFeeBps: 10,
        takerFeeBps: 20,
      }),
    ).toThrow(/Fee exceeds fill value/);
    expect(await ledger.getTxByKey('trade.fill:f-dust')).toBeNull();
  });
});

describe('TRD-0187 posted fill price is immutable', () => {
  it('refuses an in-place price edit and leaves the fill row and trade.fill entries unchanged', async () => {
    const fill = await postedBuyFill('f-price');
    const before = JSON.stringify(postedLegs(fill.entries));

    expect(() => refusePostedFillPriceEdit({ fillId: 'f-price', price: amt('1'), qty: amt('1') })).toThrow(/cannot be changed in place/);

    const correction = recipes.tradeFillFeeCorrection({
      fillId: 'f-price',
      correctionId: 'not-a-price-edit',
      userId: MAKER,
      assetId: 'USDT',
      difference: amt('0.1'),
    });
    expect(correction.idempotencyKey).not.toBe('trade.fill:f-price');
    expect(correction.reason).toBe('trade.fill.fee.correction');

    const original = await ledger.getTxByKey('trade.fill:f-price');
    expect(original?.id).toBe(fill.id);
    expect(JSON.stringify(postedLegs(original!.entries))).toBe(before);
    const quoteLeg = original?.entries.find((entry) => entry.assetId === 'USDT' && formatAmount(entry.amount) === '900');
    expect(quoteLeg?.direction).toBe('credit');
  });

  it('does not change the price when the fill event is replayed, including a different quote', async () => {
    const fill = await postedBuyFill('f-dup');
    const replay = await ledger.post(buyFillRequest('f-dup'));
    expect(replay.id).toBe(fill.id);

    await expect(ledger.post(buyFillRequest('f-dup', '1'))).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT_CODE });

    const original = await ledger.getTxByKey('trade.fill:f-dup');
    const quoteLeg = original?.entries.find((entry) => entry.assetId === 'USDT' && formatAmount(entry.amount) === '900');
    expect(quoteLeg?.direction).toBe('credit');
    expect(await usdt(houseFees('trade', 'USDT'))).toBe('0.9');
  });
});

describe('TRD-0227 futures loss sink is not trade fees', () => {
  it('posts an isolated loss of 10 USDT to the loss sink and leaves trade house fees unchanged', async () => {
    await ledger.post(recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'loss-seed' }));
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-iso', userId: TAKER, assetId: 'USDT', amount: amt('10') }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos-iso',
        userId: TAKER,
        assetId: 'USDT',
        fromMargin: amt('10'),
        fromInsurance: 0n,
        lossId: 'loss-10',
      }),
    );

    expect(await usdt(houseFees('trade', 'USDT'))).toBe('0');
    expect(await usdt(futuresLossSink('USDT'))).toBe('10');
    expect(await usdt(positionCollateralAccount(TAKER, 'USDT', 'pos-iso'))).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('posts one loss id once, and a retry does not take the booked loss back out of the fee pot', async () => {
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'fee-seed' }));
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'fee-1',
        userId: MAKER,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('1'),
      }),
    );
    await ledger.post(recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'loss-seed-2' }));
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos-retry', userId: TAKER, assetId: 'USDT', amount: amt('10') }));

    const body = {
      positionId: 'pos-retry',
      userId: TAKER,
      assetId: 'USDT',
      fromMargin: amt('10'),
      fromInsurance: 0n,
      lossId: 'loss-once',
    };
    const first = await ledger.post(recipes.futuresRealizeLoss(body));
    const second = await ledger.post(recipes.futuresRealizeLoss(body));
    expect(second.id).toBe(first.id);
    expect(await usdt(houseFees('trade', 'USDT'))).toBe('1');
    expect(await usdt(futuresLossSink('USDT'))).toBe('10');
  });
});

describe('TRD-0533 sub-account deposit and liquidation stay on the named pot', () => {
  it('credits sub-account A and a liquidation on A leaves sub-account B and the parent unchanged', async () => {
    await ledger.post(
      recipes.deposit({
        userId: PARENT,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'test',
        railRef: 'dep-a',
        subAccountId: SUB_A,
        confirmed: true,
      }),
    );
    await ledger.post(
      recipes.futuresMarginLock({
        positionId: 'pos-a',
        userId: PARENT,
        assetId: 'USDT',
        amount: amt('10'),
        subAccountId: SUB_A,
      }),
    );
    const lossRequest = recipes.futuresRealizeLoss({
      positionId: 'pos-a',
      userId: PARENT,
      assetId: 'USDT',
      fromMargin: amt('10'),
      fromInsurance: 0n,
      lossId: 'liq-a',
      subAccountId: SUB_A,
    });
    expect(lossRequest.entries.every((entry) => entry.account.ownerType !== 'user')).toBe(true);
    expect(lossRequest.entries.some((entry) => entry.account.ownerId === SUB_B)).toBe(false);
    await ledger.post(lossRequest);
    expect(await usdt(subAccountAvailable(SUB_A, 'USDT'))).toBe('30');
    expect(await usdt(subAccountPositionCollateral(SUB_A, 'USDT', 'pos-a'))).toBe('0');
    expect(await usdt(subAccountAvailable(SUB_B, 'USDT'))).toBe('0');
    expect(await usdt(userAvailable(PARENT, 'USDT'))).toBe('0');
    expect(await usdt(futuresLossSink('USDT'))).toBe('10');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('rejects a loss aimed at a sibling pot', () => {
    expect(() =>
      recipes.futuresRealizeLoss({
        positionId: 'pos-a',
        userId: PARENT,
        assetId: 'USDT',
        fromMargin: amt('10'),
        fromInsurance: 0n,
        lossId: 'liq-sibling',
        subAccountId: SUB_A,
        drawSubAccountId: SUB_B,
      }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      recipes.futuresRealizeLoss({
        positionId: 'pos-a',
        userId: PARENT,
        assetId: 'USDT',
        fromMargin: amt('10'),
        fromInsurance: 0n,
        lossId: 'liq-sibling',
        subAccountId: SUB_A,
        drawSubAccountId: SUB_B,
      }),
    ).toThrow(/sibling/);
  });

  it('posts the same transferId once', async () => {
    await ledger.post(
      recipes.deposit({
        userId: PARENT,
        assetId: 'USDT',
        amount: amt('20'),
        rail: 'test',
        railRef: 'fund-a',
        subAccountId: SUB_A,
        confirmed: true,
      }),
    );
    await ledger.post(
      recipes.deposit({
        userId: PARENT,
        assetId: 'USDT',
        amount: amt('5'),
        rail: 'test',
        railRef: 'fund-b',
        subAccountId: SUB_B,
        confirmed: true,
      }),
    );
    const body = {
      transferId: 'xfer-1',
      fromSubAccountId: SUB_A,
      toSubAccountId: SUB_B,
      assetId: 'USDT',
      amount: amt('7'),
    };
    const first = await ledger.post(recipes.subAccountTransfer(body));
    const second = await ledger.post(recipes.subAccountTransfer(body));
    expect(second.id).toBe(first.id);
    expect(await usdt(subAccountAvailable(SUB_A, 'USDT'))).toBe('13');
    expect(await usdt(subAccountAvailable(SUB_B, 'USDT'))).toBe('12');
  });

  it('credits neither pot when the tagged deposit is unconfirmed', async () => {
    expect(() =>
      recipes.deposit({
        userId: PARENT,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'test',
        railRef: 'dep-pending',
        subAccountId: SUB_A,
        confirmed: false,
      }),
    ).toThrow(/unconfirmed deposit/);
    expect(await ledger.getTxByKey('deposit:test:dep-pending')).toBeNull();
    expect(await usdt(subAccountAvailable(SUB_A, 'USDT'))).toBe('0');
    expect(await usdt(subAccountAvailable(SUB_B, 'USDT'))).toBe('0');
    expect(await usdt(userAvailable(PARENT, 'USDT'))).toBe('0');
  });
});
