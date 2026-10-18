import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, Loadable, ActivityFeed } from './deps';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// The panel reads the one activity feed; each test chooses what that read answered.
const answer = vi.hoisted(() => ({ value: { status: 'loading' } as unknown }));
vi.mock('./deps', async (original) => {
  const real = await original<typeof import('./deps')>();
  return {
    ...real,
    createActivityFeed: () => ({ subscribe: () => () => undefined, getSnapshot: () => answer.value }),
  };
});

import { SessionProvider } from '../../features/session/session';
import { RecentPanel } from './RecentPanel';

const render = () =>
  renderToString(
    <SessionProvider>
      <RecentPanel />
    </SessionProvider>,
  );
const row = (id: string, patch: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: 'transfer_out',
  direction: 'out',
  asset: 'USDT',
  amount: '12.50',
  postedAt: '2026-10-17T08:00:00.000Z',
  txId: `tx-${id}`,
  counterparty: { handle: 'maya_test' },
  spaceName: null,
  ...patch,
});
const ready = (items: ActivityItem[], hasMore = false): Loadable<ActivityFeed> => ({
  status: 'ready',
  asOf: 1,
  data: { items, hasMore, loadingMore: false, moreFailed: false, loadMore: () => undefined },
});

beforeEach(() => {
  answer.value = { status: 'loading' };
});

describe('recent panel', () => {
  it('shows loading skeletons, not invented rows, before the first answer', () => {
    const page = render();
    expect(page).toContain('Recent payments');
    expect(page).toContain('Recent recipients');
    expect(page).toContain('Loading your payments');
    expect(page).not.toContain('data-testid="recent-payment"');
    expect(page).not.toContain('data-testid="recent-recipient"');
  });

  it('lists each real transfer with who, exact amount, status and a receipt link', () => {
    answer.value = ready([
      row('t1'),
      row('t2', { kind: 'transfer_in', direction: 'in', amount: '0.000000000000000001', counterparty: null }),
    ]);
    const page = render();
    expect(page).toContain('Sent to @maya_test');
    expect(page).toContain('−12.5 USDT');
    expect(page).toContain('Received from another account');
    expect(page).toContain('+0.000000000000000001 USDT');
    expect(page).toContain('Completed');
    expect(page).toContain('href="/money/activity/t1"');
    expect(page).toContain('Receipt');
    // The recipient chip opens Send already pointed at them.
    expect(page).toContain('href="/pay/send?to=maya_test"');
  });

  it('never says "No recipients yet" beside a completed send; it labels the send instead', () => {
    answer.value = ready([row('t1', { counterparty: null })]);
    const page = render();
    expect(page).toContain('Sent to another account');
    expect(page).not.toContain('No recipients yet');
    expect(page).toContain('Sent · recipient not shown by the bank');
    expect(page).toContain('data-testid="recent-unnamed-send"');
    expect(page).not.toContain('data-testid="recent-recipient"');
  });

  it('keeps the unnamed label for sends only: money received does not make a recipient row', () => {
    answer.value = ready([row('t2', { kind: 'transfer_in', direction: 'in', counterparty: null })]);
    const page = render();
    expect(page).toContain('No recipients yet');
    expect(page).not.toContain('recipient not shown by the bank');
  });

  it('explains what will appear when the customer has no activity at all', () => {
    answer.value = { status: 'empty' };
    const page = render();
    expect(page).toContain('No payments yet');
    expect(page).toContain('No recipients yet');
    expect(page).not.toContain('data-testid="recent-payment"');
  });

  it('does not claim there are no payments when older entries are unread', () => {
    answer.value = ready([row('x', { kind: 'trade' })], true);
    const page = render();
    expect(page).toContain('No payments in your latest activity');
    expect(page).toContain('Look further back');
    expect(page).not.toContain('No payments yet');
  });

  it('says the read failed instead of showing an empty list', () => {
    answer.value = { status: 'error', retry: () => undefined };
    const page = render();
    expect(page).toContain('Couldn’t load your payments.');
    expect(page).not.toContain('No payments yet');
  });
});
