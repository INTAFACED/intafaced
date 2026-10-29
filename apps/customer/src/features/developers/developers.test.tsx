import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { findRoom } from '../../app/navigation';
import { SessionProvider } from '../session/session';
import { DevelopersRoutes } from './DevelopersRoutes';
import { ENVIRONMENTS, PROTOCOLS, SECTIONS, connectivityOptions, developersRoute, hostTable } from './developers-model';
import { DEVELOPER_DATA_TERMS_UNSET, DEVELOPER_HOSTS_UNSET, hostsView, termsView } from './developers-values';

describe('developer portal model', () => {
  it('reads the address into home, hosts, a known section or unknown', () => {
    expect(developersRoute('/developers')).toEqual({ kind: 'home' });
    expect(developersRoute('/developers/')).toEqual({ kind: 'home' });
    expect(developersRoute('/developers/hosts?x=1')).toEqual({ kind: 'hosts' });
    expect(developersRoute('/developers/rest')).toEqual({ kind: 'section', id: 'rest' });
    expect(developersRoute('/developers/no-such')).toEqual({ kind: 'unknown' });
    expect(developersRoute('/developers/rest/extra')).toEqual({ kind: 'unknown' });
  });
  it('has one row per protocol and environment, every host unset until an owner value is read', () => {
    const rows = hostTable();
    expect(rows).toHaveLength(PROTOCOLS.length * ENVIRONMENTS.length);
    expect(rows.every((row) => row.cell.state === 'unset')).toBe(true);
  });
  it('shows a host only when the read returns one, and treats blank as unset', () => {
    const rows = hostTable((protocol, environment) => (protocol === 'rest' && environment === 'sandbox' ? 'host.example' : '  '));
    expect(rows.filter((row) => row.cell.state === 'set')).toEqual([
      { protocol: 'rest', environment: 'sandbox', cell: { state: 'set', host: 'host.example' } },
    ]);
  });
  it('gives every section id a room address', () => {
    for (const section of SECTIONS) expect(findRoom(`/developers/${section.id}`)?.area).toBe('public');
  });
});

describe('developer portal pages', () => {
  it('home lists every audience and every section, none hidden, with the hosts link', () => {
    const html = renderToString(<DevelopersRoutes path="/developers" />);
    for (const section of SECTIONS) expect(html).toContain(`href="/developers/${section.id}"`);
    expect(html).toContain('href="/developers/hosts"');
    expect(html).toContain('Exchange API');
    expect(html).toContain('Best practice');
    expect(html).toContain('No access tiers are published');
  });
  it('hosts page reads the published hosts before it draws a row, and writes no address of its own', () => {
    const html = renderToString(
      <SessionProvider>
        <DevelopersRoutes path="/developers/hosts" />
      </SessionProvider>,
    );
    expect(html).toContain('Base addresses');
    expect(html).not.toMatch(/data-host-state=/);
    expect(html).not.toMatch(/https?:\/\//);
  });
  it('a section without a page names that, and a published one links to it', () => {
    expect(renderToString(<DevelopersRoutes path="/developers/fix" />)).toContain('No page is published for this section');
    expect(renderToString(<DevelopersRoutes path="/developers/sandbox" />)).toContain('href="/pay/developer/sandbox"');
  });
  it('an address that names no section says so and links back', () => {
    const html = renderToString(<DevelopersRoutes path="/developers/no-such" />);
    expect(html).toContain('No such developer page');
    expect(html).toContain('href="/developers"');
  });
});

describe('connectivityOptions', () => {
  it('calls Internet available only once every protocol has a production host', () => {
    const only = hostTable((protocol, environment) => (protocol === 'fix' && environment === 'production' ? 'fix.example' : null));
    expect(connectivityOptions(only).find((o) => o.option === 'internet')?.state).toBe('host_unset');
    const all = hostTable((_, environment) => (environment === 'production' ? 'api.example' : null));
    expect(connectivityOptions(all).find((o) => o.option === 'internet')?.state).toBe('available');
    expect(connectivityOptions(all).find((o) => o.option === 'redundant')?.state).toBe('host_unset');
  });

  it('names each endpoint host per protocol, and none for the parked options', () => {
    const only = hostTable((protocol, environment) => (protocol === 'fix' && environment === 'production' ? 'fix.example' : null));
    const options = connectivityOptions(only);
    expect(options.find((o) => o.option === 'internet')?.hosts.map(({ protocol, cell }) => [protocol, cell])).toEqual([
      ['rest', { state: 'unset' }],
      ['websocket', { state: 'unset' }],
      ['fix', { state: 'set', host: 'fix.example' }],
    ]);
    expect(options.find((o) => o.option === 'redundant')?.hosts.every((row) => row.environment === 'regional')).toBe(true);
    expect(options.find((o) => o.option === 'colocation')?.hosts).toEqual([]);
  });
});

describe('the published developer values', () => {
  const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
  it('draws the hosts the service publishes and leaves the rest not set', () => {
    const view = hostsView(
      ready({
        hosts: [
          { protocol: 'rest' as const, environment: 'production' as const, host: 'api.a.test' },
          { protocol: 'fix' as const, environment: 'regional' as const, host: null },
        ],
      }),
    );
    expect(view.kind).toBe('table');
    if (view.kind !== 'table') throw new Error('unreachable');
    expect(view.unsetCode).toBeNull();
    const rows = hostTable(view.read);
    expect(rows.filter((row) => row.cell.state === 'set')).toEqual([
      { protocol: 'rest', environment: 'production', cell: { state: 'set', host: 'api.a.test' } },
    ]);
  });
  it('a blank setting draws every row not set with its code; any other failure draws no table', () => {
    const blank = hostsView({ status: 'failed', code: DEVELOPER_HOSTS_UNSET });
    expect(blank).toMatchObject({ kind: 'table', unsetCode: 'trade.developer_hosts_unset' });
    if (blank.kind !== 'table') throw new Error('unreachable');
    expect(hostTable(blank.read).every((row) => row.cell.state === 'unset')).toBe(true);
    expect(hostsView({ status: 'failed' })).toEqual({ kind: 'failed' });
    expect(hostsView({ status: 'failed', code: 'edge.upstream_unwired' })).toEqual({ kind: 'failed' });
    expect(hostsView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });
  it('terms: a product the service publishes shows its terms, the rest not set; blank carries its code', () => {
    const terms = { entitlement: 'e', redistribution: 'r', retention: 'k', privacy: 'p', commercial: 'c' };
    const view = termsView(
      ready({
        products: [
          { product: 'ticker' as const, terms },
          { product: 'index' as const, terms: null },
        ],
      }),
    );
    if (view.kind !== 'table') throw new Error('unreachable');
    expect(view.termsOf('ticker')).toEqual(terms);
    expect(view.termsOf('index')).toBeNull();
    expect(view.termsOf('trades')).toBeNull();
    expect(termsView({ status: 'failed', code: DEVELOPER_DATA_TERMS_UNSET })).toMatchObject({
      kind: 'table',
      unsetCode: 'trade.developer_data_terms_unset',
    });
    expect(termsView({ status: 'failed', code: 'trade.developer_hosts_unset' })).toEqual({ kind: 'failed' });
  });
});
