import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { LedgerError, MemoryLedger, parseAmount, recipes, type PostRequest, type LedgerTx } from '@intafaced/ledger-client';
import { createOrderRequestSchema } from '@intafaced/exchange-contract';
import { createBodyRefusal } from './create-body-refusal.js';
import { refusedBeforeEngine } from './ledger-public-code.js';
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
  freezeAfterEngine = false;
  override async post(request: PostRequest): Promise<LedgerTx> {
    if (this.frozen) throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
    return super.post(request);
  }
}

async function build() {
  const ledger = new FreezableLedger();
  await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: 'alice:usdt' }));
  const placed: PlaceOrderInput[] = [];
  const replaced: string[] = [];
  const app = Fastify();
  registerPrivateRest(app, {
    findClientOrder: async () => null,
    replaceOrder: async (_p: Principal, id: string) => {
      replaced.push(id);
      throw new Error('a refused replacement body never reaches the service');
    },
    edgeSecret: SECRET,
    serviceName: 'svc-trade',
    marketBySymbol: async (s: string) => (s === 'BTC/USDT' ? market : null),
    marketById: async (id: string) => (id === market.id ? market : null),
    userBalances: (userId: string) => ledger.balances('user', userId),
    // The place door's step 3: the hold goes to the ledger before the engine, and a refused hold is marked as refused
    // before the engine, as order-place does. With `freezeAfterEngine`, the hold books, the engine takes the order, and
    // the freeze stops the next post (a fill): the order exists.
    placeOrder: async (_p: Principal, input: PlaceOrderInput) => {
      const orderId = `o-${input.clientOrderId}`;
      try {
        await ledger.post(recipes.orderHold({ orderId, userId: ALICE, assetId: 'USDT', amount: parseAmount('0.001') }));
      } catch (err) {
        throw refusedBeforeEngine(err);
      }
      placed.push(input);
      if (ledger.freezeAfterEngine) {
        ledger.frozen = true;
        await ledger.post(recipes.orderHold({ orderId: `${orderId}-fill`, userId: ALICE, assetId: 'USDT', amount: parseAmount('0.001') }));
      }
      return fakeOrder({ id: orderId, marketId: market.id, clientOrderId: input.clientOrderId, side: input.side, type: 'limit' });
    },
  } as unknown as PrivateRestDeps);
  await app.ready();
  return { app, ledger, placed, replaced };
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

describe('the replace door refuses its body the same way', () => {
  it('lists every bad field of a replacement in one 400, before the original is touched', async () => {
    const { app, replaced } = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/o-1/replace',
      headers: signed(),
      payload: order('jd04-r', { side: 'sideways', amount: '-1' }),
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({
      code: 'InvalidOrder',
      intafacedCode: 'trade.validation_failed',
      docs: '/developers/errors#trade.validation_failed',
    });
    expect(body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['amount', 'side']);
    expect(replaced).toHaveLength(0);
    await app.close();
  });
});

describe('the refusal code depends on which fields are wrong, never on the order they are reported in', () => {
  const tag = { path: ['tag'], message: 'Too small: expected string to have >=1 characters' };
  const side = { path: ['side'], message: 'Invalid option: expected one of "buy"|"sell"' };
  it('one bad field keeps its own code: a tag is trade.invalid_tag', () => {
    expect(createBodyRefusal({ issues: [tag] }, 'x')).toMatchObject({
      intafacedCode: 'trade.invalid_tag',
      message: 'tag must be 1 to 16 characters',
      docs: '/developers/errors#trade.invalid_tag',
    });
    // Two issues on the same one field are still one field.
    expect(createBodyRefusal({ issues: [tag, { ...tag, message: 'second' }] }, 'x').intafacedCode).toBe('trade.invalid_tag');
    expect(createBodyRefusal({ issues: [side] }, 'x')).toMatchObject({ intafacedCode: 'trade.validation_failed', message: side.message });
  });
  it('more than one bad field is trade.validation_failed, in either order', () => {
    for (const issues of [
      [tag, side],
      [side, tag],
    ]) {
      const refusal = createBodyRefusal({ issues }, 'x');
      expect(refusal).toMatchObject({
        code: 'InvalidOrder',
        intafacedCode: 'trade.validation_failed',
        docs: '/developers/errors#trade.validation_failed',
        message: expect.stringMatching(/^2 fields are invalid: /),
      });
      expect(refusal.errors.map((e) => e.field).sort()).toEqual(['side', 'tag']);
    }
  });
  it('a bad side next to a negative amount: the contract names both, so the one body lists both', () => {
    const parsed = createOrderRequestSchema.safeParse({
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'up',
      amount: '-1',
      price: '100',
      clientOrderId: 'jd04-3-unit',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const refusal = createBodyRefusal(parsed.error, 'x');
    expect(refusal.intafacedCode).toBe('trade.validation_failed');
    expect(refusal.errors.map((e) => e.field).sort()).toEqual(['amount', 'side']);
  });
});

describe('J-developer-04 #6: the platform posting freeze refuses a money call, a read still answers', () => {
  it('refuses the order posting_frozen with the CCXT class, writes nothing, and the balance read answers', async () => {
    const { app, ledger, placed } = await build();
    ledger.frozen = true;
    const journal = ledger.journal().length;
    const money = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: order('jd04-6') });
    // A refusal (400); the CCXT class tells a bot to back off and retry, which is safe under the same client order id.
    expect(money.statusCode, money.body).toBe(400);
    expect(money.json()).toMatchObject({ code: 'OnMaintenance', intafacedCode: 'posting_frozen' });
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

  it('a freeze after the engine took the order is never posting_frozen: 503 settlement pending, the hold stays', async () => {
    const { app, ledger, placed } = await build();
    ledger.freezeAfterEngine = true;
    const money = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: signed(), payload: order('jd04-6b') });
    expect(money.statusCode, money.body).toBe(503);
    expect(money.json()).toMatchObject({ code: 'ExchangeNotAvailable', intafacedCode: 'trade.settlement_pending' });
    expect(money.json().intafacedCode).not.toBe('posting_frozen');
    expect(placed).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'order.hold')).toHaveLength(1);
    await app.close();
  });
});
