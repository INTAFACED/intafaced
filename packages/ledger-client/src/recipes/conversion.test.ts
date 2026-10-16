import { describe, expect, it } from 'vitest';
import { conversionInventory, houseFees, merchantClearing, merchantClearingHold, userAvailable, venueBoundary } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { fxConversion, fxConversionHold, fxConversionLateFill, fxConversionReverse } from './conversion.js';

const MERCHANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

const input = {
  conversionId: 'cv-1',
  merchantId: MERCHANT,
  merchantUserId: USER,
  venueId: 'binance-spot',
  fromAsset: 'USD',
  toAsset: 'USDT',
  fromAmount: amt('100'),
  toAmount: amt('97'),
  feeAmount: amt('2'),
  spreadAmount: amt('1'),
};

describe('fx conversion recipe', () => {
  it('posts a balanced fill and a reverse that keeps the venue exposure', async () => {
    const ledger = new MemoryLedger();
    const { recipes } = await import('./index.js');
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'p-usd',
        merchantId: MERCHANT,
        assetId: 'USD',
        amount: amt('100'),
        rail: 'test',
        railRef: 'cap-1',
      }),
    );
    await ledger.post(recipes.fxConversionHold({ conversionId: 'cv-1', merchantId: MERCHANT, fromAsset: 'USD', amount: amt('100') }));
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USD'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(merchantClearingHold(MERCHANT, 'USD', 'cv-1'))).amount)).toBe('100');

    await ledger.post(recipes.fxConversion(input));
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USD'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(merchantClearingHold(MERCHANT, 'USD', 'cv-1'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(venueBoundary('binance-spot', 'USD'))).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(venueBoundary('binance-spot', 'USDT'))).amount)).toBe('-100');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('97');
    expect(formatAmount((await ledger.balance(houseFees('pay', 'USDT'))).amount)).toBe('3');
    expect(ledger.reconcile()).toEqual({ ok: true });

    await ledger.post(recipes.fxConversionReverse(input));
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USD'))).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(venueBoundary('binance-spot', 'USD'))).amount)).toBe('100');
    expect(formatAmount((await ledger.balance(venueBoundary('binance-spot', 'USDT'))).amount)).toBe('-100');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(houseFees('pay', 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(conversionInventory('USD'))).amount)).toBe('-100');
    expect(formatAmount((await ledger.balance(conversionInventory('USDT'))).amount)).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
    expect(recipes.fxConversionReverse(input).entries.some((entry) => entry.account.ownerId?.startsWith('venue:'))).toBe(false);
  });

  it('omits a zero fee and still balances', async () => {
    const ledger = new MemoryLedger();
    const { recipes } = await import('./index.js');
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'p-usd-2',
        merchantId: MERCHANT,
        assetId: 'USD',
        amount: amt('10'),
        rail: 'test',
        railRef: 'cap-2',
      }),
    );
    await ledger.post(recipes.fxConversionHold({ conversionId: 'cv-2', merchantId: MERCHANT, fromAsset: 'USD', amount: amt('10') }));
    const post = recipes.fxConversion({
      ...input,
      conversionId: 'cv-2',
      fromAmount: amt('10'),
      toAmount: amt('10'),
      feeAmount: 0n,
      spreadAmount: 0n,
    });
    expect(post.entries.some((e) => e.account.ownerId?.startsWith('fees:'))).toBe(false);
    await ledger.post(post);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('books a late fill from clearing, and from inventory when the merchant cannot cover', async () => {
    const ledger = new MemoryLedger();
    const { recipes } = await import('./index.js');
    await ledger.post(
      recipes.paymentCapture({
        paymentId: 'p-usd-late',
        merchantId: MERCHANT,
        assetId: 'USD',
        amount: amt('100'),
        rail: 'test',
        railRef: 'cap-late',
      }),
    );
    const merchantPost = fxConversionLateFill({ ...input, auditId: 'audit-merchant', funding: 'merchant' });
    expect(merchantPost.idempotencyKey).toBe('pay.conversion.late:audit-merchant');
    expect(merchantPost.reason).toBe('pay.conversion.late_booked');
    expect(merchantPost.entries[0]?.account).toEqual(merchantClearing(MERCHANT, 'USD'));
    await ledger.post(merchantPost);
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USD'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('97');
    expect(formatAmount((await ledger.balance(houseFees('pay', 'USDT'))).amount)).toBe('3');
    expect(formatAmount((await ledger.balance(conversionInventory('USD'))).amount)).toBe('0');
    const replay = await ledger.post(merchantPost);
    expect(replay.id).toBe((await ledger.getTxByKey(merchantPost.idempotencyKey))?.id);

    const inventoryPost = fxConversionLateFill({
      ...input,
      conversionId: 'cv-short',
      auditId: 'audit-inventory',
      funding: 'inventory',
    });
    expect(inventoryPost.reason).toBe('pay.conversion.late_shortfall');
    expect(inventoryPost.entries[0]?.account).toEqual(conversionInventory('USD'));
    await ledger.post(inventoryPost);
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USD'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(conversionInventory('USD'))).amount)).toBe('-100');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('194');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a late fill with no audit id or an unknown funding source', () => {
    expect(() => fxConversionLateFill({ ...input, auditId: '   ', funding: 'merchant' })).toThrow(/auditId/);
    expect(() => fxConversionLateFill({ ...input, auditId: 'audit-x', funding: 'clearing' as 'merchant' })).toThrow(/funding/);
  });

  it('refuses a non-positive amount or the same asset on both sides', () => {
    expect(() => fxConversion({ ...input, fromAmount: 0n })).toThrow(/from amount/);
    expect(() => fxConversion({ ...input, toAmount: -1n })).toThrow(/to amount/);
    expect(() => fxConversion({ ...input, feeAmount: -1n })).toThrow(/fee/);
    expect(() => fxConversion({ ...input, toAsset: 'USD' })).toThrow(/assets must differ/);
    expect(() => fxConversionHold({ conversionId: 'cv-1', merchantId: MERCHANT, fromAsset: 'USD', amount: 0n })).toThrow(/hold/);
  });
});
