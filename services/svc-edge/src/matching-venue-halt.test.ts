import { describe, expect, it } from 'vitest';
import {
  assertMatchingHaltSource,
  assertMatchingVenueNotHaltAll,
  isNewOrderTraffic,
  optionalVenueHalted,
  readMatchingUrl,
  venueIsHalted,
  MatchingVenueHaltError,
} from './matching-venue-halt.js';

describe('optionalVenueHalted', () => {
  it('reads boolean halted / venueHalted; never invents a halt', () => {
    expect(optionalVenueHalted({ halted: true })).toBe(true);
    expect(optionalVenueHalted({ venueHalted: true })).toBe(true);
    expect(optionalVenueHalted({ halted: false })).toBe(false);
    expect(optionalVenueHalted({ venueHalted: false })).toBe(false);
    expect(optionalVenueHalted({ ok: true, service: 'svc-matching' })).toBeUndefined();
    expect(optionalVenueHalted({ halted: 'true' })).toBeUndefined();
    expect(optionalVenueHalted(null)).toBeUndefined();
  });
});

describe('venueIsHalted / assertMatchingHaltSource', () => {
  it('true refuses halt-all; false proceeds; missing refuses live', () => {
    expect(venueIsHalted(true)).toBe(true);
    expect(venueIsHalted(false)).toBe(false);
    expect(venueIsHalted(undefined)).toBe(false);
    expect(() => assertMatchingHaltSource(true)).toThrow(MatchingVenueHaltError);
    try {
      assertMatchingHaltSource(true);
    } catch (err) {
      expect(err).toMatchObject({ code: 'edge.venue_halted' });
    }
    expect(() => assertMatchingHaltSource(false)).not.toThrow();
    expect(() => assertMatchingHaltSource(undefined)).toThrow(MatchingVenueHaltError);
    try {
      assertMatchingHaltSource(undefined);
    } catch (err) {
      expect(err).toMatchObject({ code: 'edge.venue_halt_unavailable' });
    }
  });
});

describe('readMatchingUrl', () => {
  it('trims; empty is missing — does not invent localhost', () => {
    expect(readMatchingUrl('http://matching.test/')).toBe('http://matching.test');
    expect(readMatchingUrl('  ')).toBeNull();
    expect(readMatchingUrl(undefined)).toBeNull();
  });
});

describe('isNewOrderTraffic', () => {
  it('POST place is new; cancel and read are not', () => {
    expect(isNewOrderTraffic('/api/v1/orders', 'POST')).toBe(true);
    expect(isNewOrderTraffic('/api/trade/trpc/orders.create', 'POST')).toBe(true);
    expect(isNewOrderTraffic('/api/trade/trpc/orders.cancel', 'POST')).toBe(false);
    expect(isNewOrderTraffic('/api/v1/orders/8f3c1d2e-0000-4000-8000-000000000001', 'DELETE')).toBe(false);
    expect(isNewOrderTraffic('/api/v1/orders', 'DELETE')).toBe(false);
    expect(isNewOrderTraffic('/api/v1/markets', 'GET')).toBe(false);
    expect(isNewOrderTraffic('/api/pay/trpc/checkout.open', 'POST')).toBe(false);
  });
});

describe('assertMatchingVenueNotHaltAll', () => {
  it('open proceeds; halt-all cannot place', async () => {
    await expect(
      assertMatchingVenueNotHaltAll({
        matchingUrl: 'http://matching.test',
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, halted: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertMatchingVenueNotHaltAll({
        matchingUrl: 'http://matching.test',
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, venueHalted: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'edge.venue_halted' });
  });

  it('GETs /health with no operator — the edge does not invent a caller', async () => {
    const seen: { url?: string; method?: string } = {};
    await assertMatchingVenueNotHaltAll({
      matchingUrl: 'http://matching.test/',
      fetch: async (input, init) => {
        seen.url = String(input);
        seen.method = init?.method;
        return new Response(JSON.stringify({ halted: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(seen.url).toBe('http://matching.test/health');
    expect(seen.method).toBe('GET');
    expect(seen.url).not.toMatch(/operator/i);
  });

  it('missing url, missing halted, 503, and transport cannot open as live', async () => {
    await expect(assertMatchingVenueNotHaltAll({ matchingUrl: '  ' })).rejects.toMatchObject({
      code: 'edge.venue_halt_unavailable',
    });
    await expect(
      assertMatchingVenueNotHaltAll({
        matchingUrl: 'http://matching.test',
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, service: 'svc-matching' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).rejects.toMatchObject({ code: 'edge.venue_halt_unavailable' });
    await expect(
      assertMatchingVenueNotHaltAll({
        matchingUrl: 'http://matching.test',
        fetch: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toMatchObject({ code: 'edge.venue_halt_unavailable' });
    await expect(
      assertMatchingVenueNotHaltAll({
        matchingUrl: 'http://matching.test',
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toMatchObject({ code: 'edge.venue_halt_unavailable' });
  });
});
