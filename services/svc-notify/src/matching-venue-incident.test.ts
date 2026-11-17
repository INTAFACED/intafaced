/**
 * Unit card — matching GET /markets halt consume
 * 1. Promise: halt-all / one-market halt from matching board; missing is unavailable
 * 2. Break: missing field treated as live (silent all-fine) or invented halt
 * 3. Done bar: venueHalted true/false; halted ids; unwired; non-OK/parse/missing field
 * 4. Class N
 * 5. Paths: services/svc-notify/src/matching-venue-incident.ts
 * 6. RED: never POST /halt-all
 * 7. Collision: none
 */

import { describe, expect, it, vi } from 'vitest';
import { loadMatchingVenueIncident, optionalHaltedMarkets, optionalVenueHalted, readMatchingUrl } from './matching-venue-incident.js';

describe('matching venue incident consume', () => {
  it('reads venueHalted only as a boolean — never from a string', () => {
    expect(optionalVenueHalted({ venueHalted: true })).toBe(true);
    expect(optionalVenueHalted({ venueHalted: false })).toBe(false);
    expect(optionalVenueHalted({ venue_halted: true })).toBe(true);
    expect(optionalVenueHalted({ venueHalted: 'true' })).toBeUndefined();
    expect(optionalVenueHalted({ halted: ['m1'] })).toBeUndefined();
    expect(optionalVenueHalted(null)).toBeUndefined();
  });

  it('reads halted market ids without inventing a list from a missing field', () => {
    expect(optionalHaltedMarkets({ halted: ['m1', 'm2'] })).toEqual(['m1', 'm2']);
    expect(optionalHaltedMarkets({ venueHalted: false })).toEqual([]);
    expect(optionalHaltedMarkets({ halted: [1, 'm1', ''] })).toEqual(['m1']);
  });

  it('blank MATCHING_URL is missing — never localhost', () => {
    expect(readMatchingUrl(undefined)).toBeNull();
    expect(readMatchingUrl('')).toBeNull();
    expect(readMatchingUrl('   ')).toBeNull();
    expect(readMatchingUrl('http://svc-matching:4005/')).toBe('http://svc-matching:4005');
  });

  it('unset URL is unwired and does not fetch', async () => {
    const fetchFn = vi.fn();
    await expect(loadMatchingVenueIncident({ matchingUrl: undefined, fetch: fetchFn })).resolves.toEqual({
      kind: 'unwired',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('open board is open; halt-all is halt-all; one-market halt is named', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe('http://matching.test/markets');
      return new Response(JSON.stringify({ markets: ['m1'], venueHalted: false, halted: [] }), { status: 200 });
    });
    await expect(loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: fetchFn as typeof fetch })).resolves.toEqual({
      kind: 'board',
      board: { venueHalted: false, haltedMarkets: [] },
    });

    const haltAll = vi.fn(async () => new Response(JSON.stringify({ venueHalted: true, halted: [] }), { status: 200 }));
    await expect(loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: haltAll as typeof fetch })).resolves.toEqual({
      kind: 'board',
      board: { venueHalted: true, haltedMarkets: [] },
    });

    const one = vi.fn(async () => new Response(JSON.stringify({ venueHalted: false, halted: ['btc-usd'] }), { status: 200 }));
    await expect(loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: one as typeof fetch })).resolves.toEqual({
      kind: 'board',
      board: { venueHalted: false, haltedMarkets: ['btc-usd'] },
    });
  });

  it('missing venueHalted / transport / non-OK is unavailable — not live', async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ markets: [] }), { status: 200 }));
    await expect(loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: missing as typeof fetch })).resolves.toEqual({
      kind: 'unavailable',
    });

    const down = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: down as typeof fetch })).resolves.toEqual({
      kind: 'unavailable',
    });

    const boom = vi.fn(async () => {
      throw new Error('econnrefused');
    });
    await expect(loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: boom as typeof fetch })).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('does not POST /halt-all or invent an operator', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ venueHalted: false, halted: [] }), { status: 200 });
    });
    await loadMatchingVenueIncident({ matchingUrl: 'http://matching.test', fetch: fetchFn as typeof fetch });
    expect(seen.join(' ')).not.toMatch(/halt-all|operator|POST/i);
    expect(seen).toEqual(['GET http://matching.test/markets']);
  });
});
