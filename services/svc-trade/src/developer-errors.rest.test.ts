import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { LedgerError, MemoryLedger, parseAmount, recipes, type PostRequest, type LedgerTx } from '@intafaced/ledger-client';
import { fakeOrder, registerPrivateRest, type PrivateRestDeps } from './private-rest.js';
import { fakeMarket } from './public-rest.js';
import type { PlaceOrderInput } from './spot/trade-service.js';

/**
 * The developer-facing error bodies of the order door (DV-errors-01, DV-errors-02; J-developer-04 #3 and #6):
 * a create body with several bad fields is refused in ONE 400 that lists each field, and a money call during the
 * platform posting freeze is refused `posting_frozen` while a read still answers.
 */

const SECRET = 'a-trade-developer-errors-edge-secret-long-xxxxx';
const ALICE = '11111111-1111-4111-8111-111111111111';
const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });

function signed(scopes = ['trade:read', 'trade:write']): Record<string, string> {
  const p = {
    sub: ALICE,
    userId: ALICE,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

/** The ledger with svc-ledger's platform posting freeze: while it is on every post refuses `ledger.frozen`; reads answer. */
class FreezableLedger extends MemoryLedger {
  frozen = false;
  override async post(request: PostRequest): Promise<LedgerTx> {
    if (this.frozen) throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
    return super.post(request);
  }
}

async function build() {
  const ledger = new FreezableLedger();
  await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: 'alice:usdt' }));
  const placed: PlaceOrderInput[] = [];
  const app = Fastify();
  registerPrivateRest(app, {
    findClientOrder: async () => null,
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (s: string) => (s === 'BTC/USDT' ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
    userBalances: (userId: string) => ledger.balances('user', userId),
    // The place door's step 3: the hold goes to the ledger before anything else, as TradeService does.
    placeOrder: async (_p: Principal, input: PlaceOrderInput) => {
      const orderId = `o-${input.clientOrderId}`;
      await ledger.post(recipes.orderHold({ orderId, userId: ALICE, assetId: 'USDT', amount: parseAmount('0.001') }));
      placed.push(input);
      return fakeOrder({ id: orderId, marketId: market.id, clientOrderId: input.clientOrderId, side: input.side, type: 'limit' });
    },
  } as unknown as PrivateRestDeps);
  await app.ready();
  return { app, ledger, placed };
}

const order = (clientOrderId: string, extra: Record<string, unknown> = {}) => ({
  symbol: 'BTC/USDT',
  type: 'limit',
  side: 'buy',
  amount: '0.001',
  price: '1',
  clientOrderId,
  ...extra,
});

describe('J-developer-04 #3: one typed 400 lists every bad field', () => {
  it('lists a bad side and a negative amount together, with the CCXT class, our code, a message and a docs link', async () => {
    const { app, placed, ledger } = await build();
    const journal = ledger.journal().length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: signed(),
      payload: order('jd04-3', { side: 'sideways', amount: '-1' }),
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({
      code: 'InvalidOrder',
      intafacedCode: 'trade.validation_failed',
      docs: '/developers/errors#trade.validation_failed',
      message: expect.stringMatching(/2 fields are invalid/),
    });
    expect(body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['amount', 'side']);
    for (const entry of body.errors) expect(entry.message).toEqual(expect.any(String));
    expect(body.errors.find((e: { field: string }) => e.field === 'amount').message).toBe('amount must be a positive decimal string');
    // The raw schema paths it carried before are still there, the amount among them.
    expect(body.issues.map((i: { path: string[] }) => i.path[0]).sort()).toEqual(['amount', 'side']);
    // Edge stamps the request id; the service sets none of its own.
    expect(body).not.toHaveProperty('requestId');
    expect(placed).toHaveLength(0);
    expect(ledger.journal()).toHaveLength(journal);
    await app.close();
  });

  it('keeps a single bad field as it was: its own message, one entry, the docs link of its code', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: order('jd04-3b', { amount: '0' }) });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'InvalidOrder',
      intafacedCode: 'trade.validation_failed',
      message: 'amount must be a positive decimal string',
      docs: '/developers/errors#trade.validation_failed',
      errors: [{ field: 'amount', message: 'amount must be a positive decimal string' }],
    });
    await app.close();
  });

  it('a bad tag keeps trade.invalid_tag, and its docs link names that code', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: order('jd04-3c', { tag: '' }) });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({
      intafacedCode: 'trade.invalid_tag',
      docs: '/developers/errors#trade.invalid_tag',
      errors: [{ field: 'tag' }],
    });
    await app.close();
  });

  it('a batch item with two bad fields carries the same one body', async () => {
    const { app, placed } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/batch',
      headers: signed(),
      payload: [order('jd04-3d', { side: 'sideways', price: '-2' })],
    });
    expect(res.statusCode, res.body).toBe(200);
    const [item] = res.json().results;
    expect(item.status).toBe('refused');
    expect(item.error.errors.map((e: { field: string }) => e.field).sort()).toEqual(['price', 'side']);
    expect(placed).toHaveLength(0);
    await app.close();
  });

  it('a body that is not an object is one entry for the body, not a crash', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: '[]' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().errors).toEqual([{ field: 'body', message: expect.any(String) }]);
    await app.close();
  });
});

describe('J-developer-04 #6: the platform posting freeze refuses a money call, a read still answers', () => {
  it('refuses the order posting_frozen with the CCXT class, writes nothing, and the balance read answers', async () => {
    const { app, ledger, placed } = await build();
    ledger.frozen = true;
    const journal = ledger.journal().length;
    const money = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: order('jd04-6') });
    expect(money.statusCode, money.body).toBe(400);
    expect(money.json()).toMatchObject({ code: 'ExchangeError', intafacedCode: 'posting_frozen' });
    expect(placed).toHaveLength(0);
    expect(ledger.journal()).toHaveLength(journal);

    const read = await app.inject({ method: 'GET', url: '/api/v1/account/balance', headers: signed() });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().balances.USDT).toMatchObject({ free: '10' });

    // Lifted, the same request (same client order id) places once.
    ledger.frozen = false;
    const after = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: order('jd04-6') });
    expect(after.statusCode, after.body).toBe(201);
    expect(placed).toHaveLength(1);
    await app.close();
  });
});
