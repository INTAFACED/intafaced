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
  it('a TEST part says TEST and names the TEST adapter its figures come from; a part that is not TEST names none', () => {
    const read = { state: 'read', asOf: FRESH, rows: [{ asset: 'USDC', amount: '1' }] } as const;
    const html = draw([
      { id: 'wallet', label: 'Base Sepolia test network', test: true, adapter: '84532', read },
      { id: 'venue', label: 'TEST venue simulator', test: true, adapter: 'TEST venue simulator', read },
      { id: 'partner', label: 'A bank', adapter: 'A bank', read },
    ]);
    const row = (id: string) => {
      const from = html.slice(html.indexOf(`data-part="${id}"`));
      return from.slice(0, from.indexOf('</li>'));
    };
    expect(row('wallet')).toContain('<span class="lt-test">TEST</span>');
    expect(row('wallet')).toContain('data-testid="standing-part-adapter">TEST source: TEST chain 84532</span>');
    expect(row('venue')).toContain('<span class="lt-test">TEST</span>');
    expect(row('venue')).toContain('data-testid="standing-part-adapter">TEST source: TEST venue simulator</span>');
    // Not TEST: no TEST label and no adapter, whatever name it was given.
    expect(row('partner')).not.toContain('lt-test');
    expect(row('partner')).not.toContain('standing-part-adapter');
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
