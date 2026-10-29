import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { findRoom } from '../../app/navigation';
import { DevelopersRoutes } from './DevelopersRoutes';
import { ENVIRONMENTS, PROTOCOLS, SECTIONS, connectivityOptions, developersRoute, hostTable } from './developers-model';

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
  it('hosts table says host not set for every row and writes no address', () => {
    const html = renderToString(<DevelopersRoutes path="/developers/hosts" />);
    expect(html.match(/data-host-state="unset"/g)).toHaveLength(PROTOCOLS.length * ENVIRONMENTS.length);
    expect(html.match(/>host not set</g)).toHaveLength(PROTOCOLS.length * ENVIRONMENTS.length);
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
});
