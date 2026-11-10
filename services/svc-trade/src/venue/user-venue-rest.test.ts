import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError } from '@intafaced/contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';

const USER = { userId: '11111111-1111-4111-8111-1111111111c1', sid: 's-1', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue rest')));
const owner = key.address.toLowerCase();

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(door: UserVenueDoor | null, slippageCapBps: number | null = null, verified = true) {
  app = Fastify();
  // One door behind the router, as a deployment with one venue has it.
  const router = door ? new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() }) : null;
  attachUserVenueRoutes(app, router, {
    requirePrincipal: () => USER,
    // Unverified: the trade jurisdiction refuses as private-rest's does (denied.kyc_required, 403).
    requireTradeJurisdiction: (_req, reply) => {
      if (verified) return true;
      void reply.code(403).send({ code: 'PermissionDenied', message: 'TEST not verified', intafacedCode: 'denied.kyc_required' });
      return false;
    },
    slippageCapBps,
  });
  await app.ready();
  return app;
}

function door(withdrawStepUp: 'approve' | 'required' = 'approve', slippageCapBps: number | null = null) {
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
    builder: null,
    slippageCapBps,
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
  });
}

describe('/api/v1/venue/*', () => {
  it('unverified: every route but status refuses with the trade jurisdiction, market data included', async () => {
    await mount(door(), 50, false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/venue/status' })).statusCode).toBe(200);
    for (const path of ['/api/v1/venue/markets', '/api/v1/venue/best-prices?symbol=BTC-USDC']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(403);
      expect(res.json().intafacedCode).toBe('denied.kyc_required');
    }
    const balances = await app.inject({ method: 'GET', url: `/api/v1/venue/balances?owner=${owner}` });
    expect(balances.statusCode).toBe(403);
    expect(balances.json().intafacedCode).toBe('denied.kyc_required');
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/preview',
      payload: { owner, intent: { kind: 'place_order', symbol: 'BTC-USDC', side: 'buy', type: 'limit', size: '0.001', price: '1000' } },
    });
    expect(preview.statusCode).toBe(403);
    expect(preview.json().intafacedCode).toBe('denied.kyc_required');
  });

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

  it("best-prices answers the venue's best bid and ask as decimal strings, and refuses without a symbol", async () => {
    await mount(door());
    const res = await app.inject({ method: 'GET', url: '/api/v1/venue/best-prices?symbol=BTC-USDC' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value.symbol).toBe('BTC-USDC');
    for (const side of [body.value.bid, body.value.ask]) expect(side === null || typeof side === 'string').toBe(true);
    expect(typeof body.asOf).toBe('string');
    expect((await app.inject({ method: 'GET', url: '/api/v1/venue/best-prices' })).statusCode).toBe(400);
    // The owner's price protection is blank here: not known, never a default.
    expect(body.slippageCapBps).toEqual({ known: false });
  });

  it('a market buy is bounded over the wire: the best ask reaches the price protection as an Amount, not a string', async () => {
    // Another TEST trader rests an ask on the venue itself, so the book has the side a market buy meets.
    const maker = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue rest maker')));
    const account = { venueId: sim.venue.id, owner: maker.address.toLowerCase(), subAccount: null };
    sim.deposit(account, 'BTC', parseAmount('1'), 'chain:rest-maker:1');
    const ask = {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'sell',
      type: 'limit',
      amount: parseAmount('0.1'),
      price: parseAmount('60000'),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: 'order:rest-maker:1',
      builderFee: null,
    } as const;
    const prepared = await sim.prepare(account, { role: 'owner', address: account.owner }, ask);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await maker.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    expect(await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: account.owner })).toMatchObject({ accepted: true });

    await mount(door('approve', 50), 50);
    const buy = (worst: string) => ({
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'market',
      amount: '0.01',
      price: worst,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${USER.userId}:rest:market`,
      builderFee: null,
    });
    // 50 bps over the 60000 ask is 60300: at the bound the preview answers; past it, the typed refusal.
    const inside = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: buy('60300') } });
    expect(inside.statusCode, inside.body).toBe(200);
    const outside = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: buy('60301') } });
    expect(outside.statusCode, outside.body).toBe(422);
    expect(outside.json().intafacedCode).toBe('trade.venue.price_outside_protection');
  });

  it("best-prices carries the owner's market price protection as svc-trade holds it", async () => {
    await mount(door(), 150);
    const res = await app.inject({ method: 'GET', url: '/api/v1/venue/best-prices?symbol=BTC-USDC' });
    expect(res.statusCode).toBe(200);
    expect(res.json().slippageCapBps).toEqual({ known: true, value: '150' });
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
});
