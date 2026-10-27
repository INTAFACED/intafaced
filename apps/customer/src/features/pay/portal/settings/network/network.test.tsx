import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { PortalApi } from '../../api';
import { groups } from '../../home-layout/groups';
import { parsePortalRoute } from '../../routes';
import { bpsPercent, isPlatformAccount, parsePercentToBps } from '../account/model';
import type { Grant, PermissionEvent, SubMerchant, SubSummary } from '../account/schemas';
import { failed, noop, plain, ready } from '../account/testing';
import { NetworkChildView } from './NetworkChild';
import { NetworkView } from './Network';
import { PermissionsView } from './Permissions';

const A = 'c1000001-0000-4000-8000-000000000001';
const B = 'c2000002-0000-4000-8000-000000000002';
const node = (id: string, patch: Partial<SubMerchant> = {}): SubMerchant => ({
  id,
  userId: 'TEST-user',
  parentMerchantId: '11111111-1111-4111-8111-111111111111',
  mode: 'payfac',
  status: 'active',
  kybStatus: 'approved',
  settlingParty: 'self',
  feeBps: 150,
  depth: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...patch,
});
const summary = (patch: Partial<SubSummary> = {}): SubSummary => ({
  ...node(A),
  displayName: 'TEST Child Alpha',
  legalName: null,
  volume: { window: { preset: 'rolling_30d' }, items: [{ assetCode: 'USDT', volume: '2480.5', count: 31 }] },
  recentPayments: {
    items: [{ id: 'p1', status: 'captured', amount: '75', assetId: 'USDT', createdAt: '2026-10-16T00:00:00.000Z' }],
    nextCursor: null,
  },
  grants: { items: [{ area: 'payment.refund', granteeMerchantId: B }] },
  ...patch,
});

