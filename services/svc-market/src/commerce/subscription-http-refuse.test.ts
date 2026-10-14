/**
 * Q-market HTTP door: recurring subscribe is named-refused on the wire.
 * createCaller is not HTTP — this mounts Fastify + /trpc like index.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { createMarketRouter, type MarketRouter } from '../router.js';
import type { VendorService } from '../vendor-service.js';

const SECRET = 'market-q-recurring-http-refuse-edge-secret-32';
const LISTING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-market' });

type WireBody = {
  error?: {
    message?: string;
    data?: { code?: string; httpStatus?: number; cause?: { code?: string } };
  };
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

function stubCommerce() {
  return {
    programme: vi.fn(() => ({ commissionBps: 500, commissionConfigured: true })),
    createListing: vi.fn(),
    archiveListing: vi.fn(),
    myListings: vi.fn(),
    publicListings: vi.fn(),
    purchase: vi.fn(),
    purchasesOf: vi.fn(),
    cancelSubscription: vi.fn(),
    subscriptionAccess: vi.fn(),
    subscribe: vi.fn(),
  };
}

async function mount(commerce = stubCommerce()): Promise<{ app: FastifyInstance; commerce: ReturnType<typeof stubCommerce> }> {
  const app = Fastify({ logger: false });
  const router = createMarketRouter(stubVendors(), commerce as never);
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<MarketRouter>['trpcOptions'],
  });
  await app.ready();
  return { app, commerce };
}

async function post(
  app: FastifyInstance,
  path: string,
  payload: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', 'x-intafaced-region': 'DE' },
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

describe('Q-market HTTP — recurring subscribe refuse', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('POST /trpc/subscribe named-refuses and never purchases', async () => {
    const { app, commerce } = await mount();
    apps.push(app);
    const { statusCode, body } = await post(app, 'subscribe', { listingId: LISTING });
    expect(statusCode).toBe(412);
    expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(body.error?.message).toBe('market.subscription_recurring_not_built');
    expect(body.error?.data?.cause?.code).toBe('market.subscription_recurring_not_built');
    expect(commerce.purchase).not.toHaveBeenCalled();
    expect(commerce.subscribe).not.toHaveBeenCalled();
  });

  it('POST /trpc/recurring is the same named refuse, not a 404', async () => {
    const { app, commerce } = await mount();
    apps.push(app);
    const { statusCode, body } = await post(app, 'recurring', { listingId: LISTING });
    expect(statusCode).toBe(412);
    expect(body.error?.data?.code).toBe('PRECONDITION_FAILED');
    expect(body.error?.message).toBe('market.subscription_recurring_not_built');
    expect(commerce.purchase).not.toHaveBeenCalled();
  });
});
