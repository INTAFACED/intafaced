// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session';
import { AuthForm } from './AuthForm';
import { AboutPage } from './AboutPage';
import { Invitation } from './Invitation';
import { MyTierView } from './MyTierPage';
import { feeTierSchema } from './fee-tier';
import { BreakingChangesNotice } from '../developers';
import { inviteTimeText } from './invite-time';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;
const fetcher = vi.fn();

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactElement) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}

describe('Account & Info customer copy (#6177)', () => {
  it('/login hides the "After sign-in" context box when no return destination or invitation is present, and shows it when redirected', async () => {
    fetcher.mockImplementation(async (url: string) =>
      String(url).includes('auth.refresh')
        ? new Response(JSON.stringify({ error: { message: 'No session', data: { code: 'auth.session_invalid' } } }), { status: 401 })
        : new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503 }),
    );
    history.replaceState(null, '', '/login');
    await mount(
      <SessionProvider>
        <AuthForm register={false} />
      </SessionProvider>,
    );
    expect(host.querySelector('.public-auth-context')).toBeNull();
    expect(host.textContent).not.toContain('After sign-in');

    await act(async () => {
      history.pushState(null, '', '/login?redirect=%2Fuc%2Fsafe');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('.public-auth-context')?.textContent).toContain('Security');
  });

  it('/about-us drops internal room counts and "service or rail is not connected" jargon', () => {
    const html = renderToString(
      <SessionProvider>
        <AboutPage />
      </SessionProvider>,
    );
    expect(html).not.toMatch(/\b\d+\s+rooms?\b/i);
    expect(html).not.toContain('service or rail is not connected');
    expect(html).not.toContain('connected service');
    expect(html).toContain('Money');
    expect(html).toContain('Trade');
    expect(html).toContain('Pay');
    expect(html).toContain('More');
  });

  it('/invite formats attach-window times in 24-hour local time without US AM/PM UTC or "measured by the service"', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    fetcher.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('auth.refresh')) {
        return jsonResponse({
          accessToken: 'TEST-token',
          expiresAt,
          userId: '12345678-1234-4234-8234-123456789abc',
        });
      }
      if (target.includes('affiliates.attachWindow')) {
        return jsonResponse({
          state: 'closed',
          windowSeconds: 600,
          accountCreatedAt: '2026-11-23T07:05:00.000Z',
          reopenedAt: null,
          closesAt: '2026-11-23T07:15:00.000Z',
        });
      }
      if (target.includes('affiliates.myRebind')) return jsonResponse(null);
      return new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503 });
    });
    history.replaceState(null, '', '/invite');
    await mount(
      <SessionProvider>
        <Invitation />
      </SessionProvider>,
    );
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[data-window="closed"]')).not.toBeNull());
    });
    const text = host.textContent ?? '';
    expect(text).not.toContain('measured by the service');
    expect(text).not.toContain('The service checks');
    expect(text).not.toMatch(/\bAM UTC\b|\bPM UTC\b/);
    expect(text).not.toContain('Nov 23, 2026');
  });

  it('/notice hides developer breaking-changes and retired-endpoints noise when none are published, and shows them when published', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('upcomingChanges')) return jsonResponse({ upcoming: [], retired: [] });
      return new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 401 });
    });
    await mount(
      <SessionProvider>
        <BreakingChangesNotice />
      </SessionProvider>,
    );
    await act(async () => {
      await vi.waitFor(() => expect(fetcher.mock.calls.some(([u]) => String(u).includes('upcomingChanges'))).toBe(true));
    });
    expect(host.querySelector('[data-testid="breaking-changes"]')).toBeNull();
    expect(host.textContent).not.toContain('Retired endpoints');

    // When a breaking change IS published (J-developer-16 #4), it still renders in full.
    fetcher.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('upcomingChanges')) {
        return jsonResponse({
          upcoming: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              kind: 'changelog',
              title: 'TEST retire old list',
              body: 'TEST call the new list.',
              status: 'published',
              publishedAt: '2026-11-24T00:00:00.000Z',
              startsAt: null,
              endsAt: null,
              version: 1,
              asset: null,
              network: null,
              phase: null,
              category: null,
              audience: 'everyone',
              language: 'en',
              changelog: {
                area: 'trading',
                breaking: true,
                addedOn: '2026-11-24',
                releaseOn: '2027-01-15',
                endpoints: [],
                scopes: [],
                retired: ['GET /api/v1/old-list'],
                before: null,
                after: null,
                migrationNote: null,
              },
            },
          ],
          retired: [
            {
              endpoint: 'GET /api/v1/old-list',
              entryId: '11111111-1111-4111-8111-111111111111',
              title: 'TEST retire old list',
              releaseOn: '2027-01-15',
            },
          ],
        });
      }
      return new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 401 });
    });
    const mounted = root!;
    await act(async () => mounted.unmount());
    root = null;
    await mount(
      <SessionProvider>
        <BreakingChangesNotice />
      </SessionProvider>,
    );
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[data-testid="breaking-changes"]')).not.toBeNull());
    });
    expect(host.textContent).toContain('Upcoming breaking changes');
    expect(host.textContent).toContain('Retired endpoints');
    expect(host.textContent).toContain('GET /api/v1/old-list');
  });

  it('/fees/my-tier avoids "the owner has published nothing" in its VIP benefits explanation', () => {
    const tier = feeTierSchema.parse({
      tier: 'regular',
      scheduleVersion: 'v1',
      program: {
        thresholds: [{ tierId: 'vip-1', minVolume30d: '1000' }],
        volumeQuotes: ['USDT'],
        snapshotTimeUtc: '07:00',
        benefits: [
          { tierId: 'regular', prioritySupport: null, vipPortal: null, ambassador: null, subAccountCap: null, withdrawalLimit24h: null },
        ],
        downgradeGraceDays: null,
        subAccounts: null,
        botsAndCopy: null,
        assets: null,
      },
      volume: { amount: '0', fills: 0, from: '2026-10-25T00:00:00.000Z', to: '2026-11-24T00:00:00.000Z', reaches: 'regular' },
      next: { tierId: 'vip-1', minVolume30d: '1000', remaining: '1000' },
      snapshotsRunning: true,
      nextSnapshotAt: '2026-11-25T07:00:00.000Z',
      lastSnapshot: null,
      snapshots: [],
      excluded: [],
    });
    const html = renderToString(<MyTierView load={{ status: 'ready', data: tier, asOf: 0 }} />);
    expect(html).not.toContain('the owner has published nothing');
  });

  it('inviteTimeText uses 24-hour day-month order and honours device, UTC, and UTC+8 preferences', () => {
    const now = Date.parse('2026-11-24T00:00:00.000Z');
    const iso = '2026-11-23T07:05:00.000Z';
    expect(inviteTimeText(iso, 'en', 'UTC', now)).toBe('23 Nov, 07:05 UTC');
    expect(inviteTimeText(iso, 'en', 'UTC+8', now)).toBe('23 Nov, 15:05 UTC+8');
    expect(inviteTimeText(iso, 'en', 'device', now)).not.toMatch(/UTC|AM|PM|Nov 23/);
  });
});
