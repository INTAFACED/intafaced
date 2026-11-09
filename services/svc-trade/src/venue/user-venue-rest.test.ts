import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError } from '@intafaced/contracts';
import { startTestVenueServer, type TestVenueTypedData } from '@intafaced/venue-sim';
import { parseAmount } from '@intafaced/ledger-client/money';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';

const USER = { userId: '11111111-1111-4111-8111-1111111111c1', sid: 's-1', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue rest')));
const owner = key.address.toLowerCase();

let app: FastifyInstance;
let server: http.Server;
let url: string;
beforeAll(async () => {
  ({ server, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(door: UserVenueDoor | null) {
  app = Fastify();
  attachUserVenueRoutes(app, door, {
    requirePrincipal: () => USER,
    requireTradeJurisdiction: () => true,
  });
  await app.ready();
  return app;
}

function door(withdrawStepUp: 'approve' | 'required' = 'approve', builder: BuilderFeeValue | null = null) {
  return new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: {
      async require() {
        if (withdrawStepUp === 'required') throw new StepUpCheckError('confirm first', 'identity.step_up_required');
        return { stepUpEventId: 'x', consumedAt: null, replayed: false };
      },
    },
    builder,
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP', 'XAU-PERP'])),
  });
}

describe('/api/v1/venue/*', () => {
  it('off: status is { enabled: false } and every other route refuses trade.user_venue_off', async () => {
    await mount(null);
    expect((await app.inject({ method: 'GET', url: '/api/v1/venue/status' })).json()).toEqual({ enabled: false });
    const res = await app.inject({ method: 'GET', url: `/api/v1/venue/balances?owner=${owner}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().intafacedCode).toBe('trade.user_venue_off');
  });

  it('on: status names the TEST venue and its chain id; prepare → sign → submit → read with decimal strings', async () => {
    await mount(door());
    expect((await app.inject({ method: 'GET', url: '/api/v1/venue/status' })).json()).toMatchObject({
      enabled: true,
      available: true,
      test: true,
      label: 'TEST',
      chainId: 84532,
      builder: null,
    });
    const intent = { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 50_000, marginMode: 'isolated' };
    const prep = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: { owner, signer: { role: 'owner', address: owner }, intent, actionKey: `leverage:${USER.userId}:1` },
    });
    expect(prep.statusCode).toBe(200);
    const prepared = prep.json().prepared;
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const sub = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/submit',
      payload: { actionKey: `leverage:${USER.userId}:1`, signature: { digest: prepared.digest, signature, signedBy: owner } },
    });
    expect(sub.json().outcome).toMatchObject({ definite: true, accepted: true });
    const lev = await app.inject({ method: 'GET', url: `/api/v1/venue/leverage?owner=${owner}&symbol=BTC-PERP` });
    expect(lev.json().value).toEqual({ symbol: 'BTC-PERP', leverageBps: 50_000, marginMode: 'isolated' });
  });

  it('orders refuse builder_fee_not_published (422); a withdrawal without its step-up refuses 403; a money number refuses 400', async () => {
    await mount(door('required'));
    // A spot sell: a spot buy carries no builder fee, so a blank one never refuses it (project-state #1888).
    const order = {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'sell',
      type: 'limit',
      amount: '0.1',
      price: '60000',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${USER.userId}:rest:1`,
      builderFee: null,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: { owner, signer: { role: 'owner', address: owner }, intent: order },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      intafacedCode: 'trade.venue.builder_fee_not_published',
      refusal: { code: 'builder_fee_not_published' },
    });

    const w = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'withdraw', asset: 'USDC', amount: '1', destination: owner, withdrawalKey: `withdraw:${USER.userId}:rest` },
      },
    });
    expect(w.statusCode).toBe(403);
    expect(w.json().intafacedCode).toBe('identity.step_up_required');

    const n = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: { ...order, amount: 0.1 } } });
    expect(n.statusCode).toBe(400);
    // Anything but a decimal string in an Amount field is refused at decode, before the venue is asked.
    for (const amount of [{}, true, null]) {
      const bad = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: { ...order, amount } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().intafacedCode).toBe('trade.venue_request_invalid');
    }
  });

  it("J-derivatives-21: markets carry the venue's listing, rules and feed; a leverage above the cap is trade.venue.leverage_above_cap naming it; a stale feed is trade.venue.feed_stale", async () => {
    // A TEST builder fee, so a perp order is not refused builder_fee_not_published first.
    await mount(door('approve', { address: '0x7e57000000000000000000000000000000000b1d', feeBps: parseAmount('0.5') }));
    const markets = await app.inject({ method: 'GET', url: '/api/v1/venue/markets' });
    expect(markets.statusCode).toBe(200);
    const xau = markets.json().value.find((m: { symbol: string }) => m.symbol === 'XAU-PERP');
    expect(xau).toMatchObject({
      maxLeverageBps: 100_000,
      tickSize: '0.1',
      listedBy: { known: true, value: { kind: 'hip3', name: 'TEST gold deployer' } },
      tradingHours: { known: true, value: '24/7, no close' },
      markRule: { known: true, value: 'The mark price is the oracle price; fills do not move it.' },
      feed: { known: true, value: { state: 'live', staleRule: { known: true } } },
    });
    expect(Number.isNaN(Date.parse(xau.feed.value.lastOracleUpdateAt))).toBe(false);
    expect(markets.json().value.find((m: { symbol: string }) => m.symbol === 'BTC-PERP').oracleRule).toEqual({ known: false });

    const above = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'update_leverage', symbol: 'XAU-PERP', leverageBps: 200_000, marginMode: 'isolated' },
        actionKey: `leverage:${USER.userId}:xau-above`,
      },
    });
    expect(above.statusCode).toBe(422);
    expect(above.json()).toMatchObject({ intafacedCode: 'trade.venue.leverage_above_cap', refusal: { code: 'leverage_above_cap' } });
    expect(above.json().message).toContain('XAU-PERP allows at most 10x');

    // Leverage within the cap, signed, then the feed goes stale: an opening order's preview is the venue's stale rule.
    const intent = { kind: 'update_leverage', symbol: 'XAU-PERP', leverageBps: 50_000, marginMode: 'isolated' };
    const prep = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: { owner, signer: { role: 'owner', address: owner }, intent, actionKey: `leverage:${USER.userId}:xau-5` },
    });
    const prepared = prep.json().prepared;
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    await app.inject({
      method: 'POST',
      url: '/api/v1/venue/submit',
      payload: { actionKey: `leverage:${USER.userId}:xau-5`, signature: { digest: prepared.digest, signature, signedBy: owner } },
    });
    const feed = (state: string) =>
      fetch(`${url}/test/feed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'XAU-PERP', state }),
      });
    expect((await feed('stale')).status).toBe(200);
    try {
      const order = {
        kind: 'place_order',
        symbol: 'XAU-PERP',
        side: 'buy',
        type: 'market',
        amount: '0.5',
        price: '2700',
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${USER.userId}:xau:1`,
        builderFee: null,
      };
      const stale = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: order } });
      expect(stale.statusCode).toBe(422);
      expect(stale.json()).toMatchObject({
        intafacedCode: 'trade.venue.feed_stale',
        message: 'While the oracle is stale the mark holds at the last oracle price and only reduce-only orders are taken.',
      });
    } finally {
      await feed('live');
    }
  });
});
