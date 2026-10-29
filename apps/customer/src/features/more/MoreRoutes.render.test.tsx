import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.stubGlobal('location', new URL('https://app.example.com/'));
// A room may tidy its own address while it renders; on the server there is no history to tidy.
vi.stubGlobal('history', { state: null, replaceState: () => undefined, pushState: () => undefined });

import { SessionProvider } from '../session/session';
import { MoreRoutes, SECTION_TABS } from './MoreRoutes';
import { MORE_ROUTES } from './more-room-routes';

const page = (path: string) =>
  renderToString(
    <SessionProvider>
      <MoreRoutes path={path} />
    </SessionProvider>,
  );

describe('More room sections and records (MC-order-01)', () => {
  it('shows a record with no data source as such, titled, with a way back to its room', () => {
    const html = page('/market/listing-9');
    expect(html).toContain('Market listing');
    expect(html).toContain('No details are shown for this record');
    expect(html).toContain('href="/market"');
  });

  it('refuses a malformed id without looking anything up', () => {
    expect(page('/market/a%2Fb')).toContain('That address is not valid');
    expect(page('/token/governance/%E0%A4%A')).toContain('That address is not valid');
  });

  it('opens a section inside its room under its own title', () => {
    const html = page('/mining/workers');
    expect(html).toContain('Mining workers');
    expect(html).not.toContain('No details are shown for this record');
  });

  it("opens each section address on its own tab, not on the room's first one (Phantom 24 Oct)", () => {
    const selected = (html: string) => [...html.matchAll(/aria-pressed="true"[^>]*>([^<]*)</g)].map((hit) => hit[1]);
    expect(selected(page('/mining'))).toEqual(['Overview']);
    for (const [path, tab] of [
      ['/mining/workers', 'Workers'],
      ['/mining/shares', 'Shares'],
      ['/mining/rewards', 'Rewards'],
      ['/mining/status', 'Pool status'],
      ['/launch/new', 'Issuer journey'],
      ['/launch/check', 'Pre-listing check'],
      ['/launch/requirements', 'Requirements'],
      ['/token/governance', 'Governance'],
      ['/token/economy', 'Economy'],
      ['/token/burn', 'Burn'],
    ] as const) {
      expect(selected(page(path)), path).toEqual([tab]);
    }
    expect(selected(page('/mining/workers?simulated=true'))).toEqual(['Workers']);
  });

  it("gives every tabbed room's section address a tab, so a new section cannot fall back to the first one", () => {
    for (const route of MORE_ROUTES) {
      if (route.kind !== 'part' || !(route.room in SECTION_TABS)) continue;
      const tabs: Record<string, string> = SECTION_TABS[route.room as keyof typeof SECTION_TABS];
      expect(tabs[route.pattern.split('/')[2] ?? ''], route.pattern).toBeTruthy();
    }
  });

  it('keeps the honest "no customer route" panel for a path that is not a section or record', () => {
    expect(page('/market/a/b/c')).toContain('href="/more"');
  });

  it('labels every room of the set simulated under ?simulated=true, with a way to the live room', () => {
    for (const path of ['/predict', '/market', '/launch', '/token/governance', '/mining', '/blueprint', '/mining/workers']) {
      const html = page(`${path}?simulated=true&tab=x`);
      expect(html, path).toContain('data-paper="simulated"');
      expect(html, path).toContain('Simulated view');
      expect(html, path).toContain(`href="${path}?tab=x"`);
    }
  });

  it('shows no simulated label without the flag, or on a room outside the set', () => {
    expect(page('/market')).not.toContain('data-paper');
    expect(page('/market?simulated=false')).not.toContain('data-paper');
    expect(page('/campaigns?simulated=true')).not.toContain('data-paper');
  });
});
