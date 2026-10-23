import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Loadable } from '../../data/types';
import type { MaintenanceWindow, MarketMode, StatusPage as StatusPageRead } from './status';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

let load: Loadable<MarketMode[]> = { status: 'loading' };
let maintenanceLoad: Loadable<MaintenanceWindow[]> = { status: 'loading' };
let pageLoad: Loadable<StatusPageRead> = { status: 'loading' };
vi.mock('../../data/hooks', () => ({
  useDataEnv: () => ({ poller: { source: (key: string) => ({ key }) }, api: {}, userId: null }),
  useSource: (source: { key: string }) =>
    source.key === 'public-status-maintenance' ? maintenanceLoad : source.key === 'public-status-page' ? pageLoad : load,
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

const page = (over: Partial<StatusPageRead>): StatusPageRead => ({
  asOf: '2026-10-23T12:00:00.000Z',
  revision: 1,
  settings: { componentCap: 5, stalenessSeconds: 600, uptimeDays: 3 },
  overall: 'none_defined',
  components: [],
  incidents: [],
  ...over,
});

const row = (over: Partial<StatusPageRead['components'][number]>): StatusPageRead['components'][number] => ({
  id: 'trading',
  name: 'Trading',
  group: null,
  source: null,
  state: 'no_data',
  basis: 'no_reading',
  reading: null,
  incidentId: null,
  uptime: [
    { date: '2026-10-21', state: null },
    { date: '2026-10-22', state: null },
    { date: '2026-10-23', state: null },
  ],
  ...over,
});

describe('/status components', () => {
  it('with no component defined says so and shows no overall banner', () => {
    pageLoad = { status: 'ready', asOf: 1, data: page({ settings: { componentCap: null, stalenessSeconds: null, uptimeDays: null } }) };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('No components are set');
    expect(html).not.toContain('data-testid="status-overall"');
    expect(html).not.toContain('operational');
  });
  it('shows No data for a component with no reading and never an operational top level', () => {
    pageLoad = {
      status: 'ready',
      asOf: 1,
      data: page({
        overall: 'no_data',
        components: [
          row({
            id: 'a',
            name: 'Alpha',
            state: 'operational',
            basis: 'reading',
            reading: { state: 'operational', observedAt: '2026-10-23T11:59:00.000Z', source: 'TEST probe' },
          }),
          row({ id: 'b', name: 'Beta' }),
        ],
      }),
    };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Not every component has a current reading');
    expect(html).toContain('No data');
    expect(html.replace(/<!-- -->/g, '')).toContain('Reading from TEST probe at 2026-10-23 11:59 UTC');
    expect(html).not.toContain('All components report operational');
    expect(html).not.toMatch(/\d+(\.\d+)?\s?%/);
    expect(html.match(/data-state="empty"/g)).toHaveLength(6);
  });
  it('says the uptime window is not set and draws no strip', () => {
    pageLoad = {
      status: 'ready',
      asOf: 1,
      data: page({
        overall: 'no_data',
        settings: { componentCap: 5, stalenessSeconds: 600, uptimeDays: null },
        components: [row({ uptime: [] })],
      }),
    };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Uptime window is not set');
    expect(html).not.toContain('status-uptime-trading');
  });
  it('shows an incident with its timeline, newest first, and the affected component by name', () => {
    pageLoad = {
      status: 'ready',
      asOf: 1,
      data: page({
        overall: 'partial_outage',
        components: [row({ state: 'partial_outage', basis: 'incident', incidentId: 'i1' })],
        incidents: [
          {
            id: 'i1',
            title: 'Slow fills',
            impact: 'major',
            components: ['trading'],
            openedAt: '2026-10-23T11:00:00.000Z',
            resolvedAt: null,
            updates: [
              { id: 'u1', body: 'Investigating', impact: 'major', publishedAt: '2026-10-23T11:00:00.000Z', resolves: false },
              { id: 'u2', body: 'Fix deployed', impact: null, publishedAt: '2026-10-23T11:30:00.000Z', resolves: false },
            ],
          },
        ],
      }),
    };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Partial outage');
    expect(html).toContain('From a published incident');
    expect(html.replace(/<!-- -->/g, '')).toContain('Affects: Trading');
    expect(html.indexOf('Fix deployed')).toBeLessThan(html.indexOf('Investigating'));
  });
  it('a failed read says so and never reads as all working', () => {
    pageLoad = { status: 'error', retry: () => undefined };
    const html = renderToString(<StatusPage />);
    expect(html).toContain('Couldn’t load component status');
  });
});
