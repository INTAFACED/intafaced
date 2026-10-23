import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
// Server rendering has no external store snapshot for the language preference; read it directly.
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { ReactElement } from 'react';
import type { ApiResult } from '../../../../shared/api';
import type { Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import type { ListState } from '../hooks';
import { NotificationsView } from './Notifications';
import * as p from '../schemas';
import { notLiveWords } from '../ui/test-words';
// Everything below is TEST DATA written for these tests. None of it is a real merchant, customer or amount.
const portal = {} as PortalApi;
const html = (node: ReactElement) => renderToString(node);
const loading = { status: 'loading' } as const;
const ready = <T,>(data: T): Resource<T> => ({ status: 'ready', data });
type Refusal = Extract<ApiResult<never>, { ok: false }>;
const refusal = (code: string, status: number, reason: Refusal['reason'] = 'forbidden'): Refusal => ({
  ok: false,
  reason,
  message: code,
  code,
  status,
});
const failed = (code: string, status: number, reason: Refusal['reason'] = 'forbidden'): Resource<never> => ({
  status: 'failed',
  failure: refusal(code, status, reason),
});
const list = <T,>(items: T[], hasMore = false): ListState<T> => ({ status: 'ready', items, hasMore, more: 'idle' });
const noop = () => undefined;
/** Every page: no service code may reach the reader (B8). */
const expectPlain = (out: string) => expect(out).not.toMatch(/pay\.[a-z_]+/);
const fresh = { asOf: '2026-10-15T10:00:00.000Z', lagSeconds: 4 };
const snapshot = (patch: Partial<p.Snapshot> = {}): p.Snapshot => ({
  merchantId: 'm',
  freshness: fresh,
  balances: [{ assetCode: 'USDT', clearing: '10.5', available: '1234.560000000000000001' }],
  paymentCount: 12,
  statusMix: [
    { status: 'captured', count: 9 },
    { status: 'failed', count: 3 },
  ],
  captured: [{ assetCode: 'USDT', amount: '1500.25' }],
  refunded: [{ assetCode: 'USDT', amount: '20' }],
  net: [{ assetCode: 'USDT', amount: '1480.25' }],
  settlements: [],
  averagePayment: [{ assetCode: 'USDT', amount: '125.02' }],
  largestPayment: [{ assetCode: 'USDT', amount: '400' }],
  linkUsage: { linksUsed: 2, paymentsViaLinks: 5 },
  feeRevenue: [{ assetCode: 'USDT', amount: '15.0025' }],
  conversionVolume: null,
  ...patch,
});
const merchantRecord: p.MerchantRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  mode: 'gateway',
  status: 'active',
  kybStatus: 'approved',
  kybRef: 'ref-1',
  feeBps: 150,
};
describe('notifications', () => {
  const note = (patch: Partial<p.Notification> = {}): p.Notification => ({
    notificationId: 'n1',
    kind: 'dispute_opened',
    title: 'A customer challenged a payment',
    body: 'Payment pay-0001',
    subjectType: 'dispute',
    subjectId: 'dsp-1',
    createdAt: '2026-10-15T08:00:00.000Z',
    readAt: null,
    ...patch,
  });
  const prefs = ready<p.Preference[]>(
    p.notificationKinds.map((kind) => ({
      kind,
      inApp: kind !== 'team_change',
      threshold: kind === 'limit_threshold' ? '500.5' : null,
      updatedBy: kind === 'team_change' ? 'user-finance' : null,
      updatedAt: kind === 'team_change' ? '2026-10-15T07:00:00.000Z' : null,
    })),
  );
  const changes = list<p.PreferenceChange>([
    { seq: '3', kind: 'limit_threshold', inApp: true, threshold: '500.5', actorId: 'me-1', createdAt: '2026-10-15T07:30:00.000Z' },
    { seq: '2', kind: 'team_change', inApp: false, threshold: null, actorId: 'user-finance', createdAt: '2026-10-15T07:00:00.000Z' },
    { seq: '1', kind: 'export_ready', inApp: true, threshold: null, actorId: 'user-gone', createdAt: '2026-10-15T06:00:00.000Z' },
  ]);
  const render = (view: 'feed' | 'preferences', feed: ListState<p.Notification>, history: ListState<p.PreferenceChange> = changes) =>
    html(
      <NotificationsView
        portal={portal}
        view={view}
        setView={noop}
        feed={feed}
        kind=""
        setKind={noop}
        unreadOnly={false}
        setUnreadOnly={noop}
        prefs={prefs}
        loadMore={noop}
        reload={noop}
        reloadPrefs={noop}
        history={history}
        loadMoreHistory={noop}
        reloadHistory={noop}
        names={new Map([['user-finance', 'Accounts']])}
        myUserId="me-1"
      />,
    );
  it('shows a feed with unread marked in words and a link to the subject', () => {
    const out = render(
      'feed',
      list([
        note(),
        note({
          notificationId: 'n2',
          readAt: '2026-10-15T09:00:00.000Z',
          title: 'Export ready',
          kind: 'export_ready',
          subjectType: 'export',
        }),
      ]),
    );
    expect(out).toContain('A customer challenged a payment');
    expect(out).toMatch(/pp-sr">[^<]*<!-- -->unread/);
    expect(out).toContain('href="/pay/disputes/dsp-1"');
    expect(out).toContain('Mark read');
    expect(out).toContain('Mark all read');
  });
  it('has empty, loading and error states', () => {
    expect(render('feed', list<p.Notification>([]))).toContain('Nothing yet');
    expect(render('feed', { status: 'loading' })).toContain('aria-busy="true"');
    expect(render('feed', { status: 'failed', failure: refusal('', 503, 'unreachable') })).toContain('Try again');
  });
  it('lists every kind in preferences, says it is in-app only, and takes a threshold with no default', () => {
    const out = render('preferences', list<p.Notification>([]));
    for (const label of [
      'Payout waiting for approval',
      'Settlement failed',
      'Dispute response due',
      'Webhook failing',
      'INTAFACED paused something',
      'Team change',
    ])
      expect(out).toContain(label);
    expect(out).toContain('Nothing is sent by email or text');
    expect(out).toContain('Alert when a limit reaches');
    expect(out).toContain('value="500.5"');
    expect(out).toContain('There is no default');
    expect((out.match(/type="checkbox"/g) ?? []).length).toBe(p.notificationKinds.length);
  });
  it('shows every preference change with who made it, names not ids, and who saved each kind last', () => {
    const out = render('preferences', list<p.Notification>([]));
    expect(out).toContain('Change history');
    expect(out).toContain('Limit nearly reached turned on, alert at 500.5');
    expect(out).toContain('Team change turned off');
    expect(out).toContain('Export ready turned on');
    expect(out).toContain('By You');
    expect(out).toContain('By Accounts');
    expect(out).toContain('Last saved by Accounts');
    expect(out).not.toContain('user-finance');
    expect(out).not.toContain('user-gone');
    expect(out).not.toContain('History is not connected');
    expect(out).not.toContain('is not recorded');
  });
  it('has empty, loading and failed states for the change history, and no history on the feed', () => {
    expect(render('preferences', list<p.Notification>([]), list<p.PreferenceChange>([]))).toContain('No changes yet');
    expect(render('preferences', list<p.Notification>([]), { status: 'loading' })).toContain('aria-busy="true"');
    expect(
      render('preferences', list<p.Notification>([]), {
        status: 'failed',
        failure: refusal('pay.merchant_ops_unavailable', 503, 'unreachable'),
      }),
    ).toContain('Try again');
    expect(render('feed', list<p.Notification>([]))).not.toContain('Change history');
  });
});
