import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const reads = vi.hoisted(() => ({ quota: { status: 'loading' } as unknown }));
vi.mock('./use-alerts', () => ({
  useAlerts: () => ({
    state: { status: 'ready', items: [], evaluation: { markSource: 'live', canFire: true, code: null } },
    reload: () => undefined,
  }),
  useAlertMarkets: () => ({ status: 'ready', markets: [{ id: 'm1', label: 'BTC/USDT', quote: 'USDT' }] }),
}));
vi.mock('./use-quota', () => ({ useAlertQuota: () => ({ state: reads.quota, reload: () => undefined }) }));
vi.mock('../../features/session/session', async (original) => {
  const real = await original<typeof import('../../features/session/session')>();
  return { ...real, useSession: () => ({ ...real.useSession(), mode: 'Personal', userId: 'u1' }) };
});

import { SessionProvider } from '../../features/session/session';
import AlertsPage from './AlertsPage';

const render = () =>
  renderToString(
    <SessionProvider>
      <AlertsPage />
    </SessionProvider>,
  );
const ready = (used: number, max: number | null) => ({ status: 'ready', quota: { kind: 'price', used, max } });

beforeEach(() => {
  reads.quota = { status: 'loading' };
});

describe('alert quota on the page', () => {
  it('shows how many are in use and leaves the form on while there is room', () => {
    reads.quota = ready(3, 10);
    const page = render();
    expect(page).toContain('3 of 10 price alerts in use.');
    expect(page).not.toContain('Switched off: you are at your limit');
  });
  it('says so, and switches the form off with the reason, at the cap', () => {
    reads.quota = ready(10, 10);
    const page = render();
    expect(page).toContain('You are at the limit. Cancel or delete an alert to make room.');
    expect(page).toContain('Switched off: you are at your limit of price alerts.');
  });
  it('says the cap is not set, and switches the form off with the reason', () => {
    reads.quota = ready(0, null);
    const page = render();
    expect(page).toContain('has not been set on this platform, so new alerts cannot be saved.');
    expect(page).toContain('Switched off: the number of price alerts you can hold has not been set on this platform.');
  });
  it('blocks nothing and shows no count when the quota could not be read', () => {
    reads.quota = { status: 'failed' };
    const page = render();
    expect(page).not.toContain('data-testid="alerts-quota"');
    expect(page).not.toContain('Switched off: you are at your limit');
  });
});
