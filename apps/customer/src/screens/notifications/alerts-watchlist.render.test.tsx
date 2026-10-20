import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const reads = vi.hoisted(() => ({ favorites: [] as string[], quota: { status: 'loading' } as unknown }));
vi.mock('../../data/favorites', async (original) => {
  const real = await original<typeof import('../../data/favorites')>();
  return { ...real, useFavorites: () => ({ favorites: reads.favorites, isFavorite: () => false, toggle: () => undefined }) };
});
vi.mock('./use-alerts', () => ({
  useAlerts: () => ({
    state: { status: 'ready', items: [], evaluation: { markSource: 'live', canFire: true, code: null } },
    reload: () => undefined,
  }),
  useAlertMarkets: () => ({
    status: 'ready',
    markets: [
      { id: 'm1', label: 'BTC/USDT', quote: 'USDT' },
      { id: 'm2', label: 'ETH/USDT', quote: 'USDT' },
    ],
  }),
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

beforeEach(() => {
  reads.favorites = [];
  reads.quota = { status: 'ready', quota: { kind: 'price', used: 0, max: 10 } };
});

describe('list alert on the page', () => {
  it('says plainly when no favourite can be watched, and offers no form', () => {
    const page = render();
    expect(page).toContain('Watch a list');
    expect(page).toContain('data-testid="alerts-watchlist-empty"');
    expect(page).not.toContain('Choose all');
  });
  it('offers each favourite that is a market, and says how many were left out', () => {
    reads.favorites = ['BTC/USDT', 'ETH/USDT', 'DOGE/EUR'];
    const page = render();
    expect(page).toContain('BTC/USDT');
    expect(page).toContain('ETH/USDT');
    expect(page).toContain('Choose all');
    expect(page).toContain('Favourites that are not markets you can watch are left out (1).');
    expect(page).toContain('The same price is used for every market you choose.');
  });
  it('switches the list form off with the reason when the cap is not set', () => {
    reads.favorites = ['BTC/USDT'];
    reads.quota = { status: 'ready', quota: { kind: 'price', used: 0, max: null } };
    const page = render();
    expect(page).toContain('Switched off: the number of price alerts you can hold has not been set on this platform.');
  });
});
