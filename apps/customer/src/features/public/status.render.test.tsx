import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Loadable } from '../../data/types';
import type { MarketMode } from './status';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

let load: Loadable<MarketMode[]> = { status: 'loading' };
vi.mock('../../data/hooks', () => ({
  useDataEnv: () => ({ poller: { source: () => ({}) }, api: {}, userId: null }),
  useSource: () => load,
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
  it('states that the maintenance schedule is not shown, without inventing one', () => {
    load = { status: 'loading' };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Scheduled maintenance');
    expect(html).toContain('nothing is made up');
  });
});
