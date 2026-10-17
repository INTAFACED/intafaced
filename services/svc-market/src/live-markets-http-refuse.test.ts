/**
 * Q-market HTTP door: live-market catalogue is named-refused without owner pin.
 * createCaller is not HTTP — this mounts Fastify + /trpc like index.ts.
 * A /trpc/liveMarkets 404 would look like "not a door".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { createMarketRouter, type MarketRouter } from './router.js';
import type { VendorService } from './vendor-service.js';
import { MARKET_LISTING_PIN_ENV, MARKET_LISTING_PIN_UNSET, MARKET_LISTING_SET_UNSET } from './live-markets.js';

const SECRET = 'market-q-listing-pin-http-refuse-edge-secret-32';
const SAVED = process.env[MARKET_LISTING_PIN_ENV];

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-market' });

type WireBody = {
  error?: {
    message?: string;
    data?: { code?: string; httpStatus?: number; cause?: { code?: string } };
  };
  result?: { data?: { markets?: unknown } };
};

function stubVendors(): VendorService {
  return {
    applyAsVendor: vi.fn(),
    myVendor: vi.fn(),
    listApplications: vi.fn(),
    vet: vi.fn(),
    history: vi.fn(),
    claimSlot: vi.fn(),
    releaseSlot: vi.fn(),
    slotStatus: vi.fn(),
    publicProfile: vi.fn(),
    listedVendors: vi.fn(),
    listingEligibility: vi.fn(),
  } as unknown as VendorService;
}

async function mount(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const router = createMarketRouter(stubVendors());
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<MarketRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

async function get(app: FastifyInstance, path: string): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/${path}`,
    headers: { 'x-intafaced-region': 'DE' },
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('Q-market HTTP — live markets listing pin refuse', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
    if (SAVED === undefined) delete process.env[MARKET_LISTING_PIN_ENV];
    else process.env[MARKET_LISTING_PIN_ENV] = SAVED;
  });

  it('GET /trpc/liveMarkets named-refuses when pin unset — not a 404, not a catalogue', async () => {
    delete process.env[MARKET_LISTING_PIN_ENV];
    const app = await mount();
    apps.push(app);
    const { statusCode, body } = await get(app, 'liveMarkets');
    expect(statusCode).toBe(412);
    expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(body.error?.message).toBe(MARKET_LISTING_PIN_UNSET);
    expect(body.error?.data?.cause?.code).toBe(MARKET_LISTING_PIN_UNSET);
    expect(JSON.stringify(body)).not.toMatch(/BTC|USDT|ETH/i);
    expect(body.result?.data?.markets).toBeUndefined();
  });

  it('GET /trpc/listedAssets is the same named refuse, not a 404', async () => {
    process.env[MARKET_LISTING_PIN_ENV] = ' ';
    const app = await mount();
    apps.push(app);
    const { statusCode, body } = await get(app, 'listedAssets');
    expect(statusCode).toBe(412);
    expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(body.error?.message).toBe(MARKET_LISTING_PIN_UNSET);
    expect(body.error?.data?.cause?.code).toBe(MARKET_LISTING_PIN_UNSET);
  });

  it('pin present still empty catalogue — does not invent the listing set', async () => {
    process.env[MARKET_LISTING_PIN_ENV] = 'owner-stamp';
    const app = await mount();
    apps.push(app);
    const { statusCode, body } = await get(app, 'liveMarkets');
    expect(statusCode).toBe(412);
    expect(body.error?.message).toBe(MARKET_LISTING_SET_UNSET);
    expect(body.error?.data?.cause?.code).toBe(MARKET_LISTING_SET_UNSET);
    expect(JSON.stringify(body)).not.toMatch(/BTC|USDT|ETH/i);
  });
});
