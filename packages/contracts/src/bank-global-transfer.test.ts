import { describe, expect, it } from 'vitest';
import {
  bankChargeBearerSchema,
  bankGlobalSendKey,
  bankGlobalTransferRefusalSchema,
  bankOurFeeRowSchema,
  bankRateLockPolicySchema,
} from './bank-global-transfer.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('international transfer contracts (BK-xfer-03)', () => {
  it('charge bearer is SHA or OUR only (BEN is not offered)', () => {
    expect(bankChargeBearerSchema.options).toEqual(['SHA', 'OUR']);
    expect(bankChargeBearerSchema.safeParse('BEN').success).toBe(false);
  });
  it('OUR fee row takes a decimal string, never a JSON number', () => {
    expect(bankOurFeeRowSchema.safeParse({ currency: 'EUR', fee: '25.00', feeAsset: 'USD' }).success).toBe(true);
    expect(bankOurFeeRowSchema.safeParse({ currency: 'EUR', fee: 25, feeAsset: 'USD' }).success).toBe(false);
    expect(bankOurFeeRowSchema.safeParse({ currency: 'eur', fee: '25', feeAsset: 'USD' }).success).toBe(false);
  });
  it('rate-lock policy has no defaults: a blank policy does not parse', () => {
    expect(bankRateLockPolicySchema.safeParse({}).success).toBe(false);
    expect(
      bankRateLockPolicySchema.safeParse({ windowSeconds: 0, misuseExpiredLocksBeforeRemoval: 3, floatingRateAllowed: false }).success,
    ).toBe(false);
    expect(
      bankRateLockPolicySchema.safeParse({ windowSeconds: 60, misuseExpiredLocksBeforeRemoval: 3, floatingRateAllowed: false }).success,
    ).toBe(true);
  });
  it('firm-rate FX is a typed refusal naming its blocker', () => {
    expect(bankGlobalTransferRefusalSchema.parse({ code: 'bank.fx_firm_rate_held', blocker: 'LG-fx-bank-grant-01' }).code).toBe(
      'bank.fx_firm_rate_held',
    );
    expect(
      bankGlobalTransferRefusalSchema.safeParse({ code: 'bank.fx_firm_rate_held', rate: '1.1', blocker: 'LG-fx-bank-grant-01' }).success,
    ).toBe(false);
  });
  it('recipient_incomplete lists at least one missing field', () => {
    expect(bankGlobalTransferRefusalSchema.safeParse({ code: 'bank.recipient_incomplete', missingFields: [] }).success).toBe(false);
    expect(bankGlobalTransferRefusalSchema.safeParse({ code: 'bank.recipient_incomplete', missingFields: ['bic'] }).success).toBe(true);
  });
  it('send key is global:<userId>:<draftSeq> and refuses bad parts', () => {
    expect(bankGlobalSendKey(uuid, 7)).toBe(`global:${uuid}:7`);
    expect(() => bankGlobalSendKey('a:b', 1)).toThrow();
    expect(() => bankGlobalSendKey(uuid, 0)).toThrow();
    expect(() => bankGlobalSendKey(uuid, 1.5)).toThrow();
  });
});
