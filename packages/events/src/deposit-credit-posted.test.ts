import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, payDepositCreditPostedPayloadSchema, wiringSocketReason } from './catalog.js';

/** TEST data only. */
const base = {
  depositId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  assetId: 'USDT',
  networkId: 'ethereum',
  amount: '100.5',
  txHash: `0x${'ab'.repeat(32)}`,
  ledgerTxId: '33333333-3333-4333-8333-333333333333',
  creditedAt: '2026-10-24T00:00:00.000Z',
} as const;

describe('payDepositCreditPosted', () => {
  it('is declared on the pay service with a past-tense subject', () => {
    expect(EVENT_CATALOG.payDepositCreditPosted.subject).toBe('intafaced.pay.deposit_credit.posted');
    expect(EVENT_CATALOG.payDepositCreditPosted.version).toBe(1);
    expect(payDepositCreditPostedPayloadSchema.parse(base)).toEqual(base);
  });

  it('carries money as a decimal string, never a number, and no sign', () => {
    expect(payDepositCreditPostedPayloadSchema.safeParse({ ...base, amount: 100.5 }).success).toBe(false);
    expect(payDepositCreditPostedPayloadSchema.safeParse({ ...base, amount: '-1' }).success).toBe(false);
    expect(payDepositCreditPostedPayloadSchema.safeParse({ ...base, amount: '1.0000000000000000001' }).success).toBe(false);
  });

  it('refuses a credit without its deposit, its ledger transaction or its time, and extra fields', () => {
    for (const key of ['depositId', 'ledgerTxId', 'creditedAt', 'userId'] as const) {
      const { [key]: _gone, ...rest } = base;
      expect(payDepositCreditPostedPayloadSchema.safeParse(rest).success).toBe(false);
    }
    expect(payDepositCreditPostedPayloadSchema.safeParse({ ...base, ledgerTxId: 'not-a-uuid' }).success).toBe(false);
    expect(payDepositCreditPostedPayloadSchema.safeParse({ ...base, balance: '100' }).success).toBe(false);
  });

  it('is wired at both ends: no socket names a missing publisher or subscriber', () => {
    expect(wiringSocketReason('payDepositCreditPosted', 'subscriber')).toBeNull();
    expect(wiringSocketReason('payDepositCreditPosted', 'publisher')).toBeNull();
  });
});
