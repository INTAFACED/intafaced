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
import { UserVenueRouter } from './venue-router.js';

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
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP', 'XAU-PERP', 'XSTK-PERP', 'XSTD-PERP'])),
  });
}

describe('/api/v1/venue/*', () => {
  it('unverified: the best prices refuse with the trade jurisdiction, as the market list does', async () => {
    await mount(door(), 50, false);
    for (const path of ['/api/v1/venue/markets', '/api/v1/venue/best-prices?symbol=BTC-USDC']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(403);
      expect(res.json().intafacedCode).toBe('denied.kyc_required');
    }
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

  it("J-agents-08 #2: sub-accounts lists the owner's own sub-accounts as the venue records them, read on the main account only", async () => {
    await mount(door());
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as T;
    };
    const venueId = ((await (await fetch(`${url}/venue`)).json()) as { venue: { id: string } }).venue.id;
    const main = { venueId, owner, subAccount: null };
    const before = await app.inject({ method: 'GET', url: `/api/v1/venue/sub-accounts?owner=${owner}` });
    expect(before.statusCode).toBe(200);
    const listedBefore = before.json().value as { subAccount: string; name: string }[];
    // The owner's own wallet opens one on the venue directly.
    const name = `TEST rest sub ${listedBefore.length + 1}`;
    const intent = { kind: 'create_sub_account', name, subAccountKey: `test:rest-sub:${listedBefore.length + 1}` };
    const prepared = await post<{ typedData: TestVenueTypedData; digest: string }>('/prepare', {
      account: main,
      signer: { role: 'owner', address: owner },
      intent,
    });
    const t = prepared.typedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    await post('/submit', { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/venue/sub-accounts?owner=${owner}` });
    expect(res.statusCode).toBe(200);
    const venueOwn = (await post<{ value: { subAccount: string; name: string }[] }>('/sub-accounts', { account: main })).value;
    expect(res.json().value).toEqual(venueOwn);
    expect(res.json().value.map((s: { name: string }) => s.name)).toContain(name);
    expect(res.json().value).toHaveLength(listedBefore.length + 1);
    // Asked on a sub-account: refused, never answered with another list.
    const sub = (res.json().value as { subAccount: string }[])[0]!.subAccount;
    const onSub = await app.inject({ method: 'GET', url: `/api/v1/venue/sub-accounts?owner=${owner}&subAccount=${sub}` });
    expect(onSub.statusCode).toBe(400);
    expect(onSub.json().intafacedCode).toBe('trade.venue_request_invalid');
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

  it('funding-history is public: no sign-in or verification; the listed perpetual on the asset, rates as decimal strings', async () => {
    app = Fastify();
    const router = new UserVenueRouter({ doors: [door()], store: new InMemoryPreparedActionStore(), now: () => new Date() });
    attachUserVenueRoutes(app, router, {
      // Signed out: every private route would refuse here; this one never asks.
      requirePrincipal: (_req, reply) => {
        void reply.code(401).send({ code: 'AuthenticationError', message: 'signed out', intafacedCode: 'auth.required' });
        return null;
      },
      requireTradeJurisdiction: () => false,
      slippageCapBps: null,
    });
    await app.ready();
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const res = await app.inject({ method: 'GET', url: `/api/v1/venue/funding-history?base=btc&since=${encodeURIComponent(since)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ symbol: 'BTC-PERP', intervalSeconds: 3600, test: true });
    expect(body.value.length).toBeGreaterThanOrEqual(2);
    for (const row of body.value) {
      expect(row.rate).toBe('0.0000125');
      expect(Date.parse(row.fundingAt) % 3_600_000).toBe(0);
      expect(Date.parse(row.fundingAt)).toBeGreaterThanOrEqual(Date.parse(since));
    }
    // An asset with no listed perpetual, and a bad request, are refused by name; the private routes still refuse.
    const eth = await app.inject({ method: 'GET', url: `/api/v1/venue/funding-history?base=ETH&since=${encodeURIComponent(since)}` });
    expect(eth.statusCode).toBe(422);
    expect(eth.json().intafacedCode).toBe('trade.venue.not_offered');
    expect((await app.inject({ method: 'GET', url: '/api/v1/venue/funding-history?base=BTC' })).json().intafacedCode).toBe(
      'trade.venue_request_invalid',
    );
    expect((await app.inject({ method: 'GET', url: '/api/v1/venue/markets' })).statusCode).toBe(401);
  });

  it('funding-history refuses not_offered on a listed perpetual with no published funding, and when the door is off', async () => {
    await mount(door());
    const since = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
    const gold = await app.inject({ method: 'GET', url: `/api/v1/venue/funding-history?base=XAU&since=${since}` });
    expect(gold.statusCode).toBe(422);
    expect(gold.json().intafacedCode).toBe('trade.venue.not_offered');
    await app.close();
    await mount(null);
    const off = await app.inject({ method: 'GET', url: `/api/v1/venue/funding-history?base=BTC&since=${since}` });
    expect(off.statusCode).toBe(404);
    expect(off.json().intafacedCode).toBe('trade.user_venue_off');
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

  it("J-derivatives-27: a stock perpetual carries the venue's home-market session; off hours an opening market order is trade.venue.market_off_hours in the venue's words", async () => {
    await mount(door('approve', { address: '0x7e57000000000000000000000000000000000b1d', feeBps: parseAmount('0.5') }));
    const read = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/venue/markets' }))
        .json()
        .value.find((m: { symbol: string }) => m.symbol === 'XSTK-PERP');
    expect(await read()).toMatchObject({
      listedBy: { known: true, value: { kind: 'hip3', name: 'TEST stock deployer' } },
      session: { known: true, value: { state: 'open', homeMarket: 'TEST home exchange', offHoursMaxLeverageBps: 20_000, reopensAt: null } },
    });
    const intent = { kind: 'update_leverage', symbol: 'XSTK-PERP', leverageBps: 20_000, marginMode: 'isolated' };
    const prep = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: { owner, signer: { role: 'owner', address: owner }, intent, actionKey: `leverage:${USER.userId}:xstk-2` },
    });
    const prepared = prep.json().prepared;
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    await app.inject({
      method: 'POST',
      url: '/api/v1/venue/submit',
      payload: { actionKey: `leverage:${USER.userId}:xstk-2`, signature: { digest: prepared.digest, signature, signedBy: owner } },
    });
    const session = (state: string) =>
      fetch(`${url}/test/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'XSTK-PERP', state }),
      });
    expect((await session('off_hours')).status).toBe(200);
    try {
      const closed = await read();
      expect(closed.session.value.state).toBe('off_hours');
      expect(Number.isNaN(Date.parse(closed.session.value.reopensAt))).toBe(false);
      const order = {
        kind: 'place_order',
        symbol: 'XSTK-PERP',
        side: 'buy',
        type: 'market',
        amount: '1',
        price: '210',
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${USER.userId}:xstk:1`,
        builderFee: null,
      };
      const refused = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: order } });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        intafacedCode: 'trade.venue.market_off_hours',
        message: closed.session.value.offHoursRule.value,
      });
    } finally {
      await session('open');
    }
  });

  it("J-derivatives-27 #7 #8: a market's own margin account is read on the main account and funded by the owner's signed move; an open past the deployer's open-interest cap is trade.venue.open_interest_above_cap naming it", async () => {
    await mount(door('approve', { address: '0x7e57000000000000000000000000000000000b1d', feeBps: parseAmount('0.5') }));
    const venueId = ((await (await fetch(`${url}/venue`)).json()) as { venue: { id: string } }).venue.id;
    const control = (path: string, body: unknown) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(
      (
        await control('/test/deposit', {
          account: { venueId, owner, subAccount: null },
          asset: 'USDC',
          amount: '200',
          depositRef: 'rest:xstd:1',
        })
      ).status,
    ).toBe(200);
    const market = (await app.inject({ method: 'GET', url: '/api/v1/venue/markets' }))
      .json()
      .value.find((m: { symbol: string }) => m.symbol === 'XSTD-PERP');
    expect(market).toMatchObject({
      listedBy: { known: true, value: { kind: 'hip3' } },
      marginAccount: { known: true, value: { name: 'TEST stock margin deployer margin', collateralAsset: 'USDC', marginMode: 'isolated' } },
      openInterest: { known: true, value: { capSize: '500' } },
    });
    const margin = async () => app.inject({ method: 'GET', url: `/api/v1/venue/market-margin?owner=${owner}&symbol=XSTD-PERP` });
    const before = await margin();
    expect(before.statusCode).toBe(200);
    const free = parseAmount(before.json().value.free);
    // The owner's signed move, stored under its business key.
    const signed = async (intent: Record<string, unknown>, actionKey: string | null) => {
      const prep = await app.inject({
        method: 'POST',
        url: '/api/v1/venue/prepare',
        payload: { owner, signer: { role: 'owner', address: owner }, intent, actionKey },
      });
      expect(prep.statusCode, prep.body).toBe(200);
      const prepared = prep.json().prepared;
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return app.inject({
        method: 'POST',
        url: '/api/v1/venue/submit',
        payload: { actionKey: prep.json().actionKey ?? actionKey, signature: { digest: prepared.digest, signature, signedBy: owner } },
      });
    };
    const moveKey = `market-margin:${owner}:xstd-perp:rest-1`;
    const moved = await signed(
      { kind: 'market_margin_transfer', symbol: 'XSTD-PERP', direction: 'into_market', asset: 'USDC', amount: '150', moveKey },
      null,
    );
    expect(moved.json().outcome).toMatchObject({ definite: true, accepted: true });
    expect(parseAmount((await margin()).json().value.free)).toBe(free + parseAmount('150'));
    // Asked of a market with no margin account of its own: the venue's refusal.
    const none = await app.inject({ method: 'GET', url: `/api/v1/venue/market-margin?owner=${owner}&symbol=XSTK-PERP` });
    expect(none.statusCode).toBe(422);
    expect(none.json().intafacedCode).toBe('trade.venue.not_offered');

    const lev = { kind: 'update_leverage', symbol: 'XSTD-PERP', leverageBps: 20_000, marginMode: 'isolated' };
    expect((await signed(lev, `leverage:${USER.userId}:xstd-2`)).json().outcome).toMatchObject({ accepted: true });
    expect((await control('/test/open-interest-cap', { symbol: 'XSTD-PERP', capSize: '0.1' })).status).toBe(200);
    try {
      const order = {
        kind: 'place_order',
        symbol: 'XSTD-PERP',
        side: 'buy',
        type: 'market',
        amount: '1',
        price: '105',
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${USER.userId}:xstd:1`,
        builderFee: null,
      };
      const refused = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: order } });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ intafacedCode: 'trade.venue.open_interest_above_cap' });
      expect(refused.json().message).toContain('caps its open interest at 0.1 XSTD');
    } finally {
      await control('/test/open-interest-cap', { symbol: 'XSTD-PERP', capSize: '500' });
    }
  });

  it("J-derivatives-27 #9 #10: a deployer's halt is the market's lastEvent with its time and price; settlements are read since a time", async () => {
    await mount(door());
    const control = (path: string, body: unknown) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const since = new Date(Date.now() - 60_000).toISOString();
    const none = await app.inject({ method: 'GET', url: `/api/v1/venue/settlements?owner=${owner}&since=${since}` });
    expect(none.statusCode).toBe(200);
    expect(none.json().value).toEqual([]);
    const noSince = await app.inject({ method: 'GET', url: `/api/v1/venue/settlements?owner=${owner}` });
    expect(noSince.statusCode).toBe(400);
    expect((await control('/test/deployer-halt', { symbol: 'XSTD-PERP' })).status).toBe(200);
    try {
      const market = (await app.inject({ method: 'GET', url: '/api/v1/venue/markets' }))
        .json()
        .value.find((m: { symbol: string }) => m.symbol === 'XSTD-PERP');
      expect(market.status).toBe('halted');
      expect(market.lastEvent).toMatchObject({
        known: true,
        value: { kind: 'deployer_halt', settlementPrice: '100', reopenedAt: null, splitRatio: null },
      });
      expect(Number.isNaN(Date.parse(market.lastEvent.value.eventAt))).toBe(false);
    } finally {
      await control('/test/market-status', { symbol: 'XSTD-PERP', status: 'trading' });
      await control('/test/seed', {});
    }
  });

  it("b2 change 6: each balance figure is the venue's own, with its time and a state: known, stale past the venue's limit, unknown with no time, never zero", async () => {
    await mount(door());
    const test = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return res.json();
    };
    const status = (await app.inject({ method: 'GET', url: '/api/v1/venue/status' })).json();
    const account = { venueId: status.venue.id, owner, subAccount: null };
    await test('/test/deposit', { account, asset: 'USDC', amount: '12.5', depositRef: `84532:0x${'f'.repeat(64)}:6` });
    const balances = async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/venue/balances?owner=${owner}` });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      const body = res.json();
      return { body, usdc: body.figures.find((f: { asset: string }) => f.asset === 'USDC') };
    };
    try {
      const live = await balances();
      const raw = live.body.value.find((b: { asset: string }) => b.asset === 'USDC');
      // Known: the venue's own string, its name, its own time, and the limit it declares.
      expect(live.usdc.total).toEqual({
        state: 'known',
        source: status.venue.displayName,
        amount: raw.total,
        asOf: live.body.reportedAt,
        staleAfterMs: 60_000,
        reason: null,
      });
      expect(live.body.reportedAt).toBe(live.body.asOf);
      expect(live.usdc.free).toMatchObject({ state: 'known', amount: raw.free });
      expect(live.usdc.locked).toMatchObject({ state: 'known', amount: raw.locked });

      // Stale: the venue's time is older than its limit; the figure still shows, said to be old.
      await test('/test/account-switches', { owner, figures: 'stale' });
      const stale = await balances();
      expect(Date.parse(stale.body.asOf) - Date.parse(stale.body.reportedAt)).toBeGreaterThan(60_000);
      expect(stale.usdc.total).toMatchObject({ state: 'stale', amount: raw.total, asOf: stale.body.reportedAt, reason: null });

      // Unknown: the venue sent no time, so no figure is known at our read time, and none reads as zero.
      await test('/test/account-switches', { owner, figures: 'unknown' });
      const unknown = await balances();
      expect(unknown.body.reportedAt).toBeNull();
      for (const k of ['free', 'locked', 'total'])
        expect(unknown.usdc[k], k).toEqual({
          state: 'unknown',
          source: status.venue.displayName,
          amount: null,
          asOf: null,
          staleAfterMs: 60_000,
          reason: 'no_as_of',
        });

      // Positions carry the same contract (none open here, so no figures).
      const positions = (await app.inject({ method: 'GET', url: `/api/v1/venue/positions?owner=${owner}` })).json();
      expect(positions).toMatchObject({ value: [], figures: [], reportedAt: null });
    } finally {
      await test('/test/account-switches', { owner, figures: 'live' });
    }
    const odd = await fetch(`${url}/test/account-switches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner, figures: 'odd' }),
    });
    expect(odd.status).toBe(400);
    expect(await odd.text()).toContain("figures is 'live', 'stale' or 'unknown'");
  });
});
