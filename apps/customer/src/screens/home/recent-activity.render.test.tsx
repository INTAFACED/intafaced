import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { RecentActivity } from './RecentActivity';
import type { ActivityFeed, ActivityItem, Loadable } from './deps';

const line = (over: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'postedAt'>): ActivityItem => ({
  kind: 'deposit',
  direction: 'in',
  asset: 'USDT',
  amount: '1',
  txId: `tx-${over.id}`,
  counterparty: null,
  spaceName: null,
  ...over,
});

const ready = (items: ActivityItem[]): Loadable<ActivityFeed> => ({
  status: 'ready',
  data: { items, hasMore: false, loadingMore: false, moreFailed: false, loadMore: () => {} },
  asOf: 1,
});

const hrefs = (html: string) => [...html.matchAll(/class="home-activity__row" href="([^"]+)"/g)].map((match) => match[1] ?? '');

describe('Recent activity on Home (HM-dashboard-04)', () => {
  it('shows one row per movement as the Activity room does: a trade’s two legs are one row', () => {
    const html = renderToString(
      <RecentActivity
        hidden={false}
        activity={ready([
          line({ id: 'fill-in', postedAt: '2026-10-22T12:00:03Z', kind: 'trade', asset: 'BTC', amount: '0.1', orderId: 'o1' }),
          line({ id: 'fill-out', postedAt: '2026-10-22T12:00:02Z', kind: 'trade', direction: 'out', amount: '6700', orderId: 'o1' }),
          line({ id: 'dep-2', postedAt: '2026-10-22T11:00:00Z', amount: '0.123456789012345678' }),
          line({ id: 'dep-1', postedAt: '2026-10-22T10:00:00Z', asset: 'EUR', amount: '25' }),
          line({ id: 'dep-0', postedAt: '2026-10-22T09:00:00Z', amount: '1000' }),
        ])}
      />,
    );
    const links = hrefs(html);
    expect(links).toHaveLength(3);
    // The trade is one row, then the two newest deposits; the oldest deposit is left to the Activity room.
    expect(links.filter((href) => href.includes('dep-'))).toEqual(['/money/activity/dep-2', '/money/activity/dep-1']);
    expect(new Set(links).size).toBe(3);
    expect(html).toContain('0.123456789012345678 USDT');
    expect(html).not.toContain('dep-0');
  });
});
