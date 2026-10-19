import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { fakeMarket } from '../public-rest.js';
import { bindExpireAt } from './gtd-gtt-place.js';
import { bindReduceOnly } from './reduce-only-place.js';
import { bindPostOnly } from './post-only-place.js';
import { bindIoc } from './ioc-place.js';
import { bindFok } from './fok-place.js';
import { bindStopLimit } from './stop-limit-place.js';
import { bindMinQty } from './min-qty-place.js';
import { bindAon } from './aon-place.js';
import { bindPeg } from './peg-place.js';
import { bindAuction } from './auction-place.js';
import { bindCollar } from './collar-place.js';
import { bindIceberg } from './iceberg-place.js';
import { bindTrailingStop } from './trailing-stop-place.js';
import { bindOption } from './option-place.js';
import { bindCombo } from './combo-place.js';
import { bindBracket } from './bracket-place.js';
import { bindOco } from './oco-place.js';
import { carryPlacementBody } from './placement-extras.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * A placement option reaches an order only from the request that carries it and only for the caller who sent it.
 * A request that never reaches placement (no sign-in, a refused body) leaves nothing behind for a later order that
 * reuses the same client order id. Bots reuse and guess client ids, and a retry reuses the id of a refused request.
 */

const SECRET = 'a-trade-placement-extras-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId: string): Record<string, string> {
  const raw = encodePrincipal(principal(userId));
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

const unsigned = { 'content-type': 'application/json' };

const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });
const PLAIN = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', price: '100' };

const BINDERS: Array<(input: PlaceOrderInput) => PlaceOrderInput> = [
  bindExpireAt,
  bindReduceOnly,
  bindPostOnly,
  bindIoc,
  bindFok,
  bindStopLimit,
  bindMinQty,
  bindAon,
  bindPeg,
  bindAuction,
  bindCollar,
];

/** The service wiring, as `index.ts` mounts it: the bind chain in front of `placeOrder`. */
async function build(seen: PlaceOrderInput[]) {
  const app = Fastify();
  const deps = {
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (symbol: string) => (symbol === 'BTC/USDT' ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
    placeOrder: async (_p: Principal, input: PlaceOrderInput) => {
      seen.push(BINDERS.reduce<PlaceOrderInput>((acc, bind) => bind(acc), input));
      return fakeOrder({ marketId: market.id });
    },
  } as unknown as PrivateRestDeps;
  registerPrivateRest(app, deps);
  await app.ready();
  return app;
}

const OPTIONS: Array<[string, Record<string, unknown>]> = [
  ['immediate-or-cancel', { timeInForce: 'IOC' }],
  ['fill-or-kill', { timeInForce: 'FOK' }],
  ['post-only', { postOnly: true }],
  ['reduce-only', { reduceOnly: true }],
  ['expiry', { expireAt: '2030-01-01T00:00:00.000Z' }],
  ['stop price', { stopPx: '90' }],
  ['minimum quantity', { minQty: '0.5' }],
  ['all-or-none', { aon: true }],
  ['peg', { peg: true }],
  ['auction', { auction: true }],
  ['collar', { collar: true, min: '90', max: '110' }],
];

const OWN: Array<[string, Record<string, unknown>, (input: Record<string, unknown>) => unknown]> = [
  ['immediate-or-cancel', { timeInForce: 'IOC' }, (i) => i.tif === 'IOC'],
  ['fill-or-kill', { timeInForce: 'FOK' }, (i) => i.tif === 'FOK'],
  ['post-only', { postOnly: true }, (i) => i.tif === 'PO'],
  ['reduce-only', { reduceOnly: true }, (i) => i.reduceOnly === true],
  ['expiry', { expireAt: '2030-01-01T00:00:00.000Z' }, (i) => i.expireAt === '2030-01-01T00:00:00.000Z'],
  ['stop price', { stopPx: '90' }, (i) => i.stopPx === 90n * 10n ** 18n],
  ['minimum quantity', { minQty: '0.5' }, (i) => i.minQty === 5n * 10n ** 17n],
  ['all-or-none', { aon: true }, (i) => i.aon === true],
  ['peg', { peg: true }, (i) => i.peg === true],
  ['auction', { auction: true }, (i) => i.auction === true],
  [
    'collar',
    { collar: true, min: '90', max: '110' },
    (i) => i.collar === true && i.min === 90n * 10n ** 18n && i.max === 110n * 10n ** 18n,
  ],
];

describe('a request keeps its own placement options', () => {
  it.each(OWN)('%s reaches the order it was sent with', async (_name, extra, carried) => {
    const seen: PlaceOrderInput[] = [];
    const app = await build(seen);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(BOB),
      payload: { ...PLAIN, ...extra, clientOrderId: 'bot-7' },
    });
    expect(res.statusCode).toBe(201);
    expect(carried(seen[0] as unknown as Record<string, unknown>)).toBe(true);
    await app.close();
  });
});

