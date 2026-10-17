import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { actorName } from '../account/actors';
import type { ActivityItem } from '../account/schemas';
import { failed, list, noop, plain } from '../account/testing';
import { parsePortalRoute } from '../../routes';
import type { ListFilters } from '../../ui/FilterRow';
import { actionWords, activityHref } from './model';
import { ActivityView } from './Activity';

const item = (patch: Partial<ActivityItem>): ActivityItem => ({
  id: 'a1',
  occurredAt: '2026-10-16T10:00:00.000Z',
  actorId: 'TEST-user',
  action: 'role_changed',
  objectType: 'team',
  objectId: 'TEST-user-finance',
  detail: {},
  ...patch,
});
const filters: ListFilters = {
  search: '',
  setSearch: noop,
  status: '',
  setStatus: noop,
  date: '',
  setDate: noop,
  from: '',
  setFrom: noop,
  to: '',
  setTo: noop,
  asset: '',
  setAsset: noop,
};
const rows = [
  item({}),
  item({
    id: 'a2',
    actorId: 'TEST-finance',
    action: 'captured',
    objectType: 'payment',
    objectId: 'pay-1',
    detail: { amount: '120.50', asset: 'USDT' },
  }),
  item({ id: 'a3', actorId: 'intafaced', action: 'approved', objectType: 'kyb', objectId: 'k1', detail: { toStatus: 'approved' } }),
  item({
    id: 'a4',
    actorId: 'founder:7',
    action: 'payout_pending',
    objectType: 'approval',
    objectId: 'ap1',
    detail: { destinationKind: 'bank', destinationMasked: '••••1234' },
  }),
];
const base = {
  filters,
  type: '',
  setType: noop,
  actor: '',
  setActor: noop,
  names: new Map([['TEST-finance', 'Accounts']]),
  me: 'TEST-user',
  state: list(rows),
  loadMore: noop,
  reload: noop,
};
const html = (extra: Partial<Parameters<typeof ActivityView>[0]> = {}) => renderToString(<ActivityView {...base} {...extra} />);

describe('activity', () => {
  it('is routed', () => {
    expect(parsePortalRoute('/pay/activity')).toEqual({ room: 'activity' });
  });
  it('shows names for people, "You" for yourself and "INTAFACED" for operators, never a founder identity or a raw id', () => {
    const out = html();
    expect(out).toContain('You');
    expect(out).toContain('Accounts');
    expect(out).toContain('INTAFACED');
    expect(out).not.toContain('founder');
    expect(out).not.toContain('TEST-user');
    plain(out);
  });
  it('maps actors the same way everywhere', () => {
    const names = new Map([['u1', 'Priya']]);
    expect(actorName('me', 'me', names)).toBe('You');
    expect(actorName('u1', 'me', names)).toBe('Priya');
    expect(actorName('system', 'me', names)).toBe('INTAFACED');
    expect(actorName('founder:abc', 'me', names)).toBe('INTAFACED');
    expect(actorName('op:abc', 'me', names)).toBe('INTAFACED');
    expect(actorName('stranger', 'me', names)).toBe('A team member');
  });
  it('shows exact amounts with the asset, masked destinations and plain verbs', () => {
    const out = html();
    expect(out).toContain('120.50');
    expect(out).toContain('USDT');
    expect(out).toContain('••••1234');
    expect(out).toContain('Payment: Captured');
    expect(out).toContain('Verification: Approved');
    expect(out).toContain('Payout request: Pending');
  });
  it('links every row to the page for the thing that changed', () => {
    const out = html();
    expect(out).toContain('href="/pay/payments/pay-1"');
    expect(out).toContain('href="/pay/team"');
    expect(out).toContain('href="/pay/compliance"');
    expect(out).toContain('href="/pay/approvals"');
    expect(activityHref({ objectType: 'dispute', objectId: 'd 1', action: 'responded' })).toBe('/pay/disputes/d%201');
    expect(activityHref({ objectType: 'webhook', objectId: 'w1', action: 'endpoint_active' })).toBe('/pay/developer/webhooks/w1');
    expect(activityHref({ objectType: 'webhook', objectId: 'w1', action: 'delivery_failed' })).toBe('/pay/developer/deliveries');
    expect(activityHref({ objectType: 'export', objectId: 'e1', action: 'export_ready' })).toBe('/pay/reports/exports');
  });
  it('turns actions into words', () => {
    expect(actionWords('export', 'export_ready')).toBe('Ready');
    expect(actionWords('approval', 'payout_pending')).toBe('Pending');
    expect(actionWords('dispute', 'evidence_added')).toBe('Evidence added');
  });
  it('has filters by type, who, date and search, and an honest count', () => {
    const out = html({ state: { status: 'ready', items: rows, hasMore: true, more: 'idle' } });
    expect(out).toContain('role="search"');
    expect(out).toContain('Everything');
    expect(out).toContain('Anyone');
    expect(out).toContain('4 shown');
    expect(out).toContain('finds one exact');
  });
  it('has loading, empty and failure states', () => {
    expect(html({ state: { status: 'loading' } })).toContain('aria-busy="true"');
    expect(html({ state: list([]) })).toContain('No activity yet');
    const bad = failed('pay.merchant_ops_unavailable', 503, 'unreachable');
    expect(html({ state: { status: 'failed', failure: bad.status === 'failed' ? bad.failure : (null as never) } })).toContain('Try again');
  });
});
