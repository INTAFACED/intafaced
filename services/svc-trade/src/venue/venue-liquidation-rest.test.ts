import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import type { UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { VENUE_ADL_VERSION_STALE, attachUserVenueRoutes } from './user-venue-rest.js';
import { UserVenueRouter } from './venue-router.js';
import { memoryVenueAdlAcks, type VenueAdlAcks } from './venue-adl-acks.js';

/**
 * J-derivatives-07 through svc-trade's venue door: a liquidation's state, parts and fee, the venue's insurance fund, its
 * auto-deleveraging rules with the person's acknowledged version, the person's deleveragings, and the public alerts, each
 * the TEST venue's own figure passed through, never computed here. Every figure is TEST.
 */

const USER = { userId: '11111111-1111-4111-8111-1111111111d7', sid: 's-7', scopes: ['trade:read', 'trade:write'] } as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue liquidation rest')));
const owner = key.address.toLowerCase();
const maker = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue liquidation maker')));
const bidder = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue liquidation bidder')));

let app: FastifyInstance;
let server: http.Server;
let url: string;
let sim: TestVenueSimulator;
beforeAll(async () => {
  ({ server, url, sim } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
afterEach(async () => app?.close());

async function mount(acks: VenueAdlAcks | null = memoryVenueAdlAcks()) {
  app = Fastify();
  const door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: {
      async require() {
        return { stepUpEventId: 'x', consumedAt: null, replayed: false };
      },
    },
    builder: null,
    slippageCapBps: null,
    spreadLimitBps: 100,
    now: () => new Date(),
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-PERP', 'XLIQ-PERP'])),
  });
  const router = new UserVenueRouter({ doors: [door], store: new InMemoryPreparedActionStore(), now: () => new Date() });
  attachUserVenueRoutes(app, router, {
    requirePrincipal: () => USER,
    requireTradeJurisdiction: () => true,
    venueAdlAcks: acks,
  });
  await app.ready();
  return app;
}

async function signed(who: typeof key, intent: VenueIntent) {
  const account: UserVenueAccount = { venueId: sim.venue.id, owner: who.address.toLowerCase(), subAccount: null };
  const prepared = await sim.prepare(account, { role: 'owner', address: account.owner }, intent);
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await who.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const out = await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: account.owner });
  expect(
    out,
    JSON.stringify(out, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
  ).toMatchObject({ definite: true, accepted: true });
}

const order = (side: 'buy' | 'sell', amount: string, price: string, clientOrderKey: string, tif: 'GTC' | 'IOC'): VenueIntent => ({
  kind: 'place_order',
  symbol: 'XLIQ-PERP',
  side,
  type: 'limit',
  amount: parseAmount(amount),
  price: parseAmount(price),
  timeInForce: tif,
  reduceOnly: false,
  clientOrderKey,
  builderFee: null,
});
const get = async (path: string) => app.inject({ method: 'GET', url: path });

describe('J-derivatives-07 through the venue door', () => {
  it('#1 #2 #3 the liquidation state, its parts with price, size, fee and the venue ids, and the venue rules, as the venue reports them', async () => {
    await mount();
    const account = { venueId: sim.venue.id, owner, subAccount: null };
    const makerAccount = { venueId: sim.venue.id, owner: maker.address.toLowerCase(), subAccount: null };
    sim.deposit(account, 'USDC', parseAmount('100'), 'chain:jd07-rest:person');
    sim.deposit(makerAccount, 'USDC', parseAmount('10000'), 'chain:jd07-rest:maker');
    const leverage: VenueIntent = { kind: 'update_leverage', symbol: 'XLIQ-PERP', leverageBps: 100_000, marginMode: 'isolated' };
    await signed(maker, leverage);
    await signed(key, leverage);
    await signed(maker, order('sell', '1', '100.1', 'maker:jd07-rest:ask', 'GTC'));
    await signed(key, order('buy', '1', '100.1', 'order:jd07-rest:open', 'IOC'));

    const none = await get(`/api/v1/venue/liquidation?owner=${owner}&symbol=XLIQ-PERP`);
    expect(none.statusCode).toBe(200);
    expect(none.json().value).toMatchObject({ symbol: 'XLIQ-PERP', state: 'none', liquidationId: null });
    expect(none.json().value.priceRule).toContain('closes half the position at the mark');

    sim.setMark('XLIQ-PERP', parseAmount('92'));
    const live = (await get(`/api/v1/venue/liquidation?owner=${owner}&symbol=XLIQ-PERP`)).json().value;
    expect(live).toMatchObject({ state: 'in_progress' });
    // A change the venue refuses meanwhile answers its reason, as the venue wrote it.
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'update_isolated_margin', symbol: 'XLIQ-PERP', direction: 'add', amount: '1', changeKey: 'margin:jd07-rest:add:1' },
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toContain(`XLIQ-PERP is being liquidated (${live.liquidationId})`);

    sim.setMark('XLIQ-PERP', parseAmount('91'));
    const list = (await get(`/api/v1/venue/liquidations?owner=${owner}`)).json().value;
    const mine = list.find((l: { liquidationId: string }) => l.liquidationId === live.liquidationId);
    expect(mine).toMatchObject({ symbol: 'XLIQ-PERP', side: 'long', state: 'done' });
    // Every figure a decimal string, every part the venue's own id.
    expect(mine.parts.map((p: Record<string, string>) => [p.partId, p.size, p.price, p.fee, p.feeAsset])).toEqual([
      [`${live.liquidationId}-1`, '0.5', '92', '0.46', 'USDC'],
      [`${live.liquidationId}-2`, '0.5', '91', '0.455', 'USDC'],
    ]);
    expect((await get(`/api/v1/venue/liquidation?owner=${owner}&symbol=XLIQ-PERP`)).json().value.state).toBe('done');
    expect((await get(`/api/v1/venue/liquidations?owner=${owner}&since=nope`)).statusCode).toBe(400);
  });

  it('#4 the insurance fund is public and the venue own; one it does not publish reads known: false, never 0', async () => {
    await mount();
    const fund = (await get('/api/v1/venue/insurance-fund')).json();
    expect(fund.value).toMatchObject({ known: true, value: { name: 'TEST venue insurance fund', asset: 'USDC' } });
    expect(fund.value.value.balance).toMatch(/^\d+(\.\d+)?$/);
    expect(fund.venueName).toBe(sim.venue.displayName);
    sim.setInsuranceFundPublished(false);
    try {
      expect((await get('/api/v1/venue/insurance-fund')).json().value).toEqual({ known: false });
    } finally {
      sim.setInsuranceFundPublished(true);
    }
  });

  it('#5 "I have read this" stores the version read; a stale version is refused and a new venue version is not acknowledged', async () => {
    await mount();
    const first = (await get('/api/v1/venue/adl-disclosure')).json();
    expect(first).toMatchObject({ acknowledged: false, acknowledgedVersion: null, rules: { version: 'TEST-adl-1' } });
    const ack = await app.inject({ method: 'POST', url: '/api/v1/venue/adl-disclosure/ack', payload: { version: 'TEST-adl-1' } });
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toMatchObject({ acknowledged: true, acknowledgedVersion: 'TEST-adl-1' });
    sim.setAdlRules({ version: 'TEST-adl-2', text: 'TEST rule: new words.' });
    try {
      // The venue's new version: the stored one no longer satisfies, and acknowledging the old one is refused.
      expect((await get('/api/v1/venue/adl-disclosure')).json()).toMatchObject({
        acknowledged: false,
        acknowledgedVersion: 'TEST-adl-1',
        rules: { version: 'TEST-adl-2' },
      });
      const stale = await app.inject({ method: 'POST', url: '/api/v1/venue/adl-disclosure/ack', payload: { version: 'TEST-adl-1' } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().intafacedCode).toBe(VENUE_ADL_VERSION_STALE);
      const now = await app.inject({ method: 'POST', url: '/api/v1/venue/adl-disclosure/ack', payload: { version: 'TEST-adl-2' } });
      expect(now.json()).toMatchObject({ acknowledged: true, acknowledgedVersion: 'TEST-adl-2' });
    } finally {
      sim.setAdlRules({ version: 'TEST-adl-1', text: (await sim.adlRules()).value?.text ?? 'TEST' });
    }
    await mount(null);
    expect((await get('/api/v1/venue/adl-disclosure')).json().intafacedCode).toBe('trade.venue_adl_acks_unmounted');
  });

  it('#6 #7 a deleveraging with its notice; the public alerts carry no account and only markets we list', async () => {
    await mount();
    const account = { venueId: sim.venue.id, owner, subAccount: null };
    const bidderAccount = { venueId: sim.venue.id, owner: bidder.address.toLowerCase(), subAccount: null };
    sim.deposit(bidderAccount, 'USDC', parseAmount('10000'), 'chain:jd07-rest:bidder');
    await signed(bidder, { kind: 'update_leverage', symbol: 'XLIQ-PERP', leverageBps: 100_000, marginMode: 'isolated' });
    await signed(bidder, order('buy', '1', '99.9', 'maker:jd07-rest:bid', 'GTC'));
    sim.setMark('XLIQ-PERP', parseAmount('100'));
    await signed(key, order('sell', '1', '99.9', 'order:jd07-rest:short', 'IOC'));
    const d = sim.deleverage(account, 'XLIQ-PERP', parseAmount('95'));
    const list = (await get(`/api/v1/venue/deleverages?owner=${owner}`)).json().value;
    expect(list.at(-1)).toMatchObject({ adlId: d.adlId, side: 'short', size: '1', price: '95', notice: d.notice });
    const alerts = await get('/api/v1/venue/liquidation-alerts?symbol=XLIQ-PERP&limit=5');
    expect(alerts.statusCode).toBe(200);
    expect(alerts.json().value[0]).toEqual({
      kind: 'deleverage',
      symbol: 'XLIQ-PERP',
      side: 'short',
      size: '1',
      price: '95',
      alertedAt: expect.any(String),
    });
    expect(alerts.body).not.toContain(owner);
    expect((await get('/api/v1/venue/liquidation-alerts?symbol=ETH-PERP')).statusCode).toBe(422);
  });
});
