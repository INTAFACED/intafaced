import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { StandingTotal } from './StandingTotal';
import { STANDING_STALE_AFTER_MS, standing } from './standing';

// TEST figures and times. The clock is pinned so fresh and stale never change.
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const FRESH = new Date(NOW - 5_000).toISOString();
const OLD = new Date(NOW - STANDING_STALE_AFTER_MS - 1_000).toISOString();
const PRICES = {
  published: true,
  source: 'TEST prices',
  asOf: FRESH,
  test: true,
  prices: [{ asset: 'USDC', usd: '1' }],
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const draw = (parts: Parameters<typeof standing>[0]) =>
  renderToString(
    <StandingTotal standing={standing(parts, PRICES, 'USD')} pricesFailed={false} displayCurrency="USD" hidden={false} testId="t" />,
  );

const heldOf = (html: string, id: string) => html.match(new RegExp(`data-part="${id}" data-state="[a-z]+" data-held="([a-z]+)"`))?.[1];

describe('Where you stand: each figure’s state and the total’s time', () => {
  it('a fresh part is known, an old one stale with its time, an unread one not known; the total is as of its oldest counted part', () => {
    const html = draw([
      { id: 'wallet', label: 'TEST chain', read: { state: 'read', asOf: FRESH, rows: [{ asset: 'USDC', amount: '10' }] } },
      { id: 'venue', label: 'TEST venue', read: { state: 'read', asOf: OLD, rows: [{ asset: 'USDC', amount: '500' }] } },
      { id: 'partner', label: 'TEST bank', read: { state: 'unread' } },
    ]);
    expect(heldOf(html, 'wallet')).toBe('known');
    expect(heldOf(html, 'venue')).toBe('stale');
    expect(heldOf(html, 'partner')).toBe('unknown');
    // The stale part keeps its time and says Stale; the unread part says Not known and shows no figure.
    expect(html).toMatch(new RegExp(`data-held="stale"[^]*>Stale<[^]*dateTime="${OLD}"`));
    const partner = html.slice(html.indexOf('data-part="partner"'));
    expect(partner).toContain('>Not known<');
    expect(partner.slice(0, partner.indexOf('</li>'))).not.toContain('standing-part-value');
    // The total leaves the unread part out (J-home-ia-01 #1) and carries the oldest time among the parts it adds.
    expect(html).toContain('data-total-usd="510.00"');
    expect(html).toMatch(new RegExp(`data-testid="standing-as-of" data-held="stale"[^]*dateTime="${OLD}"`));
  });
  it('a part with nothing priced shows each amount as its source reports it, and each line of a part is one element', () => {
    const html = draw([
      {
        id: 'venue',
        label: 'TEST venue',
        read: {
          state: 'read',
          asOf: FRESH,
          rows: [
            { asset: 'BTC', amount: '0.00000123' },
            { asset: 'TWIN', amount: '0.0000006' },
          ],
        },
      },
    ]);
    const venue = html.slice(html.indexOf('data-part="venue"'));
    const li = venue.slice(0, venue.indexOf('</li>'));
    expect(li).toMatch(/data-testid="standing-part-amounts"[^>]*>0\.00000123 BTC, 0\.0000006 TWIN</);
    expect(li).toContain('Not valued: no published price');
    // The row stacks its children (.lt-rows > li), so the li holds elements only: no text of its own, such as a bare
    // separator, which would stand on a line by itself.
    const own = [];
    let depth = 0;
    for (const piece of li
      .slice(li.indexOf('>') + 1)
      .replaceAll('<!-- -->', '')
      .split(/(<[^>]+>)/)) {
      if (piece.startsWith('</')) depth -= 1;
      else if (piece.startsWith('<')) depth += piece.endsWith('/>') ? 0 : 1;
      else if (depth === 0 && piece.trim()) own.push(piece);
    }
    expect(own).toEqual([]);
  });
  it('with every part fresh, the total is known at its oldest part’s time', () => {
    const older = new Date(NOW - 10_000).toISOString();
    const html = draw([
      { id: 'wallet', label: 'TEST chain', read: { state: 'read', asOf: FRESH, rows: [{ asset: 'USDC', amount: '1' }] } },
      { id: 'venue', label: 'TEST venue', read: { state: 'read', asOf: older, rows: [{ asset: 'USDC', amount: '2' }] } },
    ]);
    expect(html).toMatch(new RegExp(`data-testid="standing-as-of" data-held="known"[^]*dateTime="${older}"`));
  });
});

describe('Where you stand: a TEST part names its TEST adapter (J-home-ia-11 #3)', () => {
  it('each TEST part is labelled TEST and names the adapter it is read from; a part that is not TEST names none', () => {
    const read = { state: 'read' as const, asOf: FRESH, rows: [{ asset: 'USDC', amount: '5' }] };
    const html = draw([
      { id: 'wallet', label: 'Local test chain', read, test: true },
      { id: 'venue', label: 'TEST venue simulator', read, test: true },
      { id: 'partner', label: 'Real partner bank', read },
    ]);
    const part = (id: string) => html.match(new RegExp(`<li[^>]*data-part="${id}"[^]*?</li>`))?.[0] ?? '';
    expect(part('wallet')).toMatch(/data-testid="standing-part-test">TEST</);
    expect(part('wallet')).toMatch(/data-testid="standing-part-adapter">from the TEST adapter Local test chain</);
    expect(part('venue')).toMatch(/data-testid="standing-part-test">TEST</);
    expect(part('venue')).toMatch(/data-testid="standing-part-adapter">from the TEST adapter TEST venue simulator</);
    expect(part('partner')).not.toContain('standing-part-test');
    expect(part('partner')).not.toContain('standing-part-adapter');
  });
});
