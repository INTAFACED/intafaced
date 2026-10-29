import { describe, expect, it } from 'vitest';
import { STALE_AFTER_SECONDS, bars, lagParts, nameHold, newRequestId, staleness, waitingConfirmations } from './model';
import {
  businessDetails,
  merchantNames,
  destinationShapeOk,
  emptyBusiness,
  grantableRoles,
  isDecimalThreshold,
  memberActions,
  onboardingSteps,
  validateBusiness,
} from './settings/model';
import { mixShares, nextDueSoonest, seriesWindow } from './payments/model';
import { parsePortalRoute, portalRedirect } from './routes';
import type { Member, MerchantRecord, PaymentEvent, Series } from './schemas';

const merchant = (patch: Partial<MerchantRecord> = {}): MerchantRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  mode: 'gateway',
  status: 'pending',
  kybStatus: 'none',
  kybRef: null,
  feeBps: null,
  ...patch,
});

describe('time and freshness', () => {
  it('asks for whole UTC days ending tomorrow, so today is included', () => {
    expect(seriesWindow(new Date('2026-10-15T13:30:00.000Z'))).toEqual({
      from: '2026-09-16T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
    });
    expect(seriesWindow(new Date('2026-10-15T23:59:59.999Z'), 7)).toEqual({
      from: '2026-10-09T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
    });
  });
  it('never calls unknown freshness live', () => {
    expect(staleness({ asOf: null, lagSeconds: null })).toEqual({ kind: 'unknown' });
    expect(staleness({ asOf: '2026-10-15T00:00:00Z', lagSeconds: null })).toEqual({ kind: 'unknown' });
    expect(staleness({ asOf: '2026-10-15T00:00:00Z', lagSeconds: STALE_AFTER_SECONDS })).toEqual({
      kind: 'fresh',
      lagSeconds: STALE_AFTER_SECONDS,
    });
    expect(staleness({ asOf: '2026-10-15T00:00:00Z', lagSeconds: STALE_AFTER_SECONDS + 1 }).kind).toBe('stale');
  });
  it('speaks a lag in the largest sensible unit', () => {
    expect(lagParts(5)).toEqual({ n: 5, unit: 'seconds' });
    expect(lagParts(125)).toEqual({ n: 2, unit: 'minutes' });
    expect(lagParts(7300)).toEqual({ n: 2, unit: 'hours' });
  });
});

