import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';
import { InMemoryBuilderFeeStore } from '../builder-fee/builder-fee-store.js';
import { parseVenueEligibilityLevel, type VenueEligibilityLevel } from './venue-eligibility.js';

/**
 * J-derivatives-12 through svc-trade's venue door: the perpetuals an account is eligible for under the owner's level (#5;
 * blank refuses every new position and empties the list with the reason), and the person's own builder fees with the
 * ledger transaction each posted (#4), read by their user id only. Every figure is TEST.
 */

const USER = {
  userId: '11111111-1111-4111-8111-1111111111c2',
  sid: 's-12',
  tier: 'basic',
  scopes: ['trade:read', 'trade:write'],
} as unknown as Principal;
const OTHER_USER = '22222222-2222-4222-8222-2222222222c2';
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade account reads')));
const owner = key.address.toLowerCase();
const SYMBOL = 'XBIL-PERP';
const BUILDER = '0x116d8f7751e72306d499dd61ae826e46a726c632';

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  await seedTestVenue(sim);
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(level: VenueEligibilityLevel | null, fees: InMemoryBuilderFeeStore | null = null) {
  app = Fastify();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: { address: BUILDER, feeBps: parseAmount('0.5') },
    slippageCapBps: null,
    spreadLimitBps: 100,
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', SYMBOL])),
    eligibility: { level },
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  attachUserVenueRoutes(app, router, {
    requirePrincipal: () => USER,
    requireTradeJurisdiction: () => true,
    slippageCapBps: null,
    builderFeesOf: fees ? (userId, account, since) => fees.ofUser(userId, account, since) : null,
  });
  await app.ready();
  return app;
}

const get = async (path: string) => app.inject({ method: 'GET', url: path });
const open = (reduceOnly: boolean) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/venue/prepare',
    payload: {
      owner,
      signer: { role: 'owner', address: owner },
      intent: {
        kind: 'place_order',
        symbol: SYMBOL,
        side: 'buy',
        type: 'limit',
        amount: '0.1',
        price: '100.1',
        timeInForce: 'IOC',
        reduceOnly,
        clientOrderKey: `order:jd12-rest:${reduceOnly ? 'close' : 'open'}:${Date.now()}`,
        builderFee: null,
      },
    },
  });

describe('the owner value TRADE_USER_VENUE_ELIGIBILITY_LEVEL', () => {
  it('is blank, a level, or refused at boot', () => {
    expect(parseVenueEligibilityLevel('')).toBeNull();
    expect(parseVenueEligibilityLevel(' full ')).toBe('full');
    expect(() => parseVenueEligibilityLevel('none')).toThrow(/must be blank or one of basic, full, institutional/);
  });
});

describe('/api/v1/venue eligible instruments (J-derivatives-12 #5)', () => {
  it('lists every perpetual we show with its settle asset when the account meets the level', async () => {
    await mount('basic');
    const res = await get('/api/v1/venue/eligible-instruments');
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toEqual({
      level: 'basic',
      reason: null,
      instruments: [{ symbol: SYMBOL, settleAsset: 'USDC', maxLeverageBps: 100_000 }],
    });
  });

  it('a blank level: the list is empty with the reason, the gated list names it, and a new position refuses before anything is stored', async () => {
    await mount(null);
    const res = (await get('/api/v1/venue/eligible-instruments')).json().value;
    expect(res).toMatchObject({ level: null, instruments: [], reason: { code: 'trade.venue_eligibility_level_unset' } });
    const gated = (await get('/api/v1/venue/gated-list')).json().value;
    expect(gated.find((c: { symbol: string }) => c.symbol === SYMBOL)).toMatchObject({
      open: false,
      code: 'trade.venue_eligibility_level_unset',
    });
    const refused = await open(false);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().intafacedCode).toBe('trade.venue_eligibility_level_unset');
    // A reduce-only order only takes risk off: the level does not stop it (it goes on to the venue's own checks).
    expect((await open(true)).json().intafacedCode).not.toBe('trade.venue_eligibility_level_unset');
  });

  it('an account below the level: empty, with the reason; a new position refuses 403', async () => {
    await mount('full');
    expect((await get('/api/v1/venue/eligible-instruments')).json().value).toMatchObject({
      level: 'full',
      instruments: [],
      reason: { code: 'trade.venue_eligibility_level_insufficient' },
    });
    const refused = await open(false);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().intafacedCode).toBe('trade.venue_eligibility_level_insufficient');
  });
});

describe('/api/v1/venue/builder-fees (J-derivatives-12 #4)', () => {
  it("answers the caller's own builder fees on the account with each ledger transaction, never another person's", async () => {
    const fees = new InMemoryBuilderFeeStore();
    const venueId = sim.venue.id;
    const account = { venueId, owner, subAccount: null };
    const at = new Date();
    const row = (fillId: string, userId: string, ledgerTxId: string | null) => ({
      venueId,
      fillId,
      userId,
      account,
      assetId: 'USDC',
      amount: parseAmount('0.0005'),
      filledAt: at,
      status: ledgerTxId ? ('posted' as const) : ('refused' as const),
      refusalCode: ledgerTxId ? null : 'ledger.asset_unknown',
      ledgerTxId,
    });
    await fees.record(row('fill-1', USER.userId, 'tx-1'), at);
    await fees.record(row('fill-2', USER.userId, null), at);
    await fees.record(row('fill-3', OTHER_USER, 'tx-3'), at);
    await mount('basic', fees);
    const since = new Date(at.getTime() - 60_000).toISOString();
    const res = await get(`/api/v1/venue/builder-fees?owner=${owner}&since=${since}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toEqual([
      expect.objectContaining({ fillId: 'fill-1', amount: '0.0005', asset: 'USDC', status: 'posted', ledgerTxId: 'tx-1' }),
      expect.objectContaining({ fillId: 'fill-2', status: 'refused', refusalCode: 'ledger.asset_unknown', ledgerTxId: null }),
    ]);
    expect((await get(`/api/v1/venue/builder-fees?owner=${owner}`)).statusCode).toBe(400);
  });

  it('answers 503 by name when the records are not mounted', async () => {
    await mount('basic');
    const res = await get(`/api/v1/venue/builder-fees?owner=${owner}&since=${new Date().toISOString()}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().intafacedCode).toBe('trade.venue_builder_fees_unmounted');
  });
});
