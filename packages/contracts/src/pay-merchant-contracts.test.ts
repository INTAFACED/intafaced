import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PAY_CAP_KINDS,
  PAY_HALT_SCOPES,
  conversionQuoteInputSchema,
  founderApprovalDestinationSchema,
  founderControlAuditEntrySchema,
  founderControlAuditListInputSchema,
  founderPendingChangeSchema,
  founderMerchantDrilldownSchema,
  founderMerchantListInputSchema,
  founderMerchantListSchema,
  founderMerchantRowSchema,
  founderPendingChangeListInputSchema,
  payoutApprovalSchema,
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

  it('the founder list can look up exactly one merchant by id, and refuses anything else in the filter', () => {
    expect(founderMerchantListInputSchema.safeParse({ limit: 1, filter: { merchantId } }).success).toBe(true);
    expect(founderMerchantListInputSchema.safeParse({ limit: 1, filter: { merchantId: 'not-a-uuid' } }).success).toBe(false);
    expect(founderMerchantListInputSchema.safeParse({ limit: 1, filter: { merchantId, name: 'x' } }).success).toBe(false);
  });
});

describe('founder merchant names', () => {
  const fresh = { asOf: '2026-10-15T10:00:00.000Z', lagSeconds: 0 };
  const row = {
    merchantId,
    displayName: 'Acme Shop',
    status: 'active',
    tierId: null,
    kybStatus: 'approved',
    volume: [],
    revenue: [],
    openFlags: 0,
  };

  it('a list row carries displayName as a string or null, and nothing else about the name', () => {
    expect(founderMerchantRowSchema.parse(row).displayName).toBe('Acme Shop');
    expect(founderMerchantRowSchema.parse({ ...row, displayName: null }).displayName).toBeNull();
    // Required, not optional: a service that forgets the field is a contract error, not an unnamed merchant.
    const { displayName: _dropped, ...without } = row;
    expect(founderMerchantRowSchema.safeParse(without).success).toBe(false);
    expect(founderMerchantRowSchema.safeParse({ ...row, displayName: 7 }).success).toBe(false);
    // The legal name belongs to the drill-down only; the strict list row refuses it.
    expect(founderMerchantRowSchema.safeParse({ ...row, legalName: 'Acme Trading Ltd' }).success).toBe(false);
    expect(founderMerchantListSchema.safeParse({ freshness: fresh, rows: [row], nextCursor: null }).success).toBe(true);
    expect(founderMerchantListSchema.safeParse({ freshness: fresh, rows: [{ ...row, extra: 1 }], nextCursor: null }).success).toBe(false);
  });

  it('the drill-down carries displayName and legalName, both nullable and both required', () => {
    const snapshot = {
      merchantId,
      window: { kind: 'preset', preset: 'rolling_30d' },
      freshness: fresh,
      balances: [],
      paymentCount: 0,
      statusMix: [],
      captured: [],
      refunded: [],
      net: [],
      settlements: [],
      averagePayment: [],
      largestPayment: [],
      linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
      feeRevenue: [],
      conversionVolume: null,
    };
    const drilldown = {
      merchantId,
      displayName: 'Acme Shop',
      legalName: 'Acme Trading Ltd',
      metrics: snapshot,
      control: { merchantId, tierId: null, archetypeId: null, caps: null, pricing: null, reserve: null, version: '1', updatedAt: null },
      halts: { readable: true, autoTrip: { enabled: false, consecutiveFailures: null }, states: [] },
      pendingApprovals: [],
      operator: { kybStatus: 'approved', openFraudReviews: 0, parentMerchantId: null },
    };
    const parsed = founderMerchantDrilldownSchema.parse(drilldown);
    expect(parsed).toMatchObject({ displayName: 'Acme Shop', legalName: 'Acme Trading Ltd' });
    expect(founderMerchantDrilldownSchema.parse({ ...drilldown, displayName: null, legalName: null })).toMatchObject({
      displayName: null,
      legalName: null,
    });
    const { legalName: _l, ...noLegal } = drilldown;
    const { displayName: _d, ...noDisplay } = drilldown;
    expect(founderMerchantDrilldownSchema.safeParse(noLegal).success).toBe(false);
    expect(founderMerchantDrilldownSchema.safeParse(noDisplay).success).toBe(false);
    expect(founderMerchantDrilldownSchema.safeParse({ ...drilldown, tradingName: 'x' }).success).toBe(false);
  });
});

describe('pay contracts: founder cursors and destination reveal', () => {
  const max = '9223372036854775807';
  const over = '9223372036854775808';

  it('an audit or pending-change cursor must be a bigint, including the 19-digit maximum', () => {
    expect(founderControlAuditEntrySchema.shape.seq.safeParse('abc').success).toBe(false);
    expect(founderPendingChangeSchema.shape.seq.safeParse('abc').success).toBe(false);
    for (const schema of [founderControlAuditListInputSchema, founderPendingChangeListInputSchema]) {
      expect(schema.safeParse({ limit: 1, cursor: '1' }).success).toBe(true);
      expect(schema.safeParse({ limit: 1, cursor: max }).success).toBe(true);
      expect(schema.safeParse({ limit: 1, cursor: over }).success).toBe(false);
      expect(schema.safeParse({ limit: 1, cursor: '9999999999999999999' }).success).toBe(false);
      expect(schema.safeParse({ limit: 1, cursor: 'abc' }).success).toBe(false);
      expect(schema.safeParse({ limit: 1 }).success).toBe(true);
    }
  });

  it('the full destination is a founder reveal shape, and the merchant approval shape refuses it', () => {
    const approval = {
      approvalId: merchantId,
      merchantId,
      settlementId: randomUUID(),
      amount: '10',
      assetCode: 'USDT',
      payloadHash: `sha256:${'ab'.repeat(32)}`,
      status: 'pending' as const,
      makerUserId: randomUUID(),
      checkerUserId: null,
      createdAt: '2026-10-16T00:00:00.000Z',
      decidedAt: null,
      expiresAt: '2026-10-16T01:00:00.000Z',
      railId: 'crypto-native',
      destinationKind: 'crypto',
      destinationMasked: '0x1111…3333',
    };
    const ref = `0x${'ab'.repeat(20)}`;
    expect(payoutApprovalSchema.safeParse(approval).success).toBe(true);
    expect(payoutApprovalSchema.safeParse({ ...approval, destinationRef: ref }).success).toBe(false);
    expect(
      founderApprovalDestinationSchema.safeParse({
        approvalId: approval.approvalId,
        railId: approval.railId,
        destinationKind: approval.destinationKind,
        destinationRef: ref,
      }).success,
    ).toBe(true);
    expect(founderApprovalDestinationSchema.safeParse({ ...approval, destinationRef: ref }).success).toBe(false);
  });
});
