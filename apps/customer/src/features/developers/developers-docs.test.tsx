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
import { SIGN_WINDOW_SECONDS, readClock, withinWindow } from './DocsPages';
import { developersCopy } from './developers-copy';
import { docsCopy } from './developers-docs-copy';
import { AUDIENCES, SECTIONS, developersRoute } from './developers-model';
import { REST_REFERENCE, routeLine } from './developers-reference';
import { searchDocs } from './developers-search';

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
    expect(text(html('/developers/errors'))).toContain('It waits for DV-errors-01');
    expect(text(html('/developers/authentication'))).toContain('It waits for DV-auth-01');
  });
  it('search finds pages by title or route, and finds nothing for an unknown topic', () => {
    const title = (id: string) => developersCopy.forLocale('en').t(`section_${id.replace(/-/g, '_')}` as 'section_rest');
    expect(searchDocs('zz-no-such-developer-topic', title, 'Base addresses')).toEqual([]);
    expect(searchDocs('rest', title, 'Base addresses').map((m) => m.href)).toContain('/developers/rest');
    expect(searchDocs('/api/v1/time', title, 'Base addresses').map((m) => m.href)).toEqual(['/developers/reference']);
    expect(searchDocs('   ', title, 'Base addresses')).toEqual([]);
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
    const write = page.slice(page.indexOf('data-scope="trade:write"'), page.indexOf('data-scope="trade:withdraw"'));
    expect(write).toContain('POST /api/v1/orders');
    expect(write).not.toContain('GET /api/v1/');
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
  it('connectivity: unset hosts read host not set, colocation is parked on hardware', () => {
    const page = html('/developers/connectivity');
    const row = (key: string) =>
      text(page.slice(page.indexOf(`data-option="${key}"`), page.indexOf('</tr>', page.indexOf(`data-option="${key}"`))));
    expect(row('internet')).toContain('host not set');
    expect(row('redundant')).toContain('host not set');
    expect(row('colocation')).toMatch(/Parked.*hardware/);
    expect(page).toContain('data-testid="developers-time-probe"');
  });
  it('data terms: every product, every term not set, and what they wait for', () => {
    const page = html('/developers/data-terms');
    expect(page.match(/data-terms-state="unset"/g)).toHaveLength(6);
    expect(page.match(/<td>not set<\/td>/g)).toHaveLength(30);
    expect(text(page)).toContain('RC-developer-05');
  });
  it('the auth error catalogue address says what it waits for and links the permission table', () => {
    const page = html('/developers/errors/auth');
    expect(page).toContain('Authentication and permission errors');
    expect(page).toContain('DV-errors-02');
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
    const result = await readClock(api({ serverTime: 1_520 }), () => times.shift()!);
    expect(result).toEqual({ ok: true, reading: { offsetMs: 500, roundTripMs: 40 } });
  });
  it('fails without an offset when the server time cannot be read', async () => {
    expect(await readClock(api(null, false))).toEqual({ ok: false });
  });
  it('is within the window up to the signing window, either way, and outside past it', () => {
    const edge = SIGN_WINDOW_SECONDS * 1000;
    expect(withinWindow({ offsetMs: edge, roundTripMs: 1 })).toBe(true);
    expect(withinWindow({ offsetMs: -edge, roundTripMs: 1 })).toBe(true);
    expect(withinWindow({ offsetMs: edge + 1, roundTripMs: 1 })).toBe(false);
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
