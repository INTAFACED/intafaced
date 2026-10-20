import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const reads = vi.hoisted(() => ({ alerts: { status: 'loading' } as unknown, triggers: { status: 'loading' } as unknown }));
vi.mock('./use-alerts', () => ({
  useAlerts: () => ({ state: reads.alerts, reload: () => undefined }),
  useAlertMarkets: () => ({ status: 'ready', markets: [{ id: 'm1', label: 'BTC/USDT', quote: 'USDT' }] }),
}));
vi.mock('./use-triggers', () => ({ useTriggers: () => ({ state: reads.triggers, reload: () => undefined }) }));
vi.mock('../../features/session/session', async (original) => {
  const real = await original<typeof import('../../features/session/session')>();
  return { ...real, useSession: () => ({ ...real.useSession(), mode: 'Personal', userId: 'u1' }) };
});

import { SessionProvider } from '../../features/session/session';
import AlertsPage from './AlertsPage';
import type { PriceAlert } from './notify-api';

const render = () =>
  renderToString(
    <SessionProvider>
      <AlertsPage />
    </SessionProvider>,
  );
const alert = (patch: Partial<PriceAlert> = {}): PriceAlert => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  marketId: 'm1',
  kind: 'price',
  direction: 'above',
  targetPrice: '65000.50',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  ...patch,
});
const ready = (items: PriceAlert[]) => ({
  status: 'ready',
  items,
  evaluation: { markSource: 'live', canFire: true, code: null },
});

beforeEach(() => {
  reads.alerts = { status: 'loading' };
  reads.triggers = { status: 'loading' };
});

describe('alert manager on the page', () => {
  it('offers pause, edit, cancel and delete on an active alert, and resume on a stopped one', () => {
    reads.alerts = ready([alert(), alert({ id: '22222222-2222-4222-8222-222222222222', status: 'stopped' })]);
    const page = render();
    expect(page).toContain('Pause the alert on BTC/USDT');
    expect(page).toContain('Resume the alert on BTC/USDT');
    expect(page.match(/Edit the alert on BTC\/USDT/g)).toHaveLength(2);
    expect(page.match(/Cancel the alert on BTC\/USDT/g)).toHaveLength(2);
    expect(page.match(/Delete the alert on BTC\/USDT/g)).toHaveLength(2);
    expect(page).toContain('Stopped');
  });
  it('offers only delete on an alert that has triggered, expired or been cancelled', () => {
    reads.alerts = ready([
      alert({ status: 'fired', firedAt: '2026-10-17T09:00:00.000Z' }),
      alert({ id: '3'.repeat(8) + '-3333-4333-8333-333333333333', status: 'expired' }),
    ]);
    const page = render();
    expect(page).not.toContain('Pause the alert');
    expect(page).not.toContain('Edit the alert');
    expect(page).not.toContain('Cancel the alert');
    expect(page.match(/Delete the alert on BTC\/USDT/g)).toHaveLength(2);
  });
  it('has the search, status and sort controls once there are alerts', () => {
    reads.alerts = ready([alert()]);
    const page = render();
    expect(page).toContain('Find an alert');
    expect(page).toContain('Price, low to high');
    expect(page).toContain('All alerts');
  });
});

describe('trigger history on the page', () => {
  const trigger = {
    alertId: '1'.repeat(8) + '-1111-4111-8111-111111111111',
    marketId: 'm1',
    condition: 'greater_than',
    targetPrice: '100',
    markPrice: '101.5',
    firedAt: '2026-10-20T12:00:00.000Z',
    notificationId: null,
  };
  it('shows each trigger with the price that triggered it and how long the history is kept', () => {
    reads.alerts = ready([]);
    reads.triggers = { status: 'ready', page: { retentionDays: 30, items: [trigger] } };
    const page = render();
    expect(page).toContain('Trigger history');
    expect(page).toContain('At or above 100. Price when it triggered: 101.5');
    expect(page).toContain('Kept for 30 days.');
  });
  it('says plainly when the platform has not set how long history is kept, and when nothing has triggered', () => {
    reads.alerts = ready([]);
    reads.triggers = { status: 'off' };
    expect(render()).toContain('Trigger history is not switched on');
    reads.triggers = { status: 'ready', page: { retentionDays: 30, items: [] } };
    expect(render()).toContain('Nothing has triggered');
  });
});
