import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Loadable } from '../../data/types';
import type { MaintenanceWindow, MarketMode } from './status';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

let load: Loadable<MarketMode[]> = { status: 'loading' };
let maintenanceLoad: Loadable<MaintenanceWindow[]> = { status: 'loading' };
vi.mock('../../data/hooks', () => ({
  useDataEnv: () => ({ poller: { source: (key: string) => ({ key }) }, api: {}, userId: null }),
  useSource: (source: { key: string }) => (source.key === 'public-status-maintenance' ? maintenanceLoad : load),
}));

import { StatusPage } from './StatusPage';

describe('/status', () => {
  it('says each reported mode and what it does to orders', () => {
    load = {
      status: 'ready',
      asOf: 1,
      data: [
        { symbol: 'BTC/USDT', state: 'CANCEL_ONLY', reasonCode: null },
        { symbol: 'ETH/USDT', state: null, reasonCode: null },
      ],
    };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Cancel-only');
    expect(html).toContain('New orders are refused');
    expect(html).toContain('Not reported');
    expect(html).not.toContain('>Open<');
  });
  it('a failed read says so and never reads as all open', () => {
    load = { status: 'error', retry: () => undefined };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Couldn’t load market modes');
    expect(html).not.toContain('Cancel-only');
  });
  it('lists published maintenance windows and keeps an unset time unset', () => {
    maintenanceLoad = {
      status: 'ready',
      asOf: 1,
      data: [{ id: 'm1', title: 'Matching upgrade', components: ['api'], startsAt: '2026-11-01T02:00:00Z', endsAt: null }],
    };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Matching upgrade');
    expect(html).toContain('2026-11-01 02:00 UTC');
    expect(html).toContain('time not set');
  });
  it('says no window is published when the feed lists none, and a failed read says so', () => {
    maintenanceLoad = { status: 'ready', asOf: 1, data: [] };
    expect(renderToString(<StatusPage />)).toContain('No maintenance window has been published');
    maintenanceLoad = { status: 'error', retry: () => undefined };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Couldn’t load the maintenance schedule');
    expect(html).not.toContain('No maintenance window has been published');
  });
});
