import type { MerchantControlProfile } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import {
  acceptControlChange,
  ageView,
  appliedMatches,
  asCap,
  asPricingRule,
  asTier,
  asUsage,
  bpsText,
  buildControlChange,
  EMPTY_CHANGE_FORM,
  formFromProfile,
  makeHandoff,
  parseHandoff,
  pricingChain,
  summariseControlChange,
  ttlText,
  usageMeter,
  validateReason,
  waitedText,
  type ChangeFormValues,
  type ControlChange,
  type PricingRuleView,
} from './control-model';

const MID = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-15T12:00:00.000Z');

const rule = (over: Partial<PricingRuleView> = {}): PricingRuleView => ({
  ruleId: '44444444-4444-4444-8444-444444444444',
  layer: 'global',
  scopeId: null,
  assetCode: 'USDT',
  bands: [{ fromAmount: '0', feeBps: 100, flatFee: null }],
  spreadBps: null,
  roundingBeneficiary: 'platform',
  minFee: null,
  maxFee: null,
  version: '1',
  createdAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

const form = (over: Partial<ChangeFormValues>): ChangeFormValues => ({ ...EMPTY_CHANGE_FORM, reason: 'Because we agreed', ...over });

describe('strict readers', () => {
  it('reads caps in exactly the contract shape and nothing else', () => {
    expect(asCap({ kind: 'daily_intake', assetCode: 'USDT', limit: '1000.5' })).toEqual({
      kind: 'daily_intake',
      assetCode: 'USDT',
      limit: '1000.5',
    });
    expect(asCap({ kind: 'beneficiaries_per_day', limit: 5 })).toEqual({ kind: 'beneficiaries_per_day', limit: 5 });
    expect(asCap({ kind: 'daily_intake', assetCode: 'USDT', limit: 1000 })).toBeNull();
    expect(asCap({ kind: 'daily_intake', assetCode: 'USDT', limit: '1', extra: true })).toBeNull();
    expect(asCap({ kind: 'beneficiaries_per_day', limit: 1.5 })).toBeNull();
    expect(asCap({ kind: 'surprise', limit: '1' })).toBeNull();
  });

  const tier = {
    id: 'standard',
    name: 'Standard',
    archetype: 'standard',
    caps: [{ kind: 'beneficiaries_per_day', limit: 3 }],
    reserve: null,
    approvalThresholds: [{ assetCode: 'USDT', amount: '100' }],
    founderThresholds: [{ assetCode: 'USDT', amount: '1000' }],
    approvalTtlSeconds: 3600,
    version: '2',
    merchants: 4,
  };

  it('reads a tier and refuses a half-shaped one', () => {
    expect(asTier(tier)?.name).toBe('Standard');
    expect(asTier({ ...tier, merchants: '4' })).toBeNull();
    expect(asTier({ ...tier, caps: [{ kind: 'x' }] })).toBeNull();
    expect(asTier({ ...tier, approvalThresholds: [{ assetCode: 'USDT', amount: 100 }] })).toBeNull();
    expect(asTier(null)).toBeNull();
  });

  it('reads a pricing rule view and refuses a bad band or layer', () => {
    const raw = { ...rule() };
    expect(asPricingRule(raw)?.layer).toBe('global');
    expect(asPricingRule({ ...raw, layer: 'galaxy' })).toBeNull();
    expect(asPricingRule({ ...raw, bands: [] })).toBeNull();
    expect(asPricingRule({ ...raw, bands: [{ fromAmount: '0', feeBps: 10_001, flatFee: null }] })).toBeNull();
    expect(asPricingRule({ ...raw, createdAt: 'yesterday' })).toBeNull();
  });

  it('reads usage rows and keeps a null used as "not measured"', () => {
    const usage = {
      merchantId: MID,
      tierId: 'standard',
      asOf: '2026-10-15T10:00:00.000Z',
      rows: [{ kind: 'per_payment', assetCode: 'USDT', limit: '50', used: null, remaining: null, resetsAt: null }],
    };
    expect(asUsage(usage)?.rows[0]?.used).toBeNull();
    expect(asUsage({ ...usage, rows: [{ ...usage.rows[0], kind: 'bogus' }] })).toBeNull();
    expect(asUsage({ ...usage, merchantId: 'nope' })).toBeNull();
  });
});

describe('words for numbers', () => {
  it('shows basis points with integer arithmetic', () => {
    expect(bpsText(150)).toBe('1.50% (150 bps)');
    expect(bpsText(5)).toBe('0.05% (5 bps)');
    expect(bpsText(10_000)).toBe('100.00% (10000 bps)');
  });

  it('shows a validity window the way a person says it', () => {
    expect(ttlText(86_400)).toBe('1 day');
    expect(ttlText(7200)).toBe('2 hours');
    expect(ttlText(90)).toBe('90 seconds');
    expect(ttlText(600)).toBe('10 minutes');
  });

  it('a usage meter says unmeasured, ok, near or full, in exact decimal arithmetic', () => {
    expect(usageMeter({ limit: '50', used: null })).toEqual({ permille: null, state: 'unmeasured' });
    expect(usageMeter({ limit: '1000', used: '100' })).toEqual({ permille: 100, state: 'ok' });
    expect(usageMeter({ limit: '1000', used: '800' }).state).toBe('near');
    expect(usageMeter({ limit: '1000', used: '1000' }).state).toBe('full');
    expect(usageMeter({ limit: '0', used: '0' }).state).toBe('full');
    expect(usageMeter({ limit: '9007199254740993', used: '9007199254740992' }).state).toBe('near');
  });

  it('the most specific pricing layer wins for each asset, and the rest are shown as overridden', () => {
    const chain = pricingChain([
      rule(),
      rule({ layer: 'merchant', scopeId: MID, ruleId: '55555555-5555-4555-8555-555555555555' }),
      rule({ assetCode: 'EUR' }),
    ]);
    expect(chain.map((c) => c.assetCode)).toEqual(['EUR', 'USDT']);
    const usdt = chain.find((c) => c.assetCode === 'USDT')!;
    expect(usdt.layers.map((l) => [l.rule.layer, l.inForce])).toEqual([
      ['merchant', true],
      ['global', false],
    ]);
  });

  it('age and time left are relative to each request’s own window; no SLA number is invented', () => {
    const young = ageView('2026-10-15T11:00:00.000Z', '2026-10-15T15:00:00.000Z', NOW);
    expect(young.age).toBe('waiting 1 h 0 min');
    expect(young.expiry).toMatchObject({ label: 'expires in 3 h 0 min', tone: 'live' });
    const late = ageView('2026-10-15T08:00:00.000Z', '2026-10-15T12:30:00.000Z', NOW);
    expect(late.expiry.tone).toBe('warn');
    expect(ageView('2026-10-15T08:00:00.000Z', '2026-10-15T11:59:59.000Z', NOW).expiry).toMatchObject({ label: 'expired', tone: 'danger' });
    expect(ageView('garbage', 'garbage', NOW).expiry.label).toBe('expiry unknown');
    expect(waitedText('2026-10-15T11:59:30.000Z', NOW)).toBe('under a minute');
    expect(waitedText('nope', NOW)).toBeNull();
  });
});

describe('the change form', () => {
  it('a reason is required and bounded', () => {
    expect(validateReason('ab')).toMatch(/at least 3/i);
    expect(validateReason('a'.repeat(501))).toMatch(/500/);
    expect(validateReason('  fine  ')).toBeNull();
  });

  it('a tier change needs a tier from the list and allows an empty archetype', () => {
    expect(buildControlChange(form({ kind: 'set_tier' }), MID)).toMatchObject({ ok: false, errors: { tierId: expect.any(String) } });
    expect(buildControlChange(form({ kind: 'set_tier', tierId: 'standard' }), MID)).toEqual({
      ok: true,
      change: { kind: 'set_tier', tierId: 'standard', archetypeId: null },
      reason: 'Because we agreed',
    });
    expect(buildControlChange(form({ kind: 'set_tier', tierId: 'standard', archetypeId: 'Bad Value' }), MID)).toMatchObject({ ok: false });
    expect(buildControlChange(form({ kind: 'set_tier', tierId: 'standard', reason: 'no' }), MID)).toMatchObject({
      ok: false,
      errors: { reason: expect.any(String) },
    });
  });

  it('caps: every row is checked, duplicates are caught, amounts stay decimal strings', () => {
    const good = buildControlChange(
      form({
        kind: 'set_caps',
        caps: [
          { kind: 'daily_intake', assetCode: 'usdt', limit: '1000.50' },
          { kind: 'beneficiaries_per_day', assetCode: '', limit: '5' },
        ],
      }),
      MID,
    );
    expect(good).toEqual({
      ok: true,
      reason: 'Because we agreed',
      change: {
        kind: 'set_caps',
        caps: [
          { kind: 'daily_intake', assetCode: 'USDT', limit: '1000.50' },
          { kind: 'beneficiaries_per_day', limit: 5 },
        ],
      },
    });
    const bad = buildControlChange(
      form({
        kind: 'set_caps',
        caps: [
          { kind: '', assetCode: '', limit: '' },
          { kind: 'daily_intake', assetCode: 'USDT', limit: '1e3' },
          { kind: 'daily_intake', assetCode: 'USDT', limit: '10' },
          { kind: 'beneficiaries_per_day', assetCode: '', limit: '1.5' },
        ],
      }),
      MID,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors)).toEqual(expect.arrayContaining(['caps.0.kind', 'caps.1.limit', 'caps.3.limit']));
    }
    const dup = buildControlChange(
      form({
        kind: 'set_caps',
        caps: [
          { kind: 'daily_intake', assetCode: 'USDT', limit: '1' },
          { kind: 'daily_intake', assetCode: 'usdt', limit: '2' },
        ],
      }),
      MID,
    );
    expect(dup).toMatchObject({ ok: false, errors: { 'caps.1.kind': expect.stringMatching(/twice/) } });
  });

  it('a reserve is both fields or neither; empty means none, never a default', () => {
    expect(buildControlChange(form({ kind: 'set_reserve' }), MID)).toMatchObject({
      ok: true,
      change: { kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } },
    });
    expect(buildControlChange(form({ kind: 'set_reserve', reserveBps: '500', holdDays: '7' }), MID)).toMatchObject({
      ok: true,
      change: { reserve: { rollingReserveBps: 500, holdDays: 7 } },
    });
    expect(buildControlChange(form({ kind: 'set_reserve', reserveBps: '500' }), MID)).toMatchObject({
      ok: false,
      errors: { holdDays: expect.any(String) },
    });
    expect(buildControlChange(form({ kind: 'set_reserve', reserveBps: '10001', holdDays: '7' }), MID)).toMatchObject({ ok: false });
    expect(buildControlChange(form({ kind: 'set_reserve', reserveBps: '5', holdDays: '366' }), MID)).toMatchObject({ ok: false });
  });

  it('pricing: bands must rise, who keeps the fraction must be chosen, the layer is always this merchant', () => {
    const base = {
      kind: 'set_pricing' as const,
      pricingAsset: 'usdt',
      pricingRounding: 'platform' as const,
      bands: [
        { fromAmount: '0', feeBps: '100', flatFee: '' },
        { fromAmount: '1000', feeBps: '80', flatFee: '0.30' },
      ],
    };
    expect(buildControlChange(form(base), MID)).toEqual({
      ok: true,
      reason: 'Because we agreed',
      change: {
        kind: 'set_pricing',
        pricing: [
          {
            layer: 'merchant',
            scopeId: MID,
            assetCode: 'USDT',
            bands: [
              { fromAmount: '0', feeBps: 100, flatFee: null },
              { fromAmount: '1000', feeBps: 80, flatFee: '0.30' },
            ],
            spreadBps: null,
            roundingBeneficiary: 'platform',
          },
        ],
      },
    });
    expect(buildControlChange(form({ ...base, pricingRounding: '' }), MID)).toMatchObject({
      ok: false,
      errors: { pricingRounding: expect.any(String) },
    });
    expect(
      buildControlChange(
        form({
          ...base,
          bands: [
            { fromAmount: '10', feeBps: '1', flatFee: '' },
            { fromAmount: '10', feeBps: '1', flatFee: '' },
          ],
        }),
        MID,
      ),
    ).toMatchObject({ ok: false, errors: { 'bands.1.fromAmount': expect.stringMatching(/higher/) } });
    expect(buildControlChange(form({ ...base, pricingSpread: '12000' }), MID)).toMatchObject({ ok: false });
  });

  it('starting values come from what is in force and never from an invented default', () => {
    const empty = formFromProfile(null, []);
    expect(empty.tierId).toBe('');
    expect(empty.caps).toEqual([{ kind: '', assetCode: '', limit: '' }]);
    expect(empty.reserveBps).toBe('');
    const unconfigured: MerchantControlProfile = {
      merchantId: MID,
      tierId: null,
      archetypeId: null,
      caps: null,
      pricing: null,
      reserve: null,
      version: '0',
      updatedAt: null,
    };
    expect(formFromProfile(unconfigured, [])).toMatchObject({ tierId: '', reserveBps: '', pricingAsset: '', pricingRounding: '' });
    const set = formFromProfile({ ...unconfigured, tierId: 'standard', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '5' }] }, [
      rule({ layer: 'merchant', scopeId: MID }),
    ]);
    expect(set).toMatchObject({ tierId: 'standard', pricingAsset: 'USDT', pricingRounding: 'platform' });
    expect(set.caps[0]).toEqual({ kind: 'daily_intake', assetCode: 'USDT', limit: '5' });
  });
});

