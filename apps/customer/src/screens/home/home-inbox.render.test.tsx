import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxState } from '../notifications/use-notifications';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => ({ ...real.currentPreferences(), timeZone: 'UTC' }) };
});

// The inbox read as the service answered it; server rendering runs no effect, so the hook is given its answer.
const inbox = vi.hoisted(() => ({ state: { status: 'loading' } as InboxState }));
vi.mock('./deps', async (original) => {
  const real = await original<typeof import('./deps')>();
  return {
    ...real,
    useInboxView: () => ({ inbox: { read: () => undefined }, state: inbox.state, markets: new Map() }),
  };
});

// A test build is one served with the TEST banner (shared/test-build.ts).
const testBuild = vi.hoisted(() => ({ on: true }));
vi.mock('../../shared/test-build', async (original) => {
  const real = await original<typeof import('../../shared/test-build')>();
  return { ...real, isTestBuild: () => testBuild.on };
});

import { HomeInbox } from './HomeInbox';

const credited = {
  id: '00000000-0000-4000-8000-000000000002',
  userId: 'user-a',
  kind: 'pay.deposit.credited',
  titleKey: 'notify.deposit.credited.title',
  bodyKey: 'notify.deposit.credited.body',
  title: 'Deposit credited',
  body: '100 USDT has arrived',
  params: { amount: '100', asset: 'USDT' },
  href: null,
  severity: 'info' as const,
  readAt: null,
  createdAt: '2026-10-30T00:00:00Z',
};

describe('The newest inbox row on Home (J-home-ia-11 #3)', () => {
  beforeEach(() => {
    testBuild.on = true;
  });

  it('draws the newest notification as the inbox row, TEST on a test build, with a link to the rest', () => {
    inbox.state = { status: 'ready', items: [credited], nextCursor: null };
    const html = renderToString(<HomeInbox />);
    expect(html).toContain('data-testid="home-inbox"');
    expect(html.match(/data-testid="nf-row"/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/data-testid="nf-test"[^>]*>TEST</);
    expect(html).toContain('href="/notifications"');
  });

  it('labels nothing TEST on a live build', () => {
    testBuild.on = false;
    inbox.state = { status: 'ready', items: [credited], nextCursor: null };
    const html = renderToString(<HomeInbox />);
    expect(html).toContain('data-testid="nf-row"');
    expect(html).not.toContain('data-testid="nf-test"');
  });

  it('draws nothing while loading, for an empty inbox, or when the inbox does not answer', () => {
    inbox.state = { status: 'loading' };
    expect(renderToString(<HomeInbox />)).toBe('');
    inbox.state = { status: 'ready', items: [], nextCursor: null };
    expect(renderToString(<HomeInbox />)).toBe('');
    inbox.state = { status: 'failed', failure: { ok: false, reason: 'down', code: 'notify.unavailable', status: 503 } as never };
    expect(renderToString(<HomeInbox />)).toBe('');
  });
});
