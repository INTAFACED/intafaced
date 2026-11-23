import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { assertMatchingVenueNotHaltAll, optionalVenueHalted, registerMatchingVenueHaltGuard } from './matching-venue-halt.js';

/**
 * CROSS-SERVICE CONTRACT: svc-matching `GET /health` <-> svc-edge halt guard.
 *
 * Edge's tests all fed it a hand-written `{ venueHalted: false }`, and matching's
 * tests never looked at edge, so the two halves could (and did) disagree: matching
 * /health never returned the field, and with MATCHING_URL set edge refused every
 * NEW order with 503 `edge.venue_halt_unavailable`. This file points edge's REAL
 * parser and guard at matching's real /health bodies, open and venue-halted: the
 * fixtures `crates/svc-matching/tests/serve.rs`
 * (`health_bodies_edge_reads_are_the_fixtures_it_reads`) holds the Rust door's
 * own answers to, byte for byte.
 */

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) {
    const a = apps.pop();
    if (a) await a.close();
  }
});

function matchingHealth(venueHalted: boolean): { body: unknown; fetch: typeof fetch } {
  const name = venueHalted ? 'health-venue-halted.json' : 'health-open.json';
  const body: unknown = JSON.parse(readFileSync(new URL(`../../../crates/svc-matching/tests/fixtures/${name}`, import.meta.url), 'utf8'));
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    expect(url).toBe('http://matching.test/health');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { body, fetch: fetchFn };
}

describe("edge reads svc-matching's real /health body", () => {
  it('optionalVenueHalted accepts the body in both states — never undefined', async () => {
    expect(optionalVenueHalted(matchingHealth(false).body)).toBe(false);
    expect(optionalVenueHalted(matchingHealth(true).body)).toBe(true);
  });

  it('open matching passes assertMatchingVenueNotHaltAll; halt-all refuses as venue_halted, not venue_halt_unavailable', async () => {
    const open = matchingHealth(false);
    await expect(assertMatchingVenueNotHaltAll({ matchingUrl: 'http://matching.test', fetch: open.fetch })).resolves.toBeUndefined();

    const halted = matchingHealth(true);
    await expect(assertMatchingVenueNotHaltAll({ matchingUrl: 'http://matching.test', fetch: halted.fetch })).rejects.toMatchObject({
      code: 'edge.venue_halted',
    });
  });

  it('with MATCHING_URL set, NEW trade orders pass when matching is open and 503 venue_halted when halted', async () => {
    const edgeFor = async (fetchFn: typeof fetch) => {
      const app = Fastify({ logger: false });
      registerMatchingVenueHaltGuard(app, { matchingUrl: 'http://matching.test', fetch: fetchFn });
      app.all('/api/*', async () => ({ ok: true }));
      await app.ready();
      apps.push(app);
      return app;
    };
    const submit = { method: 'POST', url: '/api/trade/orders', payload: {} } as const;

    const open = await (await edgeFor(matchingHealth(false).fetch)).inject(submit);
    expect(open.statusCode).toBe(200);

    const halted = await (await edgeFor(matchingHealth(true).fetch)).inject(submit);
    expect(halted.statusCode).toBe(503);
    expect(halted.json().code).toBe('edge.venue_halted');
  });
});
