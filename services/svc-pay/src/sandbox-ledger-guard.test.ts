import { describe, expect, it } from 'vitest';
import { merchantClearing, merchantProceeds, railBoundary, recipes, userAvailable } from '@intafaced/ledger-client';
import { isLiveLedgerAccount, liveAccountsIn } from './sandbox-ledger-guard.js';

describe('sandbox ledger guard', () => {
  it('treats a sandbox rail boundary as not live and every merchant pot as live', () => {
    expect(isLiveLedgerAccount(railBoundary('card-sandbox', 'USDT'))).toBe(false);
    expect(isLiveLedgerAccount(railBoundary('bank-sandbox', 'USDT'))).toBe(false);
    expect(isLiveLedgerAccount(railBoundary('crypto-native', 'USDT'))).toBe(true);
    expect(isLiveLedgerAccount(merchantClearing('m', 'USDT'))).toBe(true);
    expect(isLiveLedgerAccount(merchantProceeds('m', 'USDT'))).toBe(true);
    expect(isLiveLedgerAccount(userAvailable('u', 'USDT'))).toBe(true);
  });

  it('a capture recipe always names a live clearing account', () => {
    const request = recipes.paymentCapture({
      paymentId: 'pay',
      merchantId: 'm',
      assetId: 'USDT',
      amount: 1n,
      rail: 'card-sandbox',
      railRef: 'ch_pay',
    });
    expect(liveAccountsIn(request).map((account) => account.ownerId)).toEqual(['pay:clearing:m']);
  });
});