describe('placement options stay with the request that carried them', () => {
  async function baseline(): Promise<PlaceOrderInput> {
    const seen: PlaceOrderInput[] = [];
    const app = await build(seen);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(BOB),
      payload: { ...PLAIN, clientOrderId: 'bot-7' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
    return seen[0]!;
  }

  it.each(OPTIONS)('a signed-out request carrying %s does not change a later order with the same client id', async (_name, extra) => {
    const clean = await baseline();
    const seen: PlaceOrderInput[] = [];
    const app = await build(seen);
    const poison = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: unsigned,
      payload: { ...PLAIN, ...extra, clientOrderId: 'bot-7' },
    });
    expect(poison.statusCode).toBe(401);
    const victim = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(BOB),
      payload: { ...PLAIN, clientOrderId: 'bot-7' },
    });
    expect(victim.statusCode).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(clean);
    await app.close();
  });

  it.each(OPTIONS)('a refused request carrying %s does not change the corrected retry', async (_name, extra) => {
    const clean = await baseline();
    const seen: PlaceOrderInput[] = [];
    const app = await build(seen);
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(BOB),
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', ...extra, clientOrderId: 'bot-7' },
    });
    expect(refused.statusCode).toBe(400);
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(BOB),
      payload: { ...PLAIN, clientOrderId: 'bot-7' },
    });
    expect(retry.statusCode).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(clean);
    await app.close();
  });

  it('two callers with the same client id never share an option', async () => {
    const clean = await baseline();
    const seen: PlaceOrderInput[] = [];
    const app = await build(seen);
    const alice = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(ALICE),
      payload: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '1', timeInForce: 'IOC', clientOrderId: 'bot-7' },
    });
    expect(alice.statusCode).toBe(400);
    const bob = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(BOB),
      payload: { ...PLAIN, clientOrderId: 'bot-7' },
    });
    expect(bob.statusCode).toBe(201);
    expect(seen[0]).toEqual(clean);
    await app.close();
  });
});

describe('an input that did not come from a request body carries no options', () => {
  const plain = { clientOrderId: 'bot-7', side: 'buy', type: 'limit', price: 100n, qty: 1n } as PlaceOrderInput;
  const ALL = [
    bindExpireAt,
    bindReduceOnly,
    bindPostOnly,
    bindIoc,
    bindFok,
    bindStopLimit,
    bindMinQty,
    bindAon,
    bindPeg,
    bindAuction,
    bindCollar,
    bindIceberg,
    bindTrailingStop,
    bindOption,
    bindCombo,
    bindBracket,
    bindOco,
  ];
  it('every binder returns it unchanged, so nothing is ever read from shared state', () => {
    for (const bind of ALL) expect(bind(plain)).toEqual(plain);
  });

  it('a JSON-number trail is not a decimal distance', () => {
    const bound = bindTrailingStop(carryPlacementBody(plain, { clientOrderId: 'bot-7', trail: 0.1, mark: '10' })) as {
      trail?: bigint | null;
    };
    expect(bound.trail ?? null).toBeNull();
  });
});
