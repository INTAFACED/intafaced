import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { findRoom } from '../../app/navigation';
import type { ApiClient } from '../../shared/api';
import { SessionProvider } from '../session/session';
import { DevelopersRoutes } from './DevelopersRoutes';
import { readServerClock } from '../../shared/server-clock';
import { developersCopy } from './developers-copy';
import { docsCopy } from './developers-docs-copy';
import { AUDIENCES, SECTIONS, developersRoute } from './developers-model';
import { REST_REFERENCE, routeLine, withinWindow } from './developers-reference';
import { createDocsSearch } from './developers-search';

const html = (path: string) =>
  renderToString(
    <SessionProvider>
      <DevelopersRoutes path={path} />
    </SessionProvider>,
  );
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

describe('developer portal home', () => {
  it('gives each audience its access statement and every section a state: its page, its link or what it waits for', () => {
    const home = html('/developers');
    expect(home.match(/data-testid="developers-access"/g)).toHaveLength(AUDIENCES.length);
    for (const section of SECTIONS) {
      expect([section.page, section.published, section.waitsFor].filter(Boolean), section.id).toHaveLength(1);
      if (section.waitsFor) expect(text(home)).toContain(`Waits for ${section.waitsFor}`);
    }
    expect(home).toContain('type="search"');
    expect(home).toContain('aria-label="Search the developer docs"');
  });
  it('a section without a page names the slice it waits for', () => {
    expect(text(html('/developers/websocket'))).toContain('It waits for DV-websocket-01');
    expect(text(html('/developers/rate-limits'))).toContain('It waits for DV-limits-01');
  });
  it('search finds pages by title or route, and finds nothing for an unknown topic', () => {
    const title = (id: string) => developersCopy.forLocale('en').t(`section_${id.replace(/-/g, '_')}` as 'section_rest');
    const searchDocs = createDocsSearch(title, 'Base addresses');
    expect(searchDocs('zz-no-such-developer-topic')).toEqual([]);
    expect(searchDocs('rest').map((m) => m.href)).toContain('/developers/rest');
    expect(searchDocs('/api/v1/time').map((m) => m.href)).toEqual(['/developers/reference']);
    expect(searchDocs('   ')).toEqual([]);
    // Case and spacing do not change the answer.
    expect(searchDocs('REST ')).toEqual(searchDocs('rest'));
  });
});

