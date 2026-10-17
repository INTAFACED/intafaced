import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { assertMatchingVenueNotHaltAll, optionalVenueHalted, registerMatchingVenueHaltGuard } from './matching-venue-halt.js';

/**
 * CROSS-SERVICE CONTRACT: svc-matching `GET /health` <-> svc-edge halt guard.
 *
 * Edge's tests all fed it a hand-written `{ venueHalted: false }`, and matching's
 * tests never looked at edge, so the two halves could (and did) disagree: matching
 * /health never returned the field, and with MATCHING_URL set edge refused every
 * NEW order with 503 `edge.venue_halt_unavailable`. This file mounts matching's
 * REAL /health route and points edge's REAL parser and guard at it.
 */

/**
 * Loaded by path at run time, not by a static import: edge's `rootDir` is its own
 * `src`, so a static cross-service import fails the test typecheck (TS6059).
 * The shape below is the part of matching's `health.ts` this contract uses.
 */
interface HealthEngine {
  readonly isEnabled: boolean;
  readonly isVenueHalted: boolean;
  readonly markets: readonly unknown[];
  readonly restingOrderCount: number;
  readonly admissionOpen: boolean;
  readonly admissionReason: string | null;
  holdHaltedMarkets(): readonly string[];
}
type RegisterHealth = (app: FastifyInstance, service: string, engine: HealthEngine, journal: { readonly length: number }) => void;

async function loadRegisterHealth(): Promise<RegisterHealth> {
  const href = new URL('../../svc-matching/src/health.ts', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ href)) as { registerHealth?: RegisterHealth };
  if (typeof mod.registerHealth !== 'function') throw new Error('svc-matching/src/health.ts no longer exports registerHealth');
  return mod.registerHealth;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) {
    const a = apps.pop();
    if (a) await a.close();
  }
});

function engineWith(venueHalted: boolean): HealthEngine {
  return {
    isEnabled: true,
    isVenueHalted: venueHalted,
    markets: ['BTC-USDT'],
    restingOrderCount: 2,
    admissionOpen: true,
    admissionReason: null,
    holdHaltedMarkets: () => [],
  };
}

async function matchingHealth(venueHalted: boolean): Promise<{ body: unknown; fetch: typeof fetch }> {
  const matching = Fastify({ logger: false });
  (await loadRegisterHealth())(matching, 'svc-matching', engineWith(venueHalted), { length: 7 });
  await matching.ready();
  apps.push(matching);
  const body = (await matching.inject({ method: 'GET', url: '/health' })).json();
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    expect(url).toBe('http://matching.test/health');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { body, fetch: fetchFn };
}

describe("edge reads svc-matching's real /health body", () => {
  it('optionalVenueHalted accepts the body in both states — never undefined', async () => {
    expect(optionalVenueHalted((await matchingHealth(false)).body)).toBe(false);
    expect(optionalVenueHalted((await matchingHealth(true)).body)).toBe(true);
  });

  it('open matching passes assertMatchingVenueNotHaltAll; halt-all refuses as venue_halted, not venue_halt_unavailable', async () => {
    const open = await matchingHealth(false);
    await expect(assertMatchingVenueNotHaltAll({ matchingUrl: 'http://matching.test', fetch: open.fetch })).resolves.toBeUndefined();

    const halted = await matchingHealth(true);
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

    const open = await (await edgeFor((await matchingHealth(false)).fetch)).inject(submit);
    expect(open.statusCode).toBe(200);

    const halted = await (await edgeFor((await matchingHealth(true)).fetch)).inject(submit);
    expect(halted.statusCode).toBe(503);
    expect(halted.json().code).toBe('edge.venue_halted');
  });
});
