/**
 * Unit card — live host mounts venueIncident on /health and /ready
 * 1. Promise: M18 — halt/incident is named on the probes, not swallowed by ok:true
 * 2. Break: /health stays `{ ok, service }` so ops infer allFine from liveness
 * 3. Done bar: the booted entrypoint's /health and /ready both carry the venue incident matching reports
 * 4. Class N
 * 5. Paths: services/svc-notify/src/index.ts (booted through testing/boot.ts)
 * 6. RED: either probe drops venueIncident, or reads it from anything but matching's GET /markets
 * 7. Collision: none
 */

import { describe, expect, it } from 'vitest';
import { bootNotify } from './testing/boot.js';

/** /health and /ready of the booted service, and every request it sent while booting and answering them. */
async function probes(vars: Record<string, string | undefined>, venueHalted: boolean) {
  const seen: string[] = [];
  const booted = await bootNotify(vars, {
    fetch: async (input, init) => {
      seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(JSON.stringify({ venueHalted }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    const health = (await booted.app.inject({ method: 'GET', url: '/health' })).json();
    const ready = (await booted.app.inject({ method: 'GET', url: '/ready' })).json();
    return { health, ready, seen };
  } finally {
    await booted.close();
  }
}

describe('venue incident occupancy on /health and /ready', () => {
  it('live host mounts loadVenueIncident on both probes', async () => {
    const halted = await probes({ MATCHING_URL: 'http://matching.test:4005' }, true);
    for (const body of [halted.health, halted.ready]) {
      expect(body.venueIncident).toMatchObject({ allFine: false, matching: 'halted', code: 'notify.venue_halted' });
    }
    expect(halted.health.ok).toBe(true);

    const open = await probes({ MATCHING_URL: 'http://matching.test:4005' }, false);
    expect(open.health.venueIncident).toEqual(open.ready.venueIncident);
    expect(open.health.venueIncident.matching).not.toBe('halted');
  });

  it('no matching URL: both probes say unwired, never an invented all-clear', async () => {
    const unwired = await probes({ MATCHING_URL: undefined }, false);
    for (const body of [unwired.health, unwired.ready]) {
      expect(body.venueIncident).toMatchObject({ allFine: false, matching: 'unwired' });
    }
    expect(unwired.seen).toEqual([]);
  });

  it('consumes matching GET /markets — never POST /halt-all', async () => {
    const { seen } = await probes({ MATCHING_URL: 'http://matching.test:4005' }, true);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['GET http://matching.test:4005/markets']));
  });
});
