import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PAY_CAP_KINDS,
  PAY_HALT_SCOPES,
  conversionQuoteInputSchema,
  founderMerchantListInputSchema,
  merchantControlChangeInputSchema,
  merchantMetricsInputSchema,
  payAmountStringSchema,
  payCapSchema,
  payHaltSetInputSchema,
  payHaltStatusSchema,
  payHaltOperatorStatusSchema,
  payHaltTargetSchema,
  payRiskTierIdSchema,
} from './index.js';

const merchantId = randomUUID();

describe('pay contracts: money and ids', () => {
  it('amounts are decimal strings, never JSON numbers, with at most 18 places', () => {
    expect(payAmountStringSchema.safeParse('10.5').success).toBe(true);
    expect(payAmountStringSchema.safeParse(10.5).success).toBe(false);
    expect(payAmountStringSchema.safeParse('-1').success).toBe(false);
    expect(payAmountStringSchema.safeParse('1e3').success).toBe(false);
    expect(payAmountStringSchema.safeParse('0.1234567890123456789').success).toBe(false);
  });

  it('conversion and caps refuse a numeric amount', () => {
    const quote = { merchantId, settlementId: randomUUID(), fromAsset: 'USD', toAsset: 'USDT' };
    expect(conversionQuoteInputSchema.safeParse({ ...quote, fromAmount: '10' }).success).toBe(true);
    expect(conversionQuoteInputSchema.safeParse({ ...quote, fromAmount: 10 }).success).toBe(false);
    expect(payCapSchema.safeParse({ kind: 'daily_intake', assetCode: 'USD', limit: 1000 }).success).toBe(false);
    expect(payCapSchema.safeParse({ kind: 'beneficiaries_per_day', limit: 5 }).success).toBe(true);
  });

  it('tier ids are opaque slugs: no tier names are baked in', () => {
    expect(payRiskTierIdSchema.safeParse('starter').success).toBe(true);
    expect(payRiskTierIdSchema.safeParse('Tier One!').success).toBe(false);
    expect(PAY_CAP_KINDS).toContain('per_payment');
  });
});

describe('pay contracts: halts', () => {
  it('the merchant-facing status carries no operator reason, founder id or trip source', () => {
    const full = {
      scope: 'payout',
      target: { level: 'merchant', merchantId },
      halted: true,
      reason: 'suspected fraud ring',
      source: 'operator',
      actorUserId: randomUUID(),
      version: '3',
      changedAt: '2026-10-15T00:00:00Z',
    };
    expect(
      payHaltOperatorStatusSchema.safeParse({ readable: true, autoTrip: { enabled: false, consecutiveFailures: null }, states: [full] })
        .success,
    ).toBe(true);
    expect(payHaltStatusSchema.safeParse({ readable: true, states: [full] }).success).toBe(false);
    const safe = { scope: full.scope, target: full.target, halted: full.halted, changedAt: full.changedAt };
    expect(payHaltStatusSchema.safeParse({ readable: true, states: [safe] }).success).toBe(true);
  });

  it('covers intake, conversion, payout, settlement at global and merchant level', () => {
    expect([...PAY_HALT_SCOPES]).toEqual(['intake', 'conversion', 'payout', 'settlement']);
    expect(payHaltTargetSchema.safeParse({ level: 'global' }).success).toBe(true);
    expect(payHaltTargetSchema.safeParse({ level: 'merchant', merchantId }).success).toBe(true);
    expect(payHaltTargetSchema.safeParse({ level: 'merchant' }).success).toBe(false);
  });

  it('a halt command takes no actor from the body', () => {
    const cmd = {
      requestId: randomUUID(),
      scope: 'payout',
      target: { level: 'global' },
      halted: true,
      reason: 'venue failing',
      expectedVersion: '0',
    };
    expect(payHaltSetInputSchema.safeParse(cmd).success).toBe(true);
    expect(payHaltSetInputSchema.safeParse({ ...cmd, actorUserId: randomUUID() }).success).toBe(false);
  });
});

describe('pay contracts: operator and founder shapes', () => {
  it('operator changes carry no actor and require a version and a reason', () => {
    const change = {
      requestId: randomUUID(),
      merchantId,
      change: { kind: 'set_tier', tierId: 'starter', archetypeId: null },
      reason: 'new merchant',
      expectedVersion: '0',
    };
    expect(merchantControlChangeInputSchema.safeParse(change).success).toBe(true);
    expect(merchantControlChangeInputSchema.safeParse({ ...change, actorUserId: randomUUID() }).success).toBe(false);
    expect(merchantControlChangeInputSchema.safeParse({ ...change, reason: '' }).success).toBe(false);
  });

  it('the founder list requires a bounded limit; metrics windows are presets or explicit ranges', () => {
    expect(founderMerchantListInputSchema.safeParse({}).success).toBe(false);
    expect(founderMerchantListInputSchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(founderMerchantListInputSchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(merchantMetricsInputSchema.safeParse({ merchantId, window: { kind: 'preset', preset: 'rolling_7d' } }).success).toBe(true);
    expect(merchantMetricsInputSchema.safeParse({ merchantId, window: { kind: 'preset', preset: 'forever' } }).success).toBe(false);
  });
});
