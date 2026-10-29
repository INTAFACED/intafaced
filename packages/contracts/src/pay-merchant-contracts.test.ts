import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PAY_CAP_KINDS,
  PAY_HALT_ERROR_CODES,
  PAY_HALT_SCOPES,
  conversionLateFillBookProposeInputSchema,
  conversionLateFillProposeInputSchema,
  conversionQuoteInputSchema,
  conversionResolveConfirmInputSchema,
  conversionResolveProposeInputSchema,
  founderApprovalDestinationSchema,
  founderControlAuditEntrySchema,
  founderControlAuditListInputSchema,
  founderPendingChangeSchema,
  founderMerchantDrilldownSchema,
  kybDecisionBindingSchema,
  founderMerchantListInputSchema,
  founderMerchantListSchema,
  founderMerchantRowSchema,
  founderLimitRequestCloseResultSchema,
  founderPendingChangeListInputSchema,
  merchantLimitIncreaseInputSchema,
  merchantLimitRequestSchema,
  merchantLimitWithdrawResultSchema,
  merchantPricingHistorySchema,
  merchantTierListSchema,
  merchantTierSummarySchema,
  payPayoutFeeSchema,
  payoutApprovalSchema,
  merchantControlChangeInputSchema,
  merchantMetricsInputSchema,
  payAmountStringSchema,
  payStatementLineSchema,
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
    const resolve = { requestId: randomUUID(), conversionId: randomUUID(), reason: 'venue evidence' };
    expect(conversionResolveProposeInputSchema.safeParse(resolve).success).toBe(true);
    expect(conversionResolveProposeInputSchema.safeParse({ ...resolve, amount: '1' }).success).toBe(false);
    const confirm = {
      requestId: randomUUID(),
      decision: 'confirm' as const,
      reason: 'venue evidence',
      expectedChangeHash: `sha256:${'ab'.repeat(32)}`,
    };
    expect(conversionResolveConfirmInputSchema.safeParse(confirm).success).toBe(true);
    expect(conversionResolveConfirmInputSchema.safeParse({ ...confirm, filledFromAmount: '1' }).success).toBe(false);
    const lateFill = {
      requestId: randomUUID(),
      auditId: randomUUID(),
      settlement: 'customer made whole outside the book',
      reason: 'reviewed',
    };
    expect(conversionLateFillProposeInputSchema.safeParse(lateFill).success).toBe(true);
    expect(conversionLateFillProposeInputSchema.safeParse({ ...lateFill, filled: '1' }).success).toBe(false);
    expect(conversionLateFillProposeInputSchema.safeParse({ ...lateFill, settlement: '   ' }).success).toBe(false);
    const lateFillBook = { requestId: randomUUID(), auditId: randomUUID(), reason: 'book the venue fill' };
    expect(conversionLateFillBookProposeInputSchema.safeParse(lateFillBook).success).toBe(true);
    expect(conversionLateFillBookProposeInputSchema.safeParse({ ...lateFillBook, filled: '1' }).success).toBe(false);
    expect(conversionLateFillBookProposeInputSchema.safeParse({ ...lateFillBook, fromAmount: '100' }).success).toBe(false);
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
    expect(payHaltTargetSchema.safeParse({ level: 'user', userId: merchantId }).success).toBe(true);
    expect(payHaltTargetSchema.safeParse({ level: 'user' }).success).toBe(false);
    expect(payHaltTargetSchema.safeParse({ level: 'rail', railId: 'crypto-native' }).success).toBe(true);
    expect(payHaltTargetSchema.safeParse({ level: 'rail', railId: 'Bad Rail' }).success).toBe(false);
    expect(PAY_HALT_ERROR_CODES).toEqual([
      'pay.halt_store_unavailable',
      'pay.halt_target_not_found',
      'pay.halt_target_unsupported',
      'pay.halt_target_unknown_rail',
    ]);
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
      status: 'active' as const,
      metrics: snapshot,
      control: { merchantId, tierId: null, archetypeId: null, caps: null, pricing: null, reserve: null, version: '1', updatedAt: null },
      halts: { readable: true, autoTrip: { enabled: false, consecutiveFailures: null }, states: [] },
      pendingApprovals: [],
      pendingLimitRequests: [],
      recentAudit: [],
      auditTruncated: false,
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
    expect(founderMerchantDrilldownSchema.safeParse({ ...drilldown, status: 'live' }).success).toBe(false);
    const flagged = {
      requestId: randomUUID(),
      merchantId,
      caps: { raw: [{ kind: 'per_payment', assetCode: 'USDT', limit: 10 }], capsReadable: false as const },
      reason: 'stored ask',
      status: 'pending' as const,
      requestedBy: 'owner',
      createdAt: '2026-10-16T00:00:00.000Z',
    };
    expect(merchantLimitRequestSchema.parse(flagged).caps).toEqual(flagged.caps);
    expect(founderMerchantDrilldownSchema.safeParse({ ...drilldown, pendingLimitRequests: [flagged] }).success).toBe(true);
    expect(
      merchantLimitRequestSchema.safeParse({ ...flagged, caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: 10 }] }).success,
    ).toBe(false);
    const readable = [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '10' }];
    expect(merchantLimitRequestSchema.parse({ ...flagged, caps: readable }).caps).toEqual(readable);
  });

  it('a tier list with nothing configured carries no tier and no caps', () => {
    expect(merchantTierListSchema.parse({ status: 'not_configured', ownTierId: null })).toEqual({
      status: 'not_configured',
      ownTierId: null,
    });
    expect(merchantTierListSchema.safeParse({ status: 'not_configured', ownTierId: null, tiers: [] }).success).toBe(false);
    expect(
      merchantTierListSchema.safeParse({
        status: 'not_configured',
        ownTierId: 'starter',
        tiers: [{ id: 'starter', name: 'Starter', archetype: 'standard', caps: [], reserve: null, version: '1' }],
      }).success,
    ).toBe(false);
    expect(merchantTierListSchema.safeParse({ status: 'configured', ownTierId: null, tiers: [] }).success).toBe(false);
    const own = {
      id: 'test-tier',
      name: 'TEST VALUE',
      archetype: 'standard' as const,
      caps: [{ kind: 'beneficiaries_per_day' as const, limit: 1 }],
      reserve: null,
      fees: [],
      payoutFee: null,
      version: '1',
    };
    const configured = merchantTierListSchema.parse({ status: 'configured', ownTierId: 'test-tier', tiers: [own] });
    if (configured.status !== 'configured') throw new Error('expected the merchant’s own tier');
    expect(configured.tiers).toHaveLength(1);
    const other = { ...own, id: 'other-tier', name: 'Other' };
    const ladder = merchantTierListSchema.parse({ status: 'configured', ownTierId: 'test-tier', tiers: [own, other] });
    if (ladder.status !== 'configured') throw new Error('expected the ladder');
    expect(ladder.tiers.map((tier) => tier.id)).toEqual(['test-tier', 'other-tier']);
    expect(merchantTierListSchema.parse({ status: 'configured', ownTierId: null, tiers: [own, other] }).status).toBe('configured');
    expect(
      merchantTierListSchema.safeParse({
        status: 'configured',
        ownTierId: 'missing-tier',
        tiers: [own],
      }).success,
    ).toBe(false);
    expect(
      merchantTierListSchema.safeParse({
        status: 'configured',
        ownTierId: 'test-tier',
        tiers: [own, { ...own, founderThresholds: [{ assetCode: 'USDT', amount: '150' }] }],
      }).success,
    ).toBe(false);
  });

  it('a tier publishes its own fees and a payout fee that is only ever not_charged or unpublished', () => {
    const tier = {
      id: 'test-tier',
      name: 'TEST VALUE',
      archetype: 'standard' as const,
      caps: [{ kind: 'beneficiaries_per_day' as const, limit: 1 }],
      reserve: null,
      fees: [
        {
          assetCode: 'USDT',
          bands: [{ fromAmount: '0', feeBps: 250, flatFee: null }],
          spreadBps: null,
          roundingBeneficiary: 'platform' as const,
          minFee: null,
          maxFee: null,
          version: '1',
        },
      ],
      payoutFee: { kind: 'not_charged' as const },
      version: '1',
    };
    expect(merchantTierSummarySchema.parse(tier)).toEqual(tier);
    expect(merchantTierSummarySchema.parse({ ...tier, payoutFee: null }).payoutFee).toBeNull();
    // Unpublished is null, never a missing key, and no charged kind exists yet.
    const { payoutFee: _omit, ...withoutPayout } = tier;
    expect(merchantTierSummarySchema.safeParse(withoutPayout).success).toBe(false);
    expect(merchantTierSummarySchema.safeParse({ ...tier, payoutFee: { kind: 'charged', amount: '1' } }).success).toBe(false);
    expect(merchantTierSummarySchema.safeParse({ ...tier, payoutFee: { kind: 'not_charged', amount: '0' } }).success).toBe(false);
    expect(payPayoutFeeSchema.safeParse({ kind: 'free' }).success).toBe(false);
    // A fee-only role's fee row has no spreadBps key; a full-pricing row keeps null as "no spread configured".
    const { spreadBps: _spread, ...feeOnlyRow } = tier.fees[0];
    const feeOnly = merchantTierSummarySchema.parse({ ...tier, fees: [feeOnlyRow] });
    expect(feeOnly.fees[0]).not.toHaveProperty('spreadBps');
    expect(merchantTierSummarySchema.parse({ ...tier, fees: [{ ...feeOnlyRow, spreadBps: 35 }] }).fees[0]?.spreadBps).toBe(35);
    expect(merchantTierSummarySchema.safeParse({ ...tier, fees: [{ ...feeOnlyRow, spreadBps: '35' }] }).success).toBe(false);
    // A fee row carries a decimal string, never a number.
    expect(merchantTierSummarySchema.safeParse({ ...tier, fees: [{ ...tier.fees[0], minFee: 1 }] }).success).toBe(false);
  });

  it('pricing history with nothing configured carries no events', () => {
    expect(merchantPricingHistorySchema.parse({ status: 'not_configured', events: [] })).toEqual({
      status: 'not_configured',
      events: [],
    });
    expect(
      merchantPricingHistorySchema.safeParse({
        status: 'not_configured',
        events: [
          {
            ruleId: merchantId,
            layer: 'global',
            scopeId: null,
            assetCode: 'USDT',
            bands: [{ fromAmount: '0', feeBps: 250, flatFee: '0.3' }],
            spreadBps: null,
            roundingBeneficiary: 'platform',
            minFee: null,
            maxFee: null,
            version: '1',
            createdAt: '2026-10-16T00:00:00.000Z',
            supersededAt: null,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('a limit-increase ask refuses a numeric money cap', () => {
    const requestId = randomUUID();
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: 10 }],
        reason: 'need more room',
      }).success,
    ).toBe(false);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
        reason: 'need more room',
      }).success,
    ).toBe(true);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '0' }],
        reason: 'zero is not an ask',
      }).success,
    ).toBe(false);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '0.0' }],
        reason: 'zero is not an ask',
      }).success,
    ).toBe(false);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '0.5' }],
        reason: 'a fraction above zero',
      }).success,
    ).toBe(true);
    const thirty = '9'.repeat(30);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: thirty }],
        reason: 'thirty integer digits',
      }).success,
    ).toBe(true);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: `${thirty}9` }],
        reason: 'thirty-one integer digits',
      }).success,
    ).toBe(false);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'beneficiaries_per_day', limit: 0 }],
        reason: 'a zero count',
      }).success,
    ).toBe(false);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [{ kind: 'beneficiaries_per_day', limit: 1 }],
        reason: 'one beneficiary',
      }).success,
    ).toBe(true);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [
          { kind: 'per_payment', assetCode: 'USDT', limit: '10' },
          { kind: 'per_payment', assetCode: 'USDT', limit: '11' },
        ],
        reason: 'the same cap twice',
      }).success,
    ).toBe(false);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [
          { kind: 'per_payment', assetCode: 'USDT', limit: '10' },
          { kind: 'per_payment', assetCode: 'USD', limit: '11' },
        ],
        reason: 'same kind, two assets',
      }).success,
    ).toBe(true);
    expect(
      merchantLimitIncreaseInputSchema.safeParse({
        merchantId,
        requestId,
        caps: [
          { kind: 'beneficiaries_per_day', limit: 1 },
          { kind: 'beneficiaries_per_day', limit: 2 },
        ],
        reason: 'the count cap twice',
      }).success,
    ).toBe(false);
  });

  it('a founder close still succeeds when the stored caps are not a cap', () => {
    const closed = {
      requestId: randomUUID(),
      merchantId,
      reason: 'need more room',
      requestedBy: 'owner',
      createdAt: '2026-10-16T00:00:00.000Z',
      status: 'closed' as const,
      closedAt: '2026-10-16T01:00:00.000Z',
      closedBy: 'founder',
      closeReason: 'not this quarter',
    };
    const readable = [{ kind: 'per_payment' as const, assetCode: 'USDT', limit: '10' }];
    expect(founderLimitRequestCloseResultSchema.safeParse({ ...closed, caps: readable }).success).toBe(true);
    const unreadable = [{ kind: 'per_payment', assetCode: 'USDT', limit: 10 }];
    const parsed = founderLimitRequestCloseResultSchema.safeParse({ ...closed, caps: unreadable });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.caps).toEqual(unreadable);
    const withdrawn = { ...closed, status: 'withdrawn' as const, closeReason: 'taking it back' };
    expect(
      merchantLimitWithdrawResultSchema.safeParse({
        ...withdrawn,
        caps: { raw: unreadable, capsReadable: false },
      }).success,
    ).toBe(true);
    expect(merchantLimitWithdrawResultSchema.safeParse({ ...withdrawn, caps: readable }).success).toBe(true);
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

  it('a KYB decision binding is the identity fields and the hash', () => {
    const row = {
      merchantId,
      legalName: 'Shop Ltd',
      address: null,
      statementDescriptor: 'SHOP',
      industry: 'Retail',
      identityHash: `sha256:${'ab'.repeat(32)}`,
    };
    expect(kybDecisionBindingSchema.parse(row)).toEqual(row);
    expect(kybDecisionBindingSchema.safeParse({ ...row, profileVersion: '1' }).success).toBe(false);
    expect(kybDecisionBindingSchema.safeParse({ ...row, website: 'https://shop.example' }).success).toBe(false);
    expect(kybDecisionBindingSchema.safeParse({ ...row, identityHash: 'not-a-hash' }).success).toBe(false);
  });
});