describe('the request that travels between the two founders', () => {
  const change: ControlChange = { kind: 'set_caps', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '10' }] };

  it('round-trips exactly', () => {
    const text = makeHandoff({ requestId: REQ, merchantId: MID, expectedVersion: '3', change, reason: 'Raise cap' });
    expect(parseHandoff(text)).toEqual({ requestId: REQ, merchantId: MID, expectedVersion: '3', change, reason: 'Raise cap' });
  });

  it('refuses anything that is not exactly that shape', () => {
    const ok = JSON.parse(makeHandoff({ requestId: REQ, merchantId: MID, expectedVersion: '3', change, reason: 'r' })) as Record<
      string,
      unknown
    >;
    expect(parseHandoff('not json')).toBeNull();
    expect(parseHandoff(JSON.stringify({ ...ok, v: 2 }))).toBeNull();
    expect(parseHandoff(JSON.stringify({ ...ok, requestId: 'x' }))).toBeNull();
    expect(parseHandoff(JSON.stringify({ ...ok, expectedVersion: '03' }))).toBeNull();
    expect(
      parseHandoff(
        JSON.stringify({ ...ok, change: { kind: 'set_caps', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '10', extra: 1 }] } }),
      ),
    ).toBeNull();
    expect(parseHandoff(JSON.stringify({ ...ok, change: { kind: 'wipe_everything' } }))).toBeNull();
  });

  it('a pricing change must name this merchant and the merchant layer', () => {
    const pricing = {
      layer: 'merchant',
      scopeId: MID,
      assetCode: 'USDT',
      bands: [{ fromAmount: '0', feeBps: 1, flatFee: null }],
      spreadBps: null,
      roundingBeneficiary: 'platform',
    };
    expect(acceptControlChange({ kind: 'set_pricing', pricing: [pricing] }, MID)).not.toBeNull();
    expect(acceptControlChange({ kind: 'set_pricing', pricing: [{ ...pricing, layer: 'global' }] }, MID)).toBeNull();
    expect(acceptControlChange({ kind: 'set_pricing', pricing: [{ ...pricing, scopeId: 'someone-else' }] }, MID)).toBeNull();
  });

  it('after a confirm, what the service holds is compared with what the second founder was shown', () => {
    const profile = (over: Partial<MerchantControlProfile>): MerchantControlProfile => ({
      merchantId: MID,
      tierId: 'standard',
      archetypeId: null,
      caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '10' }],
      pricing: null,
      reserve: null,
      version: '4',
      updatedAt: null,
      ...over,
    });
    expect(appliedMatches(change, profile({}))).toBe(true);
    expect(appliedMatches(change, profile({ caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '11' }] }))).toBe(false);
    expect(appliedMatches(change, null)).toBe(false);
    expect(appliedMatches({ kind: 'set_tier', tierId: 'standard', archetypeId: null }, profile({}))).toBe(true);
    expect(appliedMatches({ kind: 'set_tier', tierId: 'gold', archetypeId: null }, profile({}))).toBe(false);
    expect(
      appliedMatches(
        { kind: 'set_reserve', reserve: { rollingReserveBps: 5, holdDays: 1 } },
        profile({ reserve: { rollingReserveBps: 5, holdDays: 1 } }),
      ),
    ).toBe(true);
    expect(appliedMatches({ kind: 'set_reserve', reserve: { rollingReserveBps: 5, holdDays: 1 } }, profile({ reserve: null }))).toBe(false);
    const pricing = {
      layer: 'merchant' as const,
      scopeId: MID,
      assetCode: 'USDT',
      bands: [{ fromAmount: '0', feeBps: 1, flatFee: null }],
      spreadBps: null,
      roundingBeneficiary: 'platform' as const,
    };
    expect(appliedMatches({ kind: 'set_pricing', pricing: [pricing] }, profile({ pricing: [pricing] }))).toBe(true);
    expect(
      appliedMatches({ kind: 'set_pricing', pricing: [pricing] }, profile({ pricing: [{ ...pricing, layer: 'global', scopeId: null }] })),
    ).toBe(false);
  });

  it('describes each change in words, with the tier by name when known', () => {
    expect(summariseControlChange({ kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } })[0]?.value).toMatch(
      /No money is withheld/,
    );
    expect(summariseControlChange(change)[0]?.value).toMatch(/Replaces every cap/);
    const lines = summariseControlChange({ kind: 'set_tier', tierId: 'standard', archetypeId: null }, [
      {
        id: 'standard',
        name: 'Standard',
        archetype: 'standard',
        caps: [],
        reserve: null,
        approvalThresholds: [],
        founderThresholds: [],
        approvalTtlSeconds: 60,
        version: '1',
        merchants: 0,
      },
    ]);
    expect(lines[0]?.value).toBe('Standard (standard)');
  });
});