describe('network', () => {
  it('routes the network pages', () => {
    expect(parsePortalRoute('/pay/network')).toEqual({ room: 'network' });
    expect(parsePortalRoute(`/pay/network/${A}`)).toEqual({ room: 'network-child', param: A });
    expect(parsePortalRoute('/pay/permissions')).toEqual({ room: 'permissions' });
  });
  it('is for platform accounts only, in the menu and on the page', () => {
    expect(isPlatformAccount('payfac')).toBe(true);
    expect(isPlatformAccount('gateway')).toBe(false);
    expect(isPlatformAccount(null)).toBe(false);
    const platformOnly = groups
      .flatMap((g) => g.items)
      .filter(([, , options]) => options?.when === 'payfac')
      .map(([href]) => href);
    expect(platformOnly).toEqual(['/pay/network', '/pay/permissions']);
  });
  it('lists the businesses, each opening its own page, with the fee as a percent', () => {
    const out = renderToString(
      <NetworkView
        portal={{} as PortalApi}
        merchantId="m"
        subs={ready([node(A), node(B, { feeBps: null, status: 'pending', kybStatus: 'none' })])}
        reload={noop}
        mayCreate
      />,
    );
    expect(out).toContain(`href="/pay/network/${A}"`);
    expect(out).toContain('1.50%');
    expect(out).toContain('Not set up');
    expect(out).toContain('Add a business');
    plain(out);
  });
  it('has an empty state, and refuses adding for anyone but the owner with a reason', () => {
    const out = renderToString(<NetworkView portal={{} as PortalApi} merchantId="m" subs={ready([])} reload={noop} mayCreate={false} />);
    expect(out).toContain('No businesses in your network yet');
    expect(out).toContain('Only the account owner can add a business.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Add business<\/button>/);
  });
  it('names the blocker when the network read is not switched on', () => {
    const out = renderToString(
      <NetworkView portal={{} as PortalApi} merchantId="m" subs={failed('pay.not_built', 501, 'not_supported')} reload={noop} mayCreate />,
    );
    expect(out).toContain('the network pages are not connected here');
    expect(out).not.toContain('Coming soon');
  });
  it('turns a typed fee into whole basis points, and refuses anything else', () => {
    expect(parsePercentToBps('1.5')).toBe(150);
    expect(parsePercentToBps('0')).toBe(0);
    expect(parsePercentToBps('100')).toBe(10_000);
    expect(parsePercentToBps('100.01')).toBeNull();
    expect(parsePercentToBps('-1')).toBeNull();
    expect(parsePercentToBps('1.555')).toBeNull();
    expect(parsePercentToBps('')).toBeNull();
    expect(bpsPercent(5)).toBe('0.05%');
    expect(bpsPercent(10_000)).toBe('100.00%');
  });
});

describe('one business in the network', () => {
  it('shows facts, last-30-day volume per asset, the newest payments and who has access', () => {
    const out = renderToString(<NetworkChildView node={ready(node(A))} summary={ready(summary())} reload={noop} />);
    expect(out).toContain('TEST Child Alpha');
    expect(out).toContain('Last 30 days');
    expect(out).toContain('2,480.5');
    expect(out).toContain('USDT');
    expect(out).toContain('This is not the whole 30 days above.');
    expect(out).toContain('Payment refund');
    expect(out).toContain('Manage permissions');
    plain(out);
  });
  it('says plainly when the person has no access to payments or grants', () => {
    const out = renderToString(
      <NetworkChildView
        node={ready(node(A))}
        summary={ready(summary({ volume: null, recentPayments: null, grants: null }))}
        reload={noop}
      />,
    );
    expect(out).toContain('You don’t have access to this business’s payments');
    expect(out).toContain('You don’t have access to see who holds permissions');
  });
  it('keeps the facts and names the blocker when the summary is not switched on', () => {
    const out = renderToString(
      <NetworkChildView node={ready(node(A))} summary={failed('pay.not_built', 501, 'not_supported')} reload={noop} />,
    );
    expect(out).toContain('Summary is not connected here');
    expect(out).toContain('1.50%');
  });
});

describe('permissions', () => {
  const grant: Grant = {
    granteeMerchantId: B,
    subjectMerchantId: A,
    area: 'payment',
    reason: 'TEST reason',
    actorId: 'x',
    actorMerchantId: 'y',
    grantedAt: '2026-10-05T00:00:00.000Z',
  };
  const event: PermissionEvent = {
    id: 'e1',
    seq: '1',
    granteeMerchantId: B,
    subjectMerchantId: A,
    area: 'payment',
    action: 'grant',
    reason: 'TEST reason',
    actorId: 'x',
    actorMerchantId: 'y',
    createdAt: '2026-10-05T00:00:00.000Z',
  };
  const props = (extra: Partial<Parameters<typeof PermissionsView>[0]> = {}): Parameters<typeof PermissionsView>[0] => ({
    portal: {} as PortalApi,
    subs: ready([node(A, { id: A }), node(B)]),
    areas: ready(['payment', 'payment.refund']),
    grants: ready([grant]),
    history: ready([event]),
    selected: A,
    select: noop,
    mayWrite: true,
    reload: noop,
    reloadAll: noop,
    ...extra,
  });
  it('lists access given and its history, with a reviewed grant and take-back', () => {
    const out = renderToString(<PermissionsView {...props()} />);
    expect(out).toContain('Access given');
    expect(out).toContain('Take back');
    expect(out).toContain('Give access');
    expect(out).toContain('was given access to Payment');
    expect(out).toContain('TEST reason');
    plain(out);
  });
  it('needs a reason, and only the owner may change anything', () => {
    const out = renderToString(<PermissionsView {...props({ mayWrite: false })} />);
    expect(out).toContain('Only the account owner can change permissions.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Give access<\/button>/);
    expect(renderToString(<PermissionsView {...props()} />)).toContain('Add a reason of at least 3 characters.');
  });
  it('sends someone with no network to add a business first', () => {
    const out = renderToString(<PermissionsView {...props({ subs: ready([]) })} />);
    expect(out).toContain('Add a business');
    expect(out).toContain('/pay/network');
  });
});
