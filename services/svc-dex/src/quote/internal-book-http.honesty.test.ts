/**
 * Q-dex leftover — quote/book HTTP must not sell the internal book as
 * non-custodial or as an on-chain AMM, ranking as certified best-ex, or empty
 * `DEX_EXTERNAL_VENUES` as a live external venue. H11 fee refuse is already
 * on main; this file does not recut bps or invent venue rows.
 *
 * Door: Fastify + `/trpc` as index.ts mounts — not createCaller-only.
 * GET `/health` is the leftover mill door #3868 did not cover.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { createEdgeContext } from '@intafaced/contracts';
import { parseAmount as amt, type Amount } from '@intafaced/ledger-client/money';
import { createDexRouter, type DexRouter } from '../router.js';
import { dexHealthHonesty, dexReadyHonesty } from './door-honesty.js';
import { MarketDataSource } from './market-data-source.js';
import type { BookLevel, TimestampedBook, VenueKind } from './venue.js';

const SECRET = 'dex-q-internal-book-http-honesty-secret-32';

/** Attributed empty screening answer so quote is not refused for a blank list. */
const priorRegions = process.env[SANCTIONS_REGIONS_ENV];
const priorSource = process.env[SANCTIONS_SOURCE_ENV];
beforeAll(() => {
  process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
  process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
});
afterAll(() => {
  if (priorRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = priorRegions;
  if (priorSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = priorSource;
});
const NOW = new Date('2026-07-29T12:00:00.000Z');
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });

const here = dirname(fileURLToPath(import.meta.url));

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

class InternalBookVenue extends MarketDataSource {
  readonly id = 'internal-book';
  readonly kind: VenueKind = 'internal';
  readonly feeBps = 5;
  readonly settlementCost: Amount = 0n;

  constructor() {
    super({ quoteTtlMs: 2_000 });
  }

  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
    const level = (price: string, qty: string): BookLevel => [amt(price), amt(qty)];
    return {
      venueId: this.id,
      symbol,
      bids: [level('99', '10')],
      asks: [level('100', '10')],
      observedAt: NOW,
      sequence: 1,
    };
  }
}

async function mount(opts: { internalBookEnabled: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const router = createDexRouter({
    venues: () => (opts.internalBookEnabled ? [new InternalBookVenue()] : []),
    maxAgeMs: 2_000,
    depth: 50,
    // A hide list that was read and is empty: every market is listed.
    hideList: { read: async () => ({ asOf: NOW.toISOString(), pools: [], markets: [] }) },
    now: () => NOW,
    internalBookEnabled: opts.internalBookEnabled,
    ammVenueWired: false,
    externalVenueWired: false,
  });
  app.get('/health', async () =>
    dexHealthHonesty({
      internalBookEnabled: opts.internalBookEnabled,
      ammVenueWired: false,
      externalVenueWired: false,
    }),
  );
  app.get('/ready', async () =>
    dexReadyHonesty({
      internalBookEnabled: opts.internalBookEnabled,
      ammVenueWired: false,
      externalVenueWired: false,
    }),
  );
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<DexRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

async function trpcGet(app: FastifyInstance, path: string, input?: Record<string, unknown>) {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/${path}${qs}`,
    headers: { 'x-intafaced-region': 'DE' },
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('Q-dex HTTP — internal book is not non-custodial', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('GET /health names custodial internal-book, idle bestEx, no live external venue', async () => {
    const app = await mount({ internalBookEnabled: true });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      service: 'svc-dex',
      serviceHoldsBalances: false,
      ammVenueWired: false,
      externalVenueWired: false,
      bestEx: { ok: true, claimed: false },
      internalBook: { enabled: true, custodial: true, plane: 'fiat', venueKind: 'internal', amm: false },
    });
    expect(body.custodial).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/"custodial":false/);
  });

  it('GET /ready names internal-book custodial fiat, not protocol self-custody, not AMM', async () => {
    const app = await mount({ internalBookEnabled: true });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ready: true,
      serviceHoldsBalances: false,
      ammVenueWired: false,
      externalVenueWired: false,
      bestEx: { ok: true, claimed: false },
      internalBook: { enabled: true, custodial: true, plane: 'fiat', venueKind: 'internal', amm: false },
    });
    expect(body.custodial).toBeUndefined();
    expect(body.plane).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/"custodial":false/);
  });

  it('GET /trpc/health does not claim custodial:false while the internal book is on', async () => {
    const app = await mount({ internalBookEnabled: true });
    apps.push(app);
    const { statusCode, body } = await trpcGet(app, 'health');
    expect(statusCode).toBe(200);
    const data = body.result?.data as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: true,
      service: 'svc-dex',
      serviceHoldsBalances: false,
      ammVenueWired: false,
      externalVenueWired: false,
      bestEx: { ok: true, claimed: false },
      internalBook: { enabled: true, custodial: true, plane: 'fiat', venueKind: 'internal', amm: false },
    });
    expect(data.custodial).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/"custodial":false/);
  });

  it('GET /trpc/quote of the internal book is custodial, executable:false, never AMM', async () => {
    const app = await mount({ internalBookEnabled: true });
    apps.push(app);
    const { statusCode, body } = await trpcGet(app, 'quote', { symbol: 'IFC-USD', side: 'buy', qty: '1' });
    expect(statusCode).toBe(200);
    const quoted = body.result?.data as {
      custodialLegs: boolean;
      executable: boolean;
      nonExecutableReason: string | null;
      ammVenueWired: boolean;
      internalBook: { enabled: boolean; priced?: boolean; custodial?: boolean; plane?: string; venueKind?: string; amm?: boolean };
      venues: Array<{ venueId: string; venueKind: string; kind: string; plane: string; custodial: boolean }>;
      route: { legs: Array<{ venue: string; kind: string }> };
    };
    expect(quoted.venues[0]).toMatchObject({
      venueId: 'internal-book',
      venueKind: 'internal',
      kind: 'book',
      plane: 'fiat',
      custodial: true,
    });
    expect(quoted.venues[0]?.kind).not.toBe('pool');
    expect(quoted.venues[0]?.venueKind).not.toBe('amm');
    expect(quoted.route.legs[0]).toMatchObject({ venue: 'internal-book', kind: 'book' });
    expect(quoted.custodialLegs).toBe(true);
    expect(quoted.executable).toBe(false);
    expect(quoted.nonExecutableReason).toBe('custodial_settlement');
    expect(quoted.ammVenueWired).toBe(false);
    expect((quoted as { externalVenueWired?: boolean }).externalVenueWired).toBe(false);
    expect((quoted as { bestEx?: { claimed?: boolean } }).bestEx).toEqual({ ok: true, claimed: false });
    expect(quoted.internalBook).toEqual({
      enabled: true,
      priced: true,
      custodial: true,
      plane: 'fiat',
      venueKind: 'internal',
      amm: false,
    });
    expect(JSON.stringify(quoted)).not.toMatch(/"custodial":false/);
  });

  it('index.ts / router.ts no longer ship a custodial:false door claim', () => {
    const indexSrc = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    const routerSrc = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(indexSrc).not.toMatch(/custodial:\s*false/);
    expect(indexSrc).not.toMatch(/Non-custodial by construction/);
    expect(routerSrc).not.toMatch(/custodial:\s*z\.literal\(false\)/);
    expect(indexSrc).toContain('dexHealthHonesty');
    expect(indexSrc).toContain('dexReadyHonesty');
    expect(indexSrc).toContain('externalVenueWired');
    expect(routerSrc).toContain('dexHealthHonesty');
  });
});
