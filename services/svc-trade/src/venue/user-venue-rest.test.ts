import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError } from '@intafaced/contracts';
import { startTestVenueServer, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
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

function door(withdrawStepUp: 'approve' | 'required' = 'approve') {
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
    now: () => new Date(),
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
    const order = {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
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
