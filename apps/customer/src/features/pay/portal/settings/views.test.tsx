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
import { ExportsView } from './Exports';
import type { ListState } from '../hooks';
import { NotificationsView } from './Notifications';
import { OnboardingView } from './Onboarding';
import { TeamView } from './Team';
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
describe('onboarding', () => {
  const base = {
    portal,
    kyb: ready<{ kybStatus: 'none' | 'pending' | 'approved' | 'rejected'; kybRef: string | null; mode: string } | null>(null),
    history: null,
    loadMoreHistory: noop,
    rails: ready([{ id: 'crypto-native', capabilities: ['payout'], mode: 'sandbox' as const, usable: true, healthy: true }]),
    saved: null,
    onCreated: noop,
    onKybSubmitted: noop,
    onDestinationSaved: noop,
    retry: noop,
  };
  it('starts at step 1 with grouped fields, required markers and the declared-volume label', () => {
    const out = html(<OnboardingView {...base} merchant={null} starterFeeBps={150} />);
    expect(out).toContain('Step 1 of 3');
    expect(out).toContain('Legal business name *');
    expect(out).toContain('Trading name');
    expect(out).not.toContain('Trading name *'); // optional
    expect(out).toContain('Leave it blank to use your legal name.');
    expect(out).toContain('Declared by you, not verified');
    expect(out).toContain('<legend>Your business</legend>');
    expect(out).toContain('Create my account');
    expectPlain(out);
  });
  it('refuses to open an account while no starting fee is published, and says why', () => {
    const out = html(<OnboardingView {...base} merchant={null} starterFeeBps={null} />);
    expect(out).toContain('can be opened once INTAFACED publishes its starting fee');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Create my account<\/button>/);
  });
  it('moves to verification once the account exists, with the reference form and history', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, status: 'pending', kybStatus: 'none', kybRef: null }}
        kyb={ready({ kybStatus: 'none', kybRef: null, mode: 'gateway' })}
        history={list<p.KybEvent>([])}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('Verification file reference *');
    expect(out).toContain('Send for review');
    expect(out).toContain('Nothing sent yet');
    expect(out).toContain('never approved automatically');
  });
  it('shows a pending review without a form to resubmit', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, status: 'pending', kybStatus: 'pending' }}
        kyb={ready({ kybStatus: 'pending', kybRef: 'ref-9', mode: 'gateway' })}
        history={list<p.KybEvent>([
          {
            seq: '2',
            fromStatus: 'none',
            toStatus: 'pending',
            kybRef: 'ref-9',
            decidedBy: 'merchant',
            reason: null,
            at: '2026-10-15T09:00:00.000Z',
          },
        ])}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('INTAFACED is reviewing it');
    expect(out).not.toContain('Send for review');
    expect(out).toContain('Not sent to In review');
  });
  it('says there is no payout method when none is connected', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, kybStatus: 'approved' }}
        kyb={ready({ kybStatus: 'approved', kybRef: 'r', mode: 'gateway' })}
        rails={ready([])}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('choose where your payouts go');
  });
  it('ends in a "live in sandbox" summary that keeps live waiting for approval', () => {
    const out = html(
      <OnboardingView
        {...base}
        merchant={{ ...merchantRecord, status: 'pending', kybStatus: 'pending' }}
        kyb={ready({ kybStatus: 'pending', kybRef: 'r', mode: 'gateway' })}
        history={list<p.KybEvent>([])}
        saved={{ railId: 'crypto-native', kind: 'crypto', ref: `0x${'a'.repeat(40)}` }}
        starterFeeBps={null}
      />,
    );
    expect(out).toContain('Destination saved for this visit');
    expect(out).not.toContain('You are live in sandbox');
    expect(out).toContain('Waiting for verification to be approved');
    expect(out).toMatch(notLiveWords);
  });
});
describe('team and roles', () => {
  const member = (patch: Partial<p.Member>): p.Member => ({
    memberId: 'a1',
    userId: 'user-finance',
    role: 'finance',
    status: 'active',
    label: 'Accounts',
    invitedBy: 'owner-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    activatedAt: '2026-10-02T00:00:00.000Z',
    removedAt: null,
    cursor: 'c1',
    ...patch,
  });
  const owner = member({ memberId: null, userId: 'owner-1', role: 'owner', label: null, invitedBy: null, cursor: null });
  const props = (role: p.MemberRole, extra: Partial<Parameters<typeof TeamView>[0]> = {}): Parameters<typeof TeamView>[0] => ({
    portal,
    me: ready({ merchantId: 'm', userId: 'owner-1', role }),
    invitations: ready<p.Invitation[]>([]),
    members: list([owner, member({})]),
    history: list<p.TeamEvent>([
      {
        seq: '3',
        memberUserId: 'user-finance',
        action: 'role_changed',
        fromRole: 'viewer',
        toRole: 'finance',
        actorId: 'owner-1',
        createdAt: '2026-10-03T00:00:00.000Z',
      },
    ]),
    status: '',
    setStatus: noop,
    loadMoreMembers: noop,
    loadMoreHistory: noop,
    refresh: noop,
    ...extra,
  });
  it('always says role changes need a verified (MFA) session', () => {
    expect(html(<TeamView {...props('owner')} />)).toContain('verified with two-step sign-in (MFA)');
  });
  it('lists members in an accessible table with row headers, roles and status words', () => {
    const out = html(<TeamView {...props('owner')} />);
    expect(out).toContain('role="region" aria-label="Members"');
    expect(out).toContain('<th scope="col">Role</th>');
    expect(out).toMatch(/<th scope="row">.*user-finance/);
    expect(out).toContain('Finance');
    expect(out).toContain('Active');
    expect(out).toContain('Change role');
    expect(out).toContain('Remove');
    expect(out).toContain('changed from Viewer to Finance');
  });
  it('locks the controls with a reason for someone who cannot manage the team', () => {
    const out = html(<TeamView {...props('viewer')} />);
    expect(out).not.toContain('>Change role<');
    expect(out).toContain('Only the owner or an admin can manage the team.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Send invitation<\/button>/);
  });
  it('offers pending invitations to accept or decline', () => {
    const out = html(
      <TeamView
        {...props('viewer', {
          invitations: ready<p.Invitation[]>([
            { memberId: 'i1', merchantId: 'm', role: 'developer', invitedAt: '2026-10-14T00:00:00.000Z' },
          ]),
        })}
      />,
    );
    expect(out).toContain('Invitation to join a team as Developer');
    expect(out).toContain('>Accept<');
    expect(out).toContain('>Decline<');
  });
  it('has loading, empty, error and coming-soon states', () => {
    expect(html(<TeamView {...props('owner', { members: { status: 'loading' } })} />)).toContain('aria-busy="true"');
    expect(html(<TeamView {...props('owner', { members: list<p.Member>([]) })} />)).toContain('No members match');
    expect(
      html(
        <TeamView
          {...props('owner', {
            members: {
              status: 'failed',
              failure: refusal('pay.merchant_ops_unavailable', 503, 'unreachable'),
            },
          })}
        />,
      ),
    ).toContain('Try again');
    expect(
      html(
        <TeamView
          {...props('owner', {
            members: { status: 'failed', failure: refusal('pay.not_built', 501, 'not_supported') },
          })}
        />,
      ),
    ).toMatch(notLiveWords);
  });
  it('says how many rows are shown and whether more exist', () => {
    expect(html(<TeamView {...props('owner', { members: list([owner, member({})], true) })} />)).toMatch(
      /2 shown so far\. More are available\./,
    );
    expect(html(<TeamView {...props('owner')} />)).toContain('2 shown. That is everything.');
  });
});
describe('exports', () => {
  const job = (patch: Partial<p.ExportJob> = {}): p.ExportJob => ({
    jobId: 'j1',
    kind: 'payments',
    filters: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', status: 'captured' },
    status: 'ready',
    failureCode: null,
    fileName: 'payments.csv',
    sizeBytes: '1024',
    rowCount: 42,
    sha256: 'a'.repeat(64),
    requestedBy: 'owner-1',
    columns: ['payment_id', 'amount'],
    generatedAt: '2026-10-15T09:00:00.000Z',
    asOf: '2026-10-15T09:00:00.000Z',
    expiresAt: null,
    createdAt: '2026-10-15T09:00:00.000Z',
    completedAt: '2026-10-15T09:00:05.000Z',
    ...patch,
  });
  const render = (l: ListState<p.ExportJob>) =>
    html(<ExportsView portal={portal} list={l} kind="" setKind={noop} status="" setStatus={noop} loadMore={noop} reload={noop} />);
  it('offers the three report kinds with what each contains', () => {
    const out = render(list([job()]));
    for (const word of ['Payments', 'Settlements', 'Payouts', 'Request export']) expect(out).toContain(word);
    expect(out).toContain('It includes only your data');
  });
  it('lists jobs with status words, range, rows, and a download only for a ready one', () => {
    const out = render(
      list([
        job(),
        job({ jobId: 'j2', status: 'running', rowCount: null, fileName: null }),
        job({ jobId: 'j3', status: 'failed', rowCount: null, fileName: null }),
      ]),
    );
    expect(out).toContain('Ready');
    expect(out).toContain('Building');
    expect(out).toContain('Failed');
    expect(out).toContain('It could not be built. Try a narrower date range.');
    expect(out.match(/>Download</g)?.length).toBe(1);
    expect(out).toContain('2026-10-01 to 2026-10-08');
    expect(out).toContain('Does not expire');
  });
  it('has empty, loading, error and coming-soon states', () => {
    expect(render(list<p.ExportJob>([]))).toContain('No exports yet');
    expect(render({ status: 'loading' })).toContain('aria-busy="true"');
    expect(render({ status: 'failed', failure: refusal('pay.not_built', 501, 'not_supported') })).toMatch(notLiveWords);
    expect(render({ status: 'failed', failure: refusal('pay.merchant_ops_unavailable', 503, 'unreachable') })).toContain('Try again');
  });
});
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
      updatedAt: null,
    })),
  );
  const render = (view: 'feed' | 'preferences', feed: ListState<p.Notification>) =>
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
});
