import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import {
  burnAccount,
  houseFees,
  loanReserve,
  merchantClearing,
  merchantProceeds,
  railBoundary,
  rewardsEngine,
  userAvailable,
} from '../accounts.js';
import { recipes } from './index.js';

/**
 * Residual package pins for recipes that had no dedicated suite on tip:
 * burn, paymentRefundReverse, sweepFeesToRewards (+ rewardPay trail),
 * loanReserveFund.
 *
 * Promise (W5 L14 Engine A / RECIPES.md matrix): every recipe in the registry
 * must keep a conservation path that cannot silently regress under a green
 * bank/token suite that never re-imports the pure builders.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const MERCHANT = '22222222-2222-4222-8222-222222222222';
const MERCHANT_USER = '33333333-3333-4333-8333-333333333333';
const RAIL = 'card-sandbox';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

async function deposit(userId: string, amount: string, tag: string, asset = 'USDT'): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId: asset,
      amount: amt(amount),
      rail: 'test',
      railRef: `dep-${tag}`,
    }),
  );
}

describe('loanReserveFund', () => {
  it('moves house bank fees into the loan reserve and is re-drive safe', async () => {
    await deposit(USER, '50', 'rsv');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'seed-rsv',
        userId: USER,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('50'),
      }),
    );
    expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('50');

    const body = { fundingId: 'fund-1', debtAssetId: 'USDT', amount: amt('50') };
    const first = await ledger.post(recipes.loanReserveFund(body));
    const second = await ledger.post(recipes.loanReserveFund(body));
    expect(second.id).toBe(first.id);
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('50');
    expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a zero funding amount at the recipe boundary', () => {
    expect(() => recipes.loanReserveFund({ fundingId: 'z', debtAssetId: 'USDT', amount: amt('0') })).toThrow(/reserve funding amount/);
  });
});

describe('paymentRefundReverse', () => {
  it('returns a rail-refused refund from the boundary back to clearing', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-1',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('100'),
        rail: RAIL,
        railRef: 'ch_pay-1',
      }),
    );
    const refundBody = {
      refundId: 'rf-1',
      paymentId: 'pay-1',
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      amount: amt('40'),
      rail: RAIL,
      source: 'clearing' as const,
    };
    await ledger.post(recipes.paymentRefund(refundBody));
    // Rail is the external boundary: capture drove it to -100; refunding 40
    // brings the platform's custody obligation to -60 (value that left the book).
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USDT'))).amount)).toBe('60');
    expect(formatAmount((await ledger.balance(railBoundary(RAIL, 'USDT'))).amount)).toBe('-60');

    await ledger.post(recipes.paymentRefundReverse(refundBody));
    // Reverse puts the 40 back on the merchant and restores the -100 rail tip.
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USDT'))).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(railBoundary(RAIL, 'USDT'))).amount)).toBe('-100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('returns a settled refund to merchant available when the rail refuses', async () => {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'pay-2',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('80'),
        rail: RAIL,
        railRef: 'ch_pay-2',
      }),
    );
    await ledger.post(
      recipes.merchantSettlement({
        merchantId: MERCHANT,
        merchantUserId: MERCHANT_USER,
        window: 'w1',
        assetId: 'USDT',
        gross: amt('80'),
        fee: amt('0'),
      }),
    );
    const refundBody = {
      refundId: 'rf-2',
      paymentId: 'pay-2',
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      amount: amt('30'),
      rail: RAIL,
      source: 'settled' as const,
    };
    await ledger.post(recipes.paymentRefund(refundBody));
    expect(formatAmount((await ledger.balance(merchantProceeds(MERCHANT, 'USDT'))).amount)).toBe('50');
    expect(formatAmount((await ledger.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');

    await ledger.post(recipes.paymentRefundReverse(refundBody));
    expect(formatAmount((await ledger.balance(merchantProceeds(MERCHANT, 'USDT'))).amount)).toBe('80');
    expect(formatAmount((await ledger.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('uses a distinct reverse key so refund and reverse never collide', () => {
    const body = {
      refundId: 'rf-x',
      paymentId: 'p',
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      amount: amt('1'),
      rail: RAIL,
      source: 'clearing' as const,
    };
    expect(recipes.paymentRefund(body).idempotencyKey).toBe('payment.refund:p:rf-x');
    expect(recipes.paymentRefundReverse(body).idempotencyKey).toBe('payment.refund.reverse:p:rf-x');
  });

  it('namespaces refund keys by paymentId so two payments may share a merchant refundId', () => {
    const base = {
      refundId: 'merchant-rf-1',
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      amount: amt('1'),
      rail: RAIL,
      source: 'clearing' as const,
    };
    const a = recipes.paymentRefund({ ...base, paymentId: 'pay-a' }).idempotencyKey;
    const b = recipes.paymentRefund({ ...base, paymentId: 'pay-b' }).idempotencyKey;
    expect(a).toBe('payment.refund:pay-a:merchant-rf-1');
    expect(b).toBe('payment.refund:pay-b:merchant-rf-1');
    expect(a).not.toBe(b);
  });
});

describe('burn', () => {
  it('moves tokens from the source into the burn pot and never invents supply', async () => {
    await deposit(USER, '25', 'burn', 'IFC');
    await ledger.post(
      recipes.burn({
        runId: 'burn-1',
        assetId: 'IFC',
        amount: amt('25'),
        from: userAvailable(USER, 'IFC'),
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'IFC'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(burnAccount('IFC'))).amount)).toBe('25');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('is re-drive safe on runId', async () => {
    await deposit(USER, '10', 'burn2', 'IFC');
    const body = {
      runId: 'burn-2',
      assetId: 'IFC',
      amount: amt('10'),
      from: userAvailable(USER, 'IFC'),
    };
    const first = await ledger.post(recipes.burn(body));
    const second = await ledger.post(recipes.burn(body));
    expect(second.id).toBe(first.id);
    expect(formatAmount((await ledger.balance(burnAccount('IFC'))).amount)).toBe('10');
  });

  it('keys burn by asset so the same runId on two assets is two burns', async () => {
    // Without assetId in the key, the second burn would return the first tx and
    // leave the second asset unburned — recon still green, supply still live.
    await deposit(USER, '5', 'burn-ifc', 'IFC');
    await deposit(USER, '5', 'burn-usdt', 'USDT');
    const ifc = await ledger.post(
      recipes.burn({ runId: 'shared-run', assetId: 'IFC', amount: amt('5'), from: userAvailable(USER, 'IFC') }),
    );
    const usdt = await ledger.post(
      recipes.burn({ runId: 'shared-run', assetId: 'USDT', amount: amt('5'), from: userAvailable(USER, 'USDT') }),
    );
    expect(usdt.id).not.toBe(ifc.id);
    expect(recipes.burn({ runId: 'shared-run', assetId: 'IFC', amount: amt('5'), from: userAvailable(USER, 'IFC') }).idempotencyKey).toBe(
      'token.burn:IFC:shared-run',
    );
    expect(formatAmount((await ledger.balance(burnAccount('IFC'))).amount)).toBe('5');
    expect(formatAmount((await ledger.balance(burnAccount('USDT'))).amount)).toBe('5');
  });
});

describe('mintEmission keys', () => {
  it('keys emission by asset so one epoch can mint more than one asset', () => {
    // Same failure class as burn: epoch-only key drops the second asset's mint.
    const ifc = recipes.mintEmission({
      epoch: 42,
      assetId: 'IFC',
      amount: amt('100'),
      destination: { ownerType: 'house', ownerId: 'rewards-engine', assetId: 'IFC', kind: 'available' },
    });
    const usdt = recipes.mintEmission({
      epoch: 42,
      assetId: 'USDT',
      amount: amt('50'),
      destination: { ownerType: 'house', ownerId: 'rewards-engine', assetId: 'USDT', kind: 'available' },
    });
    expect(ifc.idempotencyKey).toBe('token.emission:IFC:42');
    expect(usdt.idempotencyKey).toBe('token.emission:USDT:42');
    expect(ifc.idempotencyKey).not.toBe(usdt.idempotencyKey);
  });
});

describe('sweepFeesToRewards + rewardPay', () => {
  it('fees become real yield: house → rewards → user, two posts, one trail', async () => {
    await deposit(USER, '100', 'fee-src');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'trade-fee-1',
        userId: USER,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('100'),
      }),
    );
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('100');

    await ledger.post(
      recipes.sweepFeesToRewards({
        windowId: 'win-1',
        sourceModule: 'trade',
        assetId: 'USDT',
        amount: amt('100'),
      }),
    );
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('100');

    const recipient = '44444444-4444-4444-8444-444444444444';
    await ledger.post(
      recipes.rewardPay({
        rewardId: 'rw-1',
        userId: recipient,
        assetId: 'USDT',
        amount: amt('40'),
        reason: 'token.yield.paid',
      }),
    );
    expect(formatAmount((await ledger.balance(rewardsEngine('USDT'))).amount)).toBe('60');
    expect(formatAmount((await ledger.balance(userAvailable(recipient, 'USDT'))).amount)).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('sweep window is part of the key — a second window is a different movement', () => {
    const a = recipes.sweepFeesToRewards({
      windowId: 'w0',
      sourceModule: 'trade',
      assetId: 'USDT',
      amount: amt('1'),
    });
    const b = recipes.sweepFeesToRewards({
      windowId: 'w1',
      sourceModule: 'trade',
      assetId: 'USDT',
      amount: amt('1'),
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});