describe('developer docs pages', () => {
  it('routes the written pages and the auth error catalogue address', () => {
    for (const id of ['connectivity', 'data-terms']) {
      expect(developersRoute(`/developers/${id}`)).toEqual({ kind: 'section', id });
      expect(findRoom(`/developers/${id}`)?.area).toBe('public');
    }
    expect(developersRoute('/developers/errors/auth')).toEqual({ kind: 'errors-auth' });
    expect(findRoom('/developers/errors/auth')?.area).toBe('public');
  });
  it('REST conventions name JSON, UTC, UUIDs, symbols and decimal strings, and the paging that waits', () => {
    const page = text(html('/developers/rest'));
    for (const rule of ['JSON', 'UTC', 'UUID', 'symbol', 'decimal string']) expect(page).toContain(rule);
    expect(html('/developers/rest')).toMatch(/role="status"[^>]*>.*waits for DV-rest-01/);
  });
  it('the reference lists every route under its product, and the streams', () => {
    const page = html('/developers/reference');
    for (const product of ['Spot', 'Derivatives', 'Funding', 'Accounts']) expect(page).toContain(`>${product}</h2>`);
    for (const route of REST_REFERENCE) expect(page).toContain(`<code>${routeLine(route)}</code>`);
    expect(page).toContain('WebSocket stream');
  });
  it('the permission table has a row per key scope, with POST /api/v1/orders under trade:write', () => {
    const page = html('/developers/permissions');
    expect(page).toContain('aria-label="Permissions and endpoints"');
    const write = page.slice(page.indexOf('data-scope="trade:write"'), page.indexOf('data-scope="admin:read"'));
    expect(write).toContain('POST /api/v1/orders');
    expect(write).not.toContain('GET /api/v1/');
    // admin:read is never offered to a key: its row says so and holds the staff routes no key can call.
    const staff = page.slice(page.indexOf('data-scope="admin:read"'), page.indexOf('data-scope="trade:withdraw"'));
    expect(staff).toContain('data-never-on-key=""');
    expect(staff).toContain('Never on a key: only a staff session holds it');
    expect(staff).toContain('GET /api/v1/admin/orders/open');
    const read = page.slice(page.indexOf('data-scope="trade:read"'), page.indexOf('data-scope="trade:write"'));
    expect(read).not.toContain('/api/v1/admin/');
  });
  it('the specs page links the two downloads and the docs index', () => {
    const page = html('/developers/openapi');
    expect(page).toContain('href="/developers/openapi.json" download=');
    expect(page).toContain('href="/developers/collection.json" download=');
    expect(page).toContain('href="/developers/llms.txt"');
  });
  it('the quickstart has four steps: account, key, clock check, first call', () => {
    const page = html('/developers/quickstart');
    expect(page).toContain('aria-label="Quickstart steps"');
    expect(page.match(/data-step="/g)).toHaveLength(4);
    expect(page).toContain('data-testid="developers-clock-check"');
    expect(page).toContain('Check my clock');
  });
  it('connectivity names the parked options and their hardware blocker at once; the host options wait for the read', () => {
    const page = html('/developers/connectivity');
    expect(page).toContain('Connectivity options');
    expect(page.match(/data-option="[a-z_]+"/g)).toEqual(['data-option="low_latency"', 'data-option="colocation"']);
    expect(page.match(/data-option-state="[a-z_]+"/g)).toEqual([
      'data-option-state="parked_hardware"',
      'data-option-state="parked_hardware"',
    ]);
    const colocation = page.slice(
      page.indexOf('data-option="colocation"'),
      page.indexOf('</tr>', page.indexOf('data-option="colocation"')),
    );
    expect(text(colocation)).toMatch(/Parked.*hardware/);
    expect(page).toContain('data-testid="developers-time-probe"');
  });
  it('data terms reads the published terms before it draws a product', () => {
    const page = html('/developers/data-terms');
    expect(page).toContain('Market data products and their terms');
    expect(page).not.toContain('data-terms-state=');
  });
  it('the auth error catalogue address publishes the catalogue and links the permission table', () => {
    const page = html('/developers/errors/auth');
    expect(page).toContain('Authentication and permission errors');
    expect(page).not.toContain('DV-errors-02');
    expect(page).toContain('href="/developers/permissions"');
  });
});

describe('the clock check', () => {
  const api = (answer: unknown, ok = true) =>
    ({
      rest: vi.fn(async () => (ok ? { ok: true, data: answer } : { ok: false, reason: 'unreachable', message: 'x' })),
    }) as unknown as ApiClient;
  it('takes the offset at the middle of the round trip', async () => {
    const times = [1_000, 1_040];
    const result = await readServerClock(api({ serverTime: 1_520 }), { now: () => times.shift()! });
    expect(result).toEqual({ ok: true, data: { offsetMs: 500, roundTripMs: 40 } });
  });
  it('fails without an offset when the server time cannot be read', async () => {
    expect((await readServerClock(api(null, false))).ok).toBe(false);
  });
  // A TEST window: the live one is the owner's, read from identity's published policy.
  const WINDOW = 90;
  it('is within the window up to the signing window, either way, and outside past it', () => {
    const edge = WINDOW * 1000;
    expect(withinWindow(edge, 0, WINDOW)).toBe(true);
    expect(withinWindow(-edge, 0, WINDOW)).toBe(true);
    expect(withinWindow(edge + 1, 0, WINDOW)).toBe(false);
  });
  it('counts half the round trip against the window: a reading near its edge is not called within', () => {
    const edge = WINDOW * 1000;
    expect(withinWindow(edge - 200, 800, WINDOW)).toBe(false);
    expect(withinWindow(-(edge - 400), 800, WINDOW)).toBe(true);
  });
});

describe('developer docs copy', () => {
  it('is written in Spanish and French in full', () => {
    for (const locale of ['es', 'fr'] as const) expect(docsCopy.coverage(locale).missing).toEqual([]);
  });
  it('writes every portal key added for access, search and waiting sections in Spanish and French', () => {
    const added = /^(section_connectivity|section_data_terms|access_|waitsFor|pageHere|search|errorsAuth)/;
    for (const locale of ['es', 'fr'] as const)
      expect(developersCopy.coverage(locale).missing.filter((key) => added.test(key))).toEqual([]);
  });
});
