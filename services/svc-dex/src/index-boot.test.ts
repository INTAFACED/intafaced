/**
 * svc-dex's own entrypoint, booted: `index.ts` imported with its env and its app driven by inject, the way the edge
 * reaches it. svc-dex opens no database and no bus, so nothing is stood in for but the listener. What this proves is
 * what the started process serves (its health, readiness and quote doors), not what its source text says.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { copyClaimsBestEx } from '@intafaced/venue-adapter';
import { dexHealthHonesty, dexReadyHonesty } from './quote/door-honesty.js';

const booted = vi.hoisted(() => ({ apps: [] as FastifyInstance[] }));

vi.mock('fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('fastify')>();
  const make = ((options?: FastifyServerOptions) => {
    const app = real.default(options);
    // The boot is driven by inject: no port is opened.
    Object.defineProperty(app, 'listen', { value: async () => '' });
    booted.apps.push(app);
    return app;
  }) as typeof real.default;
  return { ...real, default: make };
});

const storeDir = mkdtempSync(join(tmpdir(), 'svc-dex-index-boot-'));
const BASE_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: '4995',
  LOG_LEVEL: 'fatal',
  OTEL_ENABLED: 'false',
  DEX_ORDER_STORE_DIR: storeDir,
  DEX_EXTERNAL_VENUES: undefined,
  // An attributed empty screening answer, so the quote door is reached rather than refused for a blank list.
  [SANCTIONS_REGIONS_ENV]: SCREENING_REVIEWED_EMPTY,
  [SANCTIONS_SOURCE_ENV]: 'counsel-memo-ref',
  // A venue that is never there: the quote door answers with what it could read, which is nothing.
  MATCHING_URL: 'http://127.0.0.1:1',
  INDEXER_URL: 'http://127.0.0.1:1',
  QUOTE_MAX_AGE_MS: '500',
  DEX_QUOTE_DEPTH: '10',
};

async function boot(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  booted.apps.length = 0;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

async function get(app: FastifyInstance, url: string) {
  const res = await app.inject({ method: 'GET', url, headers: { 'x-intafaced-region': 'DE' } });
  return { status: res.statusCode, text: res.body, body: res.json() as Record<string, unknown> };
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe('svc-dex index.ts, booted', () => {
  for (const enabled of [true, false]) {
    it(`serves /health and /ready from the door honesty with the internal book ${enabled ? 'on' : 'off'}: no custodial:false, no best-ex claim`, async () => {
      const app = await boot({ DEX_INTERNAL_BOOK_ENABLED: String(enabled), DEX_INTERNAL_BOOK_FEE_BPS: '5' });
      const door = { internalBookEnabled: enabled, ammVenueWired: false, externalVenueWired: false };
      const health = await get(app, '/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual(JSON.parse(JSON.stringify(dexHealthHonesty(door))));
      const ready = await get(app, '/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual(JSON.parse(JSON.stringify(dexReadyHonesty(door))));
      for (const answer of [health, ready]) {
        expect(answer.body.externalVenueWired).toBe(false);
        expect(answer.text).not.toMatch(/"custodial":false/);
        expect(answer.text).not.toMatch(/Non-custodial by construction/i);
        expect(copyClaimsBestEx(answer.text)).toBe(false);
      }
      if (enabled) expect(health.body.internalBook).toMatchObject({ enabled: true, custodial: true, plane: 'fiat', amm: false });
    });
  }

  it('the router it serves answers health and the quote door without custodial:false or a best-ex claim', async () => {
    const app = await boot({ DEX_INTERNAL_BOOK_ENABLED: 'true', DEX_INTERNAL_BOOK_FEE_BPS: '5' });
    const health = await get(app, '/trpc/health');
    expect(health.status).toBe(200);
    expect((health.body.result as { data: Record<string, unknown> }).data.internalBook).toMatchObject({ custodial: true });
    const quote = await get(app, `/trpc/quote?input=${encodeURIComponent(JSON.stringify({ symbol: 'IFC-USD', side: 'buy', qty: '1' }))}`);
    // With no hide list published the quote door refuses by name rather than quote around it (a quote itself:
    // quote/internal-book-http.honesty.test.ts).
    expect(quote.status).toBe(412);
    expect(quote.text).toContain('dex.quote.hide_list_unset');
    for (const answer of [health, quote]) {
      expect(answer.text).not.toMatch(/"custodial":false/);
      expect(copyClaimsBestEx(answer.text)).toBe(false);
    }
  });
});