describe('daily bars', () => {
  const series: Series = {
    merchantId: 'm',
    freshness: { asOf: null, lagSeconds: null },
    points: [
      { day: '2026-10-13', assetCode: 'USDT', volume: '50.000000000000000001', feeRevenue: '0' },
      { day: '2026-10-15', assetCode: 'USDT', volume: '100.000000000000000002', feeRevenue: '0' },
      { day: '2026-10-15', assetCode: 'USD', volume: '9999', feeRevenue: '0' },
    ],
  };
  it('zero-fills quiet days and sizes bars by exact ratio, one asset at a time', () => {
    const rows = bars(series, 'USDT', 4, '2026-10-15');
    expect(rows.map((r) => r.day)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
    expect(rows.map((r) => r.volume)).toEqual(['0', '50.000000000000000001', '0', '100.000000000000000002']);
    expect(rows.map((r) => r.pct)).toEqual([0, 50, 0, 100]);
    expect(rows[3]!.today).toBe(true);
  });
  it('keeps every figure a decimal string', () => {
    for (const row of bars(series, 'USDT', 4, '2026-10-15')) expect(typeof row.volume).toBe('string');
  });
  it('draws nothing when the asset has no volume', () => {
    expect(bars(series, 'EUR', 3, '2026-10-15').every((r) => r.pct === 0)).toBe(true);
  });
  it('turns status counts into whole percentages and hides empty statuses', () => {
    expect(
      mixShares([
        { status: 'captured', count: 3 },
        { status: 'failed', count: 1 },
        { status: 'refunded', count: 0 },
      ]),
    ).toEqual([
      { status: 'captured', count: 3, pct: 75 },
      { status: 'failed', count: 1, pct: 25 },
    ]);
    expect(mixShares([])).toEqual([]);
  });
});

describe('onboarding progress', () => {
  it('starts at business details when there is no merchant', () => {
    const steps = onboardingSteps(null, null, false);
    expect(steps).toMatchObject({ business: 'current', verification: 'todo', payout: 'todo', current: 0, sandboxReady: false });
  });
  it('moves to verification once the account exists', () => {
    const steps = onboardingSteps(merchant(), 'none', false);
    expect(steps).toMatchObject({ business: 'done', verification: 'current', current: 1 });
  });
  it('waits for review after submission and offers the payout step', () => {
    const steps = onboardingSteps(merchant({ kybStatus: 'pending' }), 'pending', false);
    expect(steps).toMatchObject({ verification: 'waiting', payout: 'current', liveWaiting: true });
  });
  it('is live in sandbox only after a destination is saved, and live stays waiting until approval', () => {
    const steps = onboardingSteps(merchant({ kybStatus: 'pending' }), 'pending', true);
    expect(steps).toMatchObject({ payout: 'done', sandboxReady: true, liveWaiting: true });
    expect(onboardingSteps(merchant({ kybStatus: 'approved' }), 'approved', true).liveWaiting).toBe(false);
  });
  it('trusts the service status over a stale record', () => {
    expect(onboardingSteps(merchant({ kybStatus: 'none' }), 'approved', false).verification).toBe('done');
  });
});

describe('business details', () => {
  const good = { ...emptyBusiness, legalName: 'Acme Ltd', country: 'gb', businessType: 'Online shop', contactEmail: 'ops@acme.test' };
  it('accepts the minimum and normalises the country', () => {
    expect(validateBusiness(good)).toEqual({});
    expect(businessDetails(good)).toEqual({
      legalName: 'Acme Ltd',
      country: 'GB',
      businessType: 'Online shop',
      contactEmail: 'ops@acme.test',
    });
  });
  it('names each problem, not just that one exists', () => {
    expect(validateBusiness(emptyBusiness)).toEqual({
      legalName: 'required',
      country: 'country',
      businessType: 'required',
      contactEmail: 'email',
    });
    expect(validateBusiness({ ...good, website: 'ftp://x' }).website).toBe('website');
    expect(validateBusiness({ ...good, website: 'not a url' }).website).toBe('website');
    expect(validateBusiness({ ...good, country: 'GBR' }).country).toBe('country');
  });
  it('sends the legal name always and the trading name only when one was typed, both trimmed', () => {
    expect(merchantNames(good)).toEqual({ legalName: 'Acme Ltd' });
    expect(merchantNames({ ...good, legalName: '  Acme Ltd ', displayName: '   ' })).toEqual({ legalName: 'Acme Ltd' });
    expect(merchantNames({ ...good, displayName: '  Acme Shop ' })).toEqual({ legalName: 'Acme Ltd', displayName: 'Acme Shop' });
  });
  it('treats the trading name as optional but refuses one the service would refuse', () => {
    expect(validateBusiness({ ...good, displayName: '' })).toEqual({});
    expect(validateBusiness({ ...good, displayName: 'Acme Shop' })).toEqual({});
    expect(validateBusiness({ ...good, displayName: 'x'.repeat(121) }).displayName).toBe('name');
    expect(validateBusiness({ ...good, displayName: 'two\nlines' }).displayName).toBe('name');
    expect(validateBusiness({ ...good, legalName: 'x'.repeat(121) }).legalName).toBe('name');
    expect(validateBusiness({ ...good, legalName: 'bell\u0007' }).legalName).toBe('name');
    expect(validateBusiness({ ...good, displayName: 'x'.repeat(120) })).toEqual({});
    for (const c of [
      '\u061c',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202e',
      '\u2066',
      '\u2069',
      '\u2028',
      '\u2029',
      '\u200b',
      '\u2060',
      '\ufeff',
    ]) {
      expect(validateBusiness({ ...good, displayName: `a${c}b` }).displayName, c).toBe('name');
      expect(validateBusiness({ ...good, legalName: `a${c}b` }).legalName, c).toBe('name');
    }
    // A zero-width joiner is how emoji sequences are written, so it stays allowed.
    expect(validateBusiness({ ...good, displayName: '\u{1F468}\u200d\u{1F469} Shop' })).toEqual({});
  });
  it('labels declared volume as given text and never reads it as a number', () => {
    expect(businessDetails({ ...good, expectedVolume: 'about 40 payments a month' }).declaredExpectedVolume).toBe(
      'about 40 payments a month',
    );
  });
});

describe('payout destination shape', () => {
  it('accepts an EVM address and refuses anything else for crypto', () => {
    expect(destinationShapeOk('crypto', `0x${'a'.repeat(40)}`)).toBe(true);
    expect(destinationShapeOk('crypto', `0x${'a'.repeat(39)}`)).toBe(false);
    expect(destinationShapeOk('crypto', 'GB82WEST12345698765432')).toBe(false);
  });
  it('checks an IBAN with the mod-97 rule and accepts an IFSC shape for bank', () => {
    expect(destinationShapeOk('bank', 'GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(destinationShapeOk('bank', 'GB83WEST12345698765432')).toBe(false);
    expect(destinationShapeOk('bank', 'HDFC0001234')).toBe(true);
    expect(destinationShapeOk('bank', `0x${'a'.repeat(40)}`)).toBe(false);
  });
});

describe('team permissions on screen', () => {
  const member = (patch: Partial<Member>): Member => ({
    memberId: 'm1',
    userId: 'u1',
    role: 'viewer',
    status: 'active',
    label: null,
    invitedBy: 'o',
    createdAt: '2026-10-01T00:00:00.000Z',
    activatedAt: null,
    removedAt: null,
    cursor: null,
    ...patch,
  });
  it('lets only the owner hand out admin', () => {
    expect(grantableRoles('owner')).toContain('admin');
    expect(grantableRoles('admin')).not.toContain('admin');
    expect(grantableRoles('finance')).toEqual([]);
    expect(grantableRoles(null)).toEqual([]);
  });
  it('explains why a row is locked', () => {
    expect(memberActions('viewer', member({}))).toMatchObject({ canChange: false, reason: 'role' });
    expect(memberActions('admin', member({ role: 'admin' }))).toMatchObject({ canChange: false, reason: 'admin' });
    expect(memberActions('owner', member({ role: 'owner', memberId: null }))).toMatchObject({ canChange: false, reason: 'owner' });
    expect(memberActions('admin', member({}))).toMatchObject({ canChange: true, canRemove: true, reason: null });
    expect(memberActions('owner', member({ role: 'admin' })).canChange).toBe(true);
    expect(memberActions('owner', member({ status: 'removed' })).canChange).toBe(false);
  });
});

describe('small helpers', () => {
  it('makes a UUID request id', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });
  it('accepts only an unsigned decimal threshold', () => {
    for (const ok of ['1', '0.5', '1000.000000000000000001']) expect(isDecimalThreshold(ok)).toBe(true);
    for (const bad of ['', '-1', '1e3', '1,000', '1.0000000000000000001', 'abc']) expect(isDecimalThreshold(bad)).toBe(false);
  });
  it('finds the soonest dated deadline and ignores undated disputes', () => {
    expect(
      nextDueSoonest([{ responseDueAt: null }, { responseDueAt: '2026-11-02T00:00:00Z' }, { responseDueAt: '2026-10-20T00:00:00Z' }])
        ?.responseDueAt,
    ).toBe('2026-10-20T00:00:00Z');
    expect(nextDueSoonest([{ responseDueAt: null }])).toBeNull();
  });
});

describe('portal routes', () => {
  it('maps each page, decoding the id in a detail path', () => {
    expect(parsePortalRoute('/pay/merchant')).toEqual({ room: 'dashboard' });
    expect(parsePortalRoute('/pay/onboarding')).toEqual({ room: 'onboarding' });
    expect(parsePortalRoute('/pay/team?status=active')).toEqual({ room: 'team' });
    expect(parsePortalRoute('/pay/disputes')).toEqual({ room: 'disputes' });
    expect(parsePortalRoute('/pay/disputes/abc-1')).toEqual({ room: 'dispute', param: 'abc-1' });
    expect(parsePortalRoute('/pay/customers/cust%2F42')).toEqual({ room: 'customer', param: 'cust/42' });
    expect(parsePortalRoute('/pay/exports')).toBeNull();
    expect(portalRedirect('/pay/exports')).toBe('/pay/reports/exports');
    expect(parsePortalRoute('/pay/notifications')).toEqual({ room: 'notifications' });
  });
  it('leaves every other room to Business Pay, and opens the normal Disputes page for the retired disputed-payments view', () => {
    for (const path of ['/pay/links?view=tools', '/pay', '/p2p', '/pay/team/x/y', '/pay/exports/1'])
      expect(parsePortalRoute(path), path).toBeNull();
    expect(parsePortalRoute('/pay/disputes?view=payments')).toEqual({ room: 'disputes' });
  });
  it('registers every inventory address, and sends the three duplicates to their one home', () => {
    const rooms: Array<[string, string, string?]> = [
      ['/pay/payouts/new', 'payout-new'],
      ['/pay/payouts/destinations', 'payout-destinations'],
      ['/pay/network', 'network'],
      ['/pay/network/child-1', 'network-child', 'child-1'],
      ['/pay/permissions', 'permissions'],
      ['/pay/checkout', 'checkout-settings'],
      ['/pay/developer/sandbox', 'developer-sandbox'],
      ['/pay/developer/docs', 'developer-docs'],
      ['/pay/analytics', 'analytics'],
      ['/pay/analytics/fees', 'analytics-fees'],
      ['/pay/settings/security', 'settings-security'],
      ['/pay/activity', 'activity'],
      ['/pay/invoices/new', 'invoice-new'],
    ];
    for (const [path, room, param] of rooms) expect(parsePortalRoute(path), path).toEqual(param ? { room, param } : { room });
    expect(portalRedirect('/pay/settings/team')).toBe('/pay/team');
    expect(portalRedirect('/pay/developer')).toBe('/pay/developer/keys');
    expect(portalRedirect('/pay/exports?x=1')).toBe('/pay/reports/exports?x=1');
    expect(portalRedirect('/pay/team')).toBeNull();
    for (const path of ['/pay/settings/team', '/pay/exports', '/pay/developer']) expect(parsePortalRoute(path), path).toBeNull();
    // The onboarding hub and the go-live step stay two pages.
    expect(parsePortalRoute('/pay/onboarding')).toEqual({ room: 'onboarding' });
    expect(parsePortalRoute('/pay/onboarding/go-live')).toEqual({ room: 'onboarding', step: 'go-live' });
  });
  it('maps the W3b pages and keeps their older tools reachable', () => {
    expect(parsePortalRoute('/pay/payments?status=failed')).toEqual({ room: 'payments' });
    expect(parsePortalRoute('/pay/payments/aa000001-0000-4000-8000-000000000001')).toEqual({
      room: 'payment',
      param: 'aa000001-0000-4000-8000-000000000001',
    });
    expect(parsePortalRoute('/pay/settlements')).toEqual({ room: 'settlements' });
    expect(parsePortalRoute('/pay/settlements/bb1')).toEqual({ room: 'settlement', param: 'bb1' });
    expect(parsePortalRoute('/pay/payouts')).toEqual({ room: 'payouts' });
    expect(parsePortalRoute('/pay/payouts/bb1')).toEqual({ room: 'payout', param: 'bb1' });
    expect(parsePortalRoute('/pay/approvals')).toEqual({ room: 'approvals' });
    expect(parsePortalRoute('/pay/pricing')).toEqual({ room: 'pricing' });
    expect(parsePortalRoute('/pay/limits')).toEqual({ room: 'limits' });
    for (const path of [
      '/pay/payments?view=tools',
      '/pay/payments?view=tools&payment=x',
      '/pay/settlements?view=tools',
      '/pay/payouts?view=tools',
      '/pay/pricing/x',
      '/pay/payments/a/b',
    ])
      expect(parsePortalRoute(path), path).toBeNull();
  });
});

describe('a crypto payment waiting for confirmations (J-merchant-05 #4)', () => {
  const ev = (event: string, payload: Record<string, unknown>, id = 'e1'): PaymentEvent => ({
    id,
    event,
    payload,
    railEventId: null,
    ts: '2026-10-29T06:00:00.000Z',
  });

  it('reads the newest pending rail result while the payment is open, for the owner and for the team', () => {
    expect(waitingConfirmations('created', [ev('rail.pending', { confirmations: 2, required: 6 })])).toEqual({ seen: 2, required: 6 });
    expect(
      waitingConfirmations('created', [
        ev('rail.pending', { confirmations: 1, required: 6 }),
        ev('rail.pending', { confirmations: 4, required: 6 }, 'e2'),
      ]),
    ).toEqual({ seen: 4, required: 6 });
    const team: PaymentEvent = {
      id: 'e3',
      event: 'rail.pending',
      ts: '2026-10-29T06:00:00.000Z',
      amount: '60',
      assetId: 'USDT',
      failure: null,
      confirmations: { seen: 3, required: 6 },
    };
    expect(waitingConfirmations('created', [team])).toEqual({ seen: 3, required: 6 });
  });

  it('shows nothing once the payment moved on, after a later rail result, or with no count', () => {
    expect(waitingConfirmations('authorized', [ev('rail.pending', { confirmations: 2, required: 6 })])).toBeNull();
    expect(
      waitingConfirmations('created', [ev('rail.pending', { confirmations: 2, required: 6 }), ev('rail.declined', {}, 'e2')]),
    ).toBeNull();
    expect(waitingConfirmations('created', [ev('rail.pending', { received: '0', missing: '7' })])).toBeNull();
    expect(waitingConfirmations('created', [ev('rail.pending', { confirmations: '2', required: 6 })])).toBeNull();
    expect(waitingConfirmations('created', [])).toBeNull();
  });
});

describe('a bank transfer held for a name check (RC-merchant-09)', () => {
  const held = (payload: Record<string, unknown>): PaymentEvent => ({
    id: 'e1',
    event: 'payer_name.held',
    payload,
    railEventId: null,
    ts: '2026-10-25T01:00:00.000Z',
  });

  it('names the reason the service gave while the payment is still open', () => {
    expect(nameHold('created', [held({ reason: 'pay.payer_name_mismatch' })])).toBe('mismatch');
    expect(nameHold('created', [held({ reason: 'pay.payer_name_missing' })])).toBe('missing');
    expect(nameHold('created', [held({ reason: 'pay.name_match_rule_unset' })])).toBe('rule_unset');
  });

  it('shows nothing once the payment moved on, for a reason it does not know, or without the owner payload', () => {
    expect(nameHold('captured', [held({ reason: 'pay.payer_name_mismatch' })])).toBeNull();
    expect(nameHold('created', [])).toBeNull();
    expect(nameHold('created', [held({ reason: 'constructor' })])).toBeNull();
    expect(nameHold('created', [held({ reason: 'toString' })])).toBeNull();
    expect(nameHold('created', [held({})])).toBeNull();
    const team: PaymentEvent = {
      id: 'e2',
      event: 'payer_name.held',
      ts: '2026-10-25T01:00:00.000Z',
      amount: null,
      assetId: null,
      failure: null,
    };
    expect(nameHold('created', [team])).toBeNull();
  });
});