describe('statement lines', () => {
  const line = {
    id: randomUUID(),
    merchantId,
    at: '2026-06-15T12:00:00.000Z',
    assetId: 'USDT',
    kind: 'payout' as const,
    amount: '9.75',
    account: 'proceeds' as const,
    direction: 'credit' as const,
    runningClearing: null,
    runningProceeds: null,
    windowNet: '-9.75',
    runningOrder: 'clear' as const,
    runningReason: 'no_opening' as const,
    paymentId: null,
    settlementId: randomUUID(),
    ledgerTxId: randomUUID(),
  };

  it('accepts a signed window net and the three running reasons', () => {
    expect(payStatementLineSchema.safeParse(line).success).toBe(true);
    expect(payStatementLineSchema.safeParse({ ...line, windowNet: '0', runningReason: 'no_opening' }).success).toBe(true);
    expect(
      payStatementLineSchema.safeParse({
        ...line,
        windowNet: null,
        runningReason: null,
        runningOrder: 'clear',
        runningClearing: '6',
        runningProceeds: '0',
      }).success,
    ).toBe(true);
    expect(
      payStatementLineSchema.safeParse({ ...line, windowNet: null, runningReason: 'order_ambiguous', runningOrder: 'order_ambiguous' })
        .success,
    ).toBe(true);
    expect(payStatementLineSchema.safeParse({ ...line, windowNet: '-1e2' }).success).toBe(false);
    expect(payStatementLineSchema.safeParse({ ...line, windowNet: -9.75 }).success).toBe(false);
    expect(payStatementLineSchema.safeParse({ ...line, runningReason: 'negative' }).success).toBe(false);
  });
});
