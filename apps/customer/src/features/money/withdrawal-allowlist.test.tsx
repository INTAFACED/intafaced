import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Resource } from '../../shared/resource';

const owner = '11111111-1111-4111-8111-111111111111';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const change = {
  id,
  userId: owner,
  op: 'add',
  entryId: null,
  subject: { address: '0x1111111111111111111111111111111111111111', label: 'Cold', assetId: 'USDT', group: 'external_wallet' },
  requestHash: 'a'.repeat(64),
  teamAccountId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: false,
  status: 'waiting',
  failureCode: null,
  createdAt: '2026-10-20T09:20:00Z',
  decidedAt: null,
};
const entry = {
  id,
  userId: owner,
  group: 'external_wallet',
  assetId: 'USDT',
  address: '0x1111111111111111111111111111111111111111',
  label: 'Cold',
  state: 'active',
  createdBy: owner,
  suspendedReason: null,
  createdAt: '2026-10-20T09:20:00Z',
  lastUsedAt: null,
};

let viewer: string | null = owner;
let resources: Resource<unknown>[] = [];
let call = 0;
vi.mock('../session/session', () => ({ useSession: () => ({ api: {}, userId: viewer }) }));
vi.mock('../../shared/resource', async (original) => ({
  ...(await original<typeof import('../../shared/resource')>()),
  // Overview order is mode, entries, policy, changes; a detail renders one resource.
  useResource: () => ({ resource: resources[call++ % resources.length]!, reload: () => undefined }),
}));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { WithdrawalAllowlist } from './WithdrawalAllowlist';

const page = (search = '') => {
  call = 0;
  return renderToStaticMarkup(<WithdrawalAllowlist context={{ current: () => true }} search={search} />);
};
const overview = (over: { mode?: unknown; entries?: unknown; policy?: unknown; changes?: unknown } = {}): Resource<unknown>[] => [
  { status: 'ready', data: over.mode ?? { userId: owner, enabled: true, setAt: '2026-10-20T09:20:00Z' } },
  { status: 'ready', data: over.entries ?? [entry] },
  { status: 'ready', data: over.policy ?? { userId: owner, enabled: false, assetId: null, maxAmount: null, setAt: null } },
  { status: 'ready', data: over.changes ?? [change] },
];

beforeEach(() => {
  viewer = owner;
  resources = overview();
});

describe('the withdrawal address list room', () => {
  it('shows the mode, listed addresses, the one-time setting and the changes', () => {
    const html = page();
    expect(html).toContain('Withdrawal address list');
    expect(html).toContain('On: withdrawals to an address that is not on your list are refused.');
    expect(html).toContain('Cold');
    expect(html).toContain('Off: nothing can be sent to an unlisted address.');
    expect(html).toContain('Add address');
    expect(html).toContain('1 of 2 approvals');
    expect(html).toContain(`changeId=${id}`);
  });

  it('offers every owner control, each behind the withdrawal confirmation, with no blocker note', () => {
    const html = page();
    for (const name of ['Request to switch off', 'Add address', 'Remove', 'Request a change'])
      expect(html).toMatch(new RegExp(`<button[^>]*>${name}</button>`));
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(Request to switch off|Add address|Remove|Request a change)</);
    expect(html).not.toContain('withdrawal sign-in step');
  });

  it('says the list is off when it is off, and shows honest empty states', () => {
    resources = overview({ mode: { userId: owner, enabled: false, setAt: null }, entries: [], changes: [] });
    const html = page();
    expect(html).toContain('Off: you can withdraw to any address.');
    expect(html).toContain('Never switched on');
    expect(html).toContain('No addresses listed');
    expect(html).toContain('No changes');
  });

  it('shows the one-time ceiling the owner approved', () => {
    resources = overview({ policy: { userId: owner, enabled: true, assetId: 'USDT', maxAmount: '25', setAt: '2026-10-20T09:20:00Z' } });
    expect(page()).toContain('one send of up to');
  });

  it('lets the requester cancel a waiting change, and turns cancel off once it is decided', () => {
    resources = [{ status: 'ready', data: change }];
    expect(page(`?changeId=${id}`)).toMatch(/<button[^>]*>Cancel request<\/button>/);
    resources = [{ status: 'ready', data: { ...change, status: 'approved' } }];
    const html = page(`?changeId=${id}`);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Cancel request<\/button>/);
    expect(html).toContain('a'.repeat(64));
  });

  it('offers an approver no cancel and no decision, because the change is not theirs', () => {
    viewer = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    resources = [{ status: 'ready', data: change }];
    expect(page(`?changeId=${id}`)).not.toMatch(/<button[^>]*>Cancel request<\/button>/);
  });

  it('says what an invalid link is instead of reading anything', () => {
    expect(page('?changeId=nope')).toContain('Enter one valid change ID.');
  });
});
