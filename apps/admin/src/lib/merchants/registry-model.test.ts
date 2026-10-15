import { describe, expect, it } from 'vitest';
import {
  acceptChange,
  asList,
  asNetwork,
  asPreview,
  asVenue,
  buildChange,
  changedKeys,
  EMPTY_FORM,
  explainRefusal,
  formFromView,
  kindFromSlug,
  looksSecretLike,
  summariseChange,
  type RegistryFormValues,
  type VenueView,
} from './registry-model';

const form = (over: Partial<RegistryFormValues>): RegistryFormValues => ({ ...EMPTY_FORM, reason: 'Adding a test venue', ...over });
const venueOk = {
  venueId: 'binance-testnet',
  displayName: 'Binance (testnet)',
  mode: 'testnet',
  priority: '10',
  minOrder: '10',
  maxOrder: '5000',
  supportedPairs: 'usdt/usd, USDC/USD',
};

describe('slugs', () => {
  it('maps url slugs to kinds and nothing else', () => {
    expect(kindFromSlug('venues')).toBe('venue');
    expect(kindFromSlug('wallet-routes')).toBe('wallet_route');
    expect(kindFromSlug('wallet_routes')).toBeNull();
    expect(kindFromSlug('../etc')).toBeNull();
  });
});

describe('venue form rules', () => {
  it('builds the exact save body, upper-casing pairs and keeping decimals as strings', () => {
    const r = buildChange('venue', form(venueOk), null);
    expect(r).toEqual({
      ok: true,
      change: {
        venueId: 'binance-testnet',
        displayName: 'Binance (testnet)',
        mode: 'testnet',
        priority: 10,
        enabled: false,
        minOrder: '10',
        maxOrder: '5000',
        supportedPairs: ['USDT/USD', 'USDC/USD'],
        expectedVersion: null,
        reason: 'Adding a test venue',
      },
    });
  });

  it('blank limits stay null (not configured), never zero', () => {
    const r = buildChange('venue', form({ ...venueOk, minOrder: '', maxOrder: '' }), 3);
    expect(r.ok && r.change).toMatchObject({ minOrder: null, maxOrder: null, expectedVersion: 3 });
  });

  it('explains every bad field in plain English', () => {
    const r = buildChange(
      'venue',
      form({
        venueId: 'Bad Id',
        displayName: '',
        mode: 'live',
        priority: 'x',
        minOrder: '1,000',
        maxOrder: '-1',
        supportedPairs: 'USDT-USD',
        reason: 'a',
      }),
      null,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual([
      'displayName',
      'maxOrder',
      'minOrder',
      'mode',
      'priority',
      'reason',
      'supportedPairs',
      'venueId',
    ]);
    expect(r.errors.mode).toMatch(/not allowed|switched off until Nitro and Phantom/i);
    expect(r.errors.minOrder).toMatch(/plain number/);
    for (const message of Object.values(r.errors)) expect(message).not.toMatch(/ZodError|undefined|\[object/);
  });

  it('refuses an inverted order range using exact comparison', () => {
    const r = buildChange('venue', form({ ...venueOk, minOrder: '9007199254740993', maxOrder: '9007199254740992' }), null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.minOrder).toMatch(/cannot be larger/);
  });

  it('refuses text that looks like a credential', () => {
    expect(looksSecretLike('sk_live_abcdefghijklmnop')).toBe(true);
    expect(looksSecretLike('Raising the testnet cap')).toBe(false);
    const r = buildChange('venue', form({ ...venueOk, reason: 'api key: abcdefghijkl' }), null);
    expect(!r.ok && r.errors.reason).toMatch(/key or password/);
  });
});

describe('network and wallet route rules', () => {
  it('fixed fee needs an amount, other sources forbid one', () => {
    const base = { networkId: 'ethereum-sepolia', displayName: 'Sepolia', assetCodes: 'usdt', confirmationsRequired: '12' };
    const missing = buildChange('network', form({ ...base, feeEstimateSource: 'fixed' }), null);
    expect(!missing.ok && missing.errors.feeEstimateAmount).toMatch(/needs an amount/);
    const extra = buildChange('network', form({ ...base, feeEstimateSource: 'chain_estimate', feeEstimateAmount: '1' }), null);
    expect(!extra.ok && extra.errors.feeEstimateAmount).toMatch(/only to the fixed/);
    const good = buildChange('network', form({ ...base, feeEstimateSource: 'fixed', feeEstimateAmount: '0.5' }), null);
    expect(good.ok && good.change).toMatchObject({
      assetCodes: ['USDT'],
      confirmationsRequired: 12,
      feeEstimateSource: 'fixed',
      feeEstimateAmount: '0.5',
    });
  });

  it('a wallet route needs real merchant ids and keeps a blank payout cap as null', () => {
    const bad = buildChange('wallet_route', form({ assetCode: 'usdt', networkId: 'ethereum-sepolia', merchantAllow: 'not-a-uuid' }), null);
    expect(!bad.ok && bad.errors.merchantAllow).toMatch(/not a merchant id/);
    const id = '11111111-1111-4111-8111-111111111111';
    const good = buildChange(
      'wallet_route',
      form({ assetCode: 'usdt', networkId: 'ethereum-sepolia', merchantDeny: id.toUpperCase() }),
      null,
    );
    expect(good.ok && good.change).toMatchObject({ assetCode: 'USDT', merchantDeny: [id], maxSinglePayout: null, payoutAllowed: false });
  });
});

describe('what the BFF will forward', () => {
  const change = (buildChange('venue', form(venueOk), null) as { ok: true; change: Record<string, unknown> }).change;

  it('accepts exactly the documented keys, plus the approval pair', () => {
    expect(acceptChange('venue', change)).toBe(change);
    expect(acceptChange('venue', { ...change, approvalId: 'a', operationId: 'o' })).not.toBeNull();
  });

  it('refuses unknown keys such as a credential, missing keys and nested objects', () => {
    expect(acceptChange('venue', { ...change, apiKey: 'x' })).toBeNull();
    expect(acceptChange('venue', { ...change, secret: 'x' })).toBeNull();
    const { reason: _drop, ...noReason } = change;
    expect(acceptChange('venue', noReason)).toBeNull();
    expect(acceptChange('venue', { ...change, supportedPairs: [{ a: 1 }] })).toBeNull();
    expect(acceptChange('venue', 'x')).toBeNull();
    expect(acceptChange('network', change)).toBeNull();
  });
});

describe('plain-English refusals', () => {
  it('never shows a code or status number as the message', () => {
    const codes = [
      'registries.live_mode_refused',
      'registries.version_conflict',
      'registries.create_must_be_inert',
      'action_approval.same_person',
      'action_approval.payload_mismatch',
      'action_approval.expired',
      'action_approval.founder_only',
      'action_approval.not_founders',
      'missing_operator',
      'operator.denied',
    ];
    for (const code of codes) {
      const p = explainRefusal(code, `${code}: internal text`, 409);
      expect(p.title.length).toBeGreaterThan(10);
      for (const part of [p.title, p.body, p.next]) {
        expect(part).not.toMatch(/registries\.|action_approval\.|\b4\d\d\b|\b5\d\d\b/);
      }
    }
  });

  it('finds a code inside a message and falls back by status', () => {
    expect(explainRefusal(null, 'registries.version_conflict: the entry changed', 409).title).toMatch(/changed while you were editing/);
    expect(explainRefusal(null, 'action_approval.same_person', 412).title).toMatch(/cannot approve your own/);
    expect(explainRefusal(null, '', 503).title).toMatch(/could not answer/);
    expect(explainRefusal('something.new', 'weird', 400).title).toMatch(/did not accept these values/);
  });
});

describe('view guards', () => {
  const venue: VenueView = {
    venueId: 'v',
    displayName: 'V',
    mode: 'testnet',
    priority: 1,
    enabled: false,
    minOrder: null,
    maxOrder: null,
    supportedPairs: [],
    health: null,
    version: 1,
    updatedAt: '2026-10-15T00:00:00.000Z',
    updatedBy: 'u',
    routable: false,
    missing: ['min_order'],
  };

  it('accepts what the service sends and rejects anything shaped differently', () => {
    expect(asVenue(venue)).toEqual(venue);
    expect(asVenue({ ...venue, priority: '1' })).toBeNull();
    expect(asNetwork(venue)).toBeNull();
    expect(asList([venue, venue], asVenue)).toHaveLength(2);
    expect(asList([venue, { nope: 1 }], asVenue)).toBeNull();
    expect(asList({}, asVenue)).toBeNull();
    expect(asPreview({ needsDualControl: true, reasons: ['enable'], actionType: 'a', payloadHash: 'sha256:x' })).not.toBeNull();
    expect(asPreview({ needsDualControl: 'yes' })).toBeNull();
  });

  it('round-trips a loaded entry through the form and back to the same change', () => {
    const values = formFromView('venue', venue);
    expect(values.minOrder).toBe('');
    const built = buildChange('venue', { ...values, reason: 'No change, just checking' }, venue.version);
    expect(built.ok && built.change).toMatchObject({ venueId: 'v', minOrder: null, expectedVersion: 1 });
  });

  it('marks only the changed rows in the review', () => {
    const before = (buildChange('venue', form(venueOk), null) as { ok: true; change: Record<string, unknown> }).change;
    const after = { ...before, priority: 20, reason: 'Moving it later in the queue' };
    expect([...changedKeys('venue', before, after)].sort()).toEqual(['priority', 'reason']);
    expect(changedKeys('venue', null, after).size).toBeGreaterThan(5);
    expect(summariseChange('venue', after).some((r) => r.key === 'expectedVersion')).toBe(false);
  });
});
