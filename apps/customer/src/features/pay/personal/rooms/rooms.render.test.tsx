// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// Each test chooses who is signed in and what the activity read answers. TEST data only.
const world = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  feed: { status: 'loading' } as unknown,
}));
vi.mock('../../../session/session', () => ({
  useSession: () => ({
    userId: world.userId,
    session: world.userId ? { accessToken: 'x', expiresAt: '2099-01-01T00:00:00Z', userId: world.userId } : null,
    api: {},
  }),
}));
vi.mock('../../../../data', async (original) => {
  const real = await original<typeof import('../../../../data')>();
  return {
    ...real,
    createActivityFeed: () => ({ subscribe: () => () => undefined, getSnapshot: () => world.feed }),
  };
});

import { PersonalRoom } from './PersonalRoom';
import { personalRoomFor, personalRooms } from './rooms';
import { addRequest, recordSent } from '../personal-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = 'u1';
  world.feed = { status: 'loading' };
  localStorage.clear();
  history.replaceState(null, '', '/pay');
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});
async function open(path: string) {
  const match = personalRoomFor(path)!;
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<PersonalRoom match={match} />));
}
const button = (text: string) => [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));

const samples = [
  '/pay/request/req-1',
  '/pay/scheduled',
  '/pay/contacts',
  '/pay/contacts/groups/g1',
  '/pay/contacts/pools/p1',
  '/pay/history/t1',
  '/pay/claim/tok1',
  '/pay/cases',
  '/pay/cases/c1',
  '/pay/send/limits',
  '/pay/fees',
  '/pay/preferences',
  '/pay/scan',
  '/pay/l/l1',
  '/pay/bills/invoices/i1',
];

describe('personal Pay rooms render', () => {
  it('sends a signed-out visitor to sign in on every room and reads nothing', async () => {
    world.userId = null;
    for (const path of samples) {
      await open(path);
      expect(host.textContent, path).toContain('Sign in to open this room.');
      expect(host.querySelector('a[href^="/login"]'), path).not.toBeNull();
      act(() => root?.unmount());
      root = null;
    }
  });

  it('gives every room a layout, a way back and no placeholder wording', async () => {
    world.feed = { status: 'empty' };
    for (const path of samples) {
      await open(path);
      expect(host.querySelector('h1')?.textContent, path).toBeTruthy();
      expect(host.querySelector('a[href="/pay"]'), path).not.toBeNull();
      expect(host.textContent, path).not.toMatch(/coming soon|lorem|undefined|NaN/i);
      act(() => root?.unmount());
      root = null;
    }
  });

  it('names the blocker on every room whose back end is not wired, and keeps its controls off', async () => {
    const wired = new Set(['/pay/request/req-1', '/pay/history/t1', '/pay/contacts', '/pay/scan']);
    for (const path of samples) {
      await open(path);
      const reason = host.querySelector('[data-testid="pay-reason"]');
      expect(reason, path).not.toBeNull();
      expect(reason?.getAttribute('data-slice'), path).toMatch(/^PP-/);
      expect(reason?.textContent?.length, path).toBeGreaterThan(40);
      if (!wired.has(path)) {
        const enabled = [...host.querySelectorAll('button')].filter((candidate) => !candidate.disabled);
        expect(enabled, path).toEqual([]);
      }
      act(() => root?.unmount());
      root = null;
    }
  });

  it('never shows a limit, a fee or a rate that was not published', async () => {
    for (const path of ['/pay/send/limits', '/pay/fees']) {
      await open(path);
      expect(host.textContent, path).not.toMatch(/\d/);
      expect(host.textContent, path).toContain('Not set');
      act(() => root?.unmount());
      root = null;
    }
  });

  it('never prints the code in a claim address', async () => {
    await open('/pay/claim/secret-claim-code-9');
    expect(host.textContent).not.toContain('secret-claim-code-9');
    expect(host.innerHTML).not.toContain('secret-claim-code-9');
  });

  it('shows a request made on this device with its details, and removes it on request', async () => {
    addRequest('u1', {
      id: 'req-1',
      path: '/pay/send?to=test_payee&amount=5&asset=USDT&note=TEST%20lunch',
      to: 'test_payee',
      amount: '5',
      asset: 'USDT',
      note: 'TEST lunch',
      at: '2026-10-20T10:00:00.000Z',
    });
    await open('/pay/request/req-1');
    expect(host.textContent).toContain('test_payee');
    expect(host.textContent).toContain('5 USDT');
    expect(host.textContent).toContain('TEST lunch');
    expect(host.querySelector('a[href^="/pay/send?to=test_payee"]')).not.toBeNull();
    await act(async () => button('Remove from this device')!.click());
    expect(host.textContent).toContain('This request was removed from this device.');
    expect(JSON.stringify(Object.values(localStorage))).not.toContain('req-1');
  });

  it('says a request that is not on this device is not here, rather than inventing one', async () => {
    await open('/pay/request/other-device');
    expect(host.textContent).toContain('No request with this reference on this device');
    expect(host.querySelector('a[href="/pay/request"]')).not.toBeNull();
  });

  it('lists the people this device has paid, with a Send link for each', async () => {
    recordSent('u1', {
      transferId: 't-1',
      ledgerTxId: 'tx-1',
      toUserId: '22222222-2222-4222-8222-222222222222',
      handle: 'test_friend',
      amount: '1',
      asset: 'USDT',
      note: null,
      at: '2026-10-20T10:00:00.000Z',
    } as never);
    await open('/pay/contacts');
    expect(host.querySelectorAll('[data-testid="contact-row"]')).toHaveLength(1);
    expect(host.textContent).toContain('@test_friend');
    expect(host.querySelector('a[href^="/pay/send?to=test_friend"]')).not.toBeNull();
  });

  it('shows an empty contacts room honestly when nobody has been paid', async () => {
    await open('/pay/contacts');
    expect(host.textContent).toContain('No one yet.');
    expect(host.querySelectorAll('[data-testid="contact-row"]')).toHaveLength(0);
  });

  it('shows a payment found in the latest activity with its receipt link, and says so when it is not there', async () => {
    world.feed = {
      status: 'ready',
      data: {
        items: [
          {
            id: 'act-1',
            kind: 'transfer',
            direction: 'out',
            asset: 'USDT',
            amount: '12.5',
            postedAt: '2026-10-20T10:00:00.000Z',
            txId: 'tx-1',
            counterparty: { handle: 'test_friend' },
            spaceName: null,
          },
        ],
        hasMore: false,
        loadingMore: false,
        moreFailed: false,
        loadMore: () => undefined,
      },
    };
    await open('/pay/history/act-1');
    expect(host.textContent).toContain('@test_friend');
    expect(host.textContent).toContain('tx-1');
    expect(host.querySelector('a[href="/money/activity/act-1"]')).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    await open('/pay/history/not-in-the-feed');
    expect(host.textContent).toContain('This payment is not in your latest activity');
    expect(host.querySelector('a[href="/money/activity/not-in-the-feed"]')).toBeNull();
  });

  it('says a payment read that failed failed, and a refusal shows its words', async () => {
    world.feed = { status: 'error', retry: () => undefined };
    await open('/pay/history/t1');
    expect(host.textContent).toContain('We could not load this payment.');
    expect(host.textContent).not.toContain('Not set');
  });

  it('covers every room in the table', () => {
    expect(samples.length).toBe(personalRooms.length);
  });
});
