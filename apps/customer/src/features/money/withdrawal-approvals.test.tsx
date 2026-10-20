import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../shared/resource';
import type { ApprovalRequest } from './withdrawal-approval-reads';

const owner = '11111111-1111-4111-8111-111111111111';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = {
  id,
  userId: owner,
  assetId: 'USDT',
  amount: '60',
  rail: 'card-sandbox',
  destination: { kind: 'bank', ref: 'private' },
  clientRef: 'w-1',
  teamAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: false,
  holdAtSubmit: true,
  status: 'pending',
  failureCode: null,
  expiresAt: '2026-10-21T09:20:00Z',
  createdAt: '2026-10-20T09:20:00Z',
  decidedAt: null,
} as unknown as ApprovalRequest;

let viewer: string | null = owner;
let resource: Resource<unknown> = { status: 'loading' };
vi.mock('../session/session', () => ({ useSession: () => ({ api: {}, userId: viewer }) }));
vi.mock('../../shared/resource', async (original) => ({
  ...(await original<typeof import('../../shared/resource')>()),
  useResource: () => ({ resource, reload: () => undefined }),
}));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { WithdrawalApprovals } from './WithdrawalApprovals';

const page = (search = '') => renderToStaticMarkup(<WithdrawalApprovals context={{ current: () => true }} search={search} />);

beforeEach(() => {
  viewer = owner;
  resource = { status: 'ready', data: [base] };
});

describe('the withdrawal approvals room', () => {
  it('lists the caller’s requests with status, tally and expiry', () => {
    const html = page();
    expect(html).toContain('Withdrawal approvals');
    expect(html).toContain('Waiting for approvals');
    expect(html).toContain('1 of 2 approvals');
    expect(html).toContain(`requestId=${id}`);
  });
  it('shows an honest empty state, not a made-up row', () => {
    resource = { status: 'ready', data: [] };
    expect(page()).toContain('No approval requests');
  });
  it('lets the initiator cancel a pending request and shows no decision controls', () => {
    resource = { status: 'ready', data: base };
    const html = page(`?requestId=${id}`);
    expect(html).toMatch(/<button[^>]*>Cancel request<\/button>/);
    expect(html).not.toContain('Your decision');
  });
  it('turns cancel off once the request is no longer pending', () => {
    resource = { status: 'ready', data: { ...base, status: 'approved' } };
    expect(page(`?requestId=${id}`)).toMatch(/<button[^>]*disabled[^>]*>Cancel request<\/button>/);
  });
  it('shows an approver Approve and Reject, both off, with the real blocker named', () => {
    viewer = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    resource = { status: 'ready', data: base };
    const html = page(`?requestId=${id}`);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Reject<\/button>/);
    expect(html).toContain('withdrawal sign-in step');
    expect(html).not.toMatch(/<button[^>]*>Cancel request<\/button>/);
  });
  it('says what an invalid link is instead of reading anything', () => {
    expect(page('?requestId=nope')).toContain('Enter one valid request ID.');
  });
});
