import { describe, expect, it, vi } from 'vitest';
import { bootExecution, loadExecutionEnv } from './testing/boot.js';
import {
  loadMatchingVenueHalt,
  matchingVenueHaltRefuse,
  optionalVenueHalted,
  readMatchingUrl,
  resolveMatchingVenueHalt,
} from './oms-matching-venue-halt.js';

describe('optionalVenueHalted', () => {
  it('reads boolean venueHalted; never invents a halt', () => {
    expect(optionalVenueHalted({ venueHalted: true })).toBe(true);
    expect(optionalVenueHalted({ venueHalted: false })).toBe(false);
    expect(optionalVenueHalted({ venue_halted: true })).toBe(true);
    expect(optionalVenueHalted({ markets: ['BTC-USDT'], halted: ['BTC-USDT'] })).toBeUndefined();
    expect(optionalVenueHalted({ ok: true, service: 'svc-matching' })).toBeUndefined();
    expect(optionalVenueHalted({ venueHalted: 'true' })).toBeUndefined();
    expect(optionalVenueHalted(null)).toBeUndefined();
  });
});

describe('matchingVenueHaltRefuse', () => {
  it('true refuses halt-all; false proceeds; missing refuses live', () => {
    expect(matchingVenueHaltRefuse({ venueHalted: true })).toMatchObject({ ok: false, reason: 'venue_halted' });
    expect(matchingVenueHaltRefuse({ venueHalted: false })).toBeNull();
    expect(matchingVenueHaltRefuse(undefined)).toMatchObject({ ok: false, reason: 'venue_halt_unavailable' });
    expect(matchingVenueHaltRefuse(null)).toMatchObject({ ok: false, reason: 'venue_halt_unavailable' });
  });
});

describe('readMatchingUrl', () => {
  it('trims; empty is missing — does not invent localhost', () => {
    expect(readMatchingUrl('http://matching.test/')).toBe('http://matching.test');
    expect(readMatchingUrl('  ')).toBeNull();
    expect(readMatchingUrl(undefined)).toBeNull();
  });
});

describe('loadMatchingVenueHalt', () => {
  it('open proceeds; halt-all is true; missing source is undefined', async () => {
    await expect(
      loadMatchingVenueHalt({
        matchingUrl: 'http://matching.test',
        fetch: async () =>
          new Response(JSON.stringify({ markets: ['BTC-USDT'], venueHalted: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toEqual({ venueHalted: false });

    await expect(
      loadMatchingVenueHalt({
        matchingUrl: 'http://matching.test',
        fetch: async () =>
          new Response(JSON.stringify({ markets: ['BTC-USDT'], venueHalted: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toEqual({ venueHalted: true });

    await expect(loadMatchingVenueHalt({})).resolves.toBeUndefined();
    await expect(loadMatchingVenueHalt({ matchingUrl: '   ' })).resolves.toBeUndefined();
    await expect(
      loadMatchingVenueHalt({
        matchingUrl: 'http://matching.test',
        fetch: async () => new Response('nope', { status: 200 }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      loadMatchingVenueHalt({
        matchingUrl: 'http://matching.test',
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, service: 'svc-matching' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it('GET /markets only — never POST /halt-all, never invents an operator', async () => {
    const seen: string[] = [];
    await loadMatchingVenueHalt({
      matchingUrl: 'http://matching.test',
      fetch: async (input, init) => {
        seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response(JSON.stringify({ venueHalted: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(seen).toEqual(['GET http://matching.test/markets']);
    expect(seen.join(' ')).not.toMatch(/halt-all|operator/i);
  });
});

describe('resolveMatchingVenueHalt', () => {
  it('passes a snapshot through; loader null is missing', async () => {
    await expect(resolveMatchingVenueHalt({ venueHalted: false })).resolves.toEqual({ venueHalted: false });
    await expect(resolveMatchingVenueHalt(undefined)).resolves.toBeUndefined();
    await expect(resolveMatchingVenueHalt(async () => null)).resolves.toBeUndefined();
  });
});

describe('MATCHING_URL env is the halt source, never invented', () => {
  it('env declares MATCHING_URL optional; blank is absent', async () => {
    expect((await loadExecutionEnv({ MATCHING_URL: undefined })).MATCHING_URL).toBeUndefined();
    expect((await loadExecutionEnv({ MATCHING_URL: '' })).MATCHING_URL).toBeUndefined();
    expect((await loadExecutionEnv({ MATCHING_URL: '   ' })).MATCHING_URL).toBeUndefined();
    expect((await loadExecutionEnv({ MATCHING_URL: 'http://matching.test:4005' })).MATCHING_URL).toBe('http://matching.test:4005');
  });

  it('index loads GET /markets from MATCHING_URL, never POST /halt-all', async () => {
    const seen: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(JSON.stringify({ venueHalted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const booted = await bootExecution({
      MATCHING_URL: 'http://matching.test:4005',
      IDENTITY_URL: 'http://identity.test:4001',
      INTERNAL_SERVICE_SECRET: 'i'.repeat(32),
    });
    try {
      // createExecutionRouter's matchingVenueHalt, matchingUrl and operatorApprovals (parameters 23, 24 and 26).
      const halt = booted.routerArgs[22] as () => Promise<unknown>;
      expect(seen).toEqual([]);
      await expect(halt()).resolves.toEqual({ venueHalted: true });
      expect(seen).toEqual(['GET http://matching.test:4005/markets']);
      expect(booted.routerArgs[23]).toBe('http://matching.test:4005');
      // The internal service secret is what lets the host build the operator approval client.
      expect(booted.routerArgs[25]).toBeDefined();
    } finally {
      await booted.close();
      fetchSpy.mockRestore();
    }

    const unset = await bootExecution({ IDENTITY_URL: 'http://identity.test:4001' });
    try {
      await expect((unset.routerArgs[22] as () => Promise<unknown>)()).resolves.toBeUndefined();
      expect(unset.routerArgs[23]).toBeUndefined();
      expect(unset.routerArgs[25]).toBeUndefined();
    } finally {
      await unset.close();
    }
  });
});
