/**
 * Support order read (J-support-public-20 #1) against Postgres, through the signed route.
 *
 * Promise: svc-support, and only svc-support, reads one order with its owner and stored status, `recovery_required`
 * included, and its fees in one asset; a missing order is 404 and a failed read is 503, never an invented order.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { readSupportOrder, registerSupportOrderRead } from './order-read.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')).endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const SECRET = 'a-support-order-read-internal-secret-32x';
const ALICE = '11111111-1111-4111-8111-111111111111';

describe('support order read', () => {
  let db: TestDatabase;
  let failRead = false;
  let spot = '';

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
    // The migrations list BTC/USDT; the read uses that market.
    const [market] = await db.sql<
      Array<{ id: string; quote_asset: string }>
    >`SELECT id, quote_asset FROM trade.markets WHERE symbol = 'BTC/USDT'`;
    spot = market!.id;
    expect(market!.quote_asset).toBe('USDT');
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function order(status: string, filled = '0'): Promise<string> {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset, hold_amount,
        recovery_reason, reconciliation_key)
      VALUES (${id}, ${ALICE}, ${spot}, ${`c-${id}`}, 'buy', 'limit', '49000', '2', ${filled}, ${status}, 'GTC', 'USDT', 98000,
        ${status === 'recovery_required' ? 'SUBMIT_UNKNOWN' : null}, ${status === 'recovery_required' ? `recon:${id}` : null})`;
    return id;
  }

  async function app() {
    const a = Fastify();
    retainRawBody(a);
    registerSupportOrderRead(a, {
      secret: SECRET,
      read: async (id) => {
        if (failRead) throw new Error('database down');
        return readSupportOrder(db.sql, id);
      },
    });
    await a.ready();
    return a;
  }
  const get = (id: string, service: 'svc-support' | 'svc-bank' = 'svc-support') => ({
    method: 'GET' as const,
    url: `/internal/orders/${id}`,
    headers: serviceAuthHeadersForBody(service, SECRET, ''),
  });

  it('answers svc-support with the owner, the stored status (recovery_required too) and a zero fee in the quote asset', async () => {
    const stuck = await order('recovery_required', '0.5');
    const a = await app();
    const res = await a.inject(get(stuck));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      orderId: stuck,
      userId: ALICE,
      status: 'recovery_required',
      symbol: 'BTC/USDT',
      side: 'buy',
      filledQuantity: '0.5',
      feeAsset: 'USDT',
      feeAmount: '0',
    });
    await a.close();
  });

  it('answers 409 with the owner and status, and no fee figure, when fills charged fees in two assets', async () => {
    const id = await order('open', '2');
    for (const [seq, asset] of [
      [1, 'USDT'],
      [2, 'BTC'],
    ] as const)
      await db.sql`INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity, price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (${randomUUID()}, ${id}, ${randomUUID()}, ${spot}, ${ALICE}, 'buy', 'taker', 49000, 1, 49000, ${asset}, 1, 10, ${seq})`;
    const a = await app();
    const res = await a.inject(get(id));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'fees were charged in more than one asset',
      code: 'trade.order_fee_mixed',
      orderId: id,
      userId: ALICE,
      status: 'open',
    });
    await a.close();
  });

  it('is 404 for an id with no order and 503 when the read fails, never an invented order', async () => {
    const a = await app();
    expect((await a.inject(get(randomUUID()))).statusCode).toBe(404);
    // A well-formed id outside the RFC version and variant is looked up too, so it is 404 like any other id with no order.
    expect((await a.inject(get('00000000-0000-0000-0000-000000000000'))).json().code).toBe('trade.order_not_found');
    failRead = true;
    const down = await a.inject(get(randomUUID()));
    failRead = false;
    expect(down.statusCode).toBe(503);
    expect(down.json().code).toBe('matcher_down');
    await a.close();
  });

  it('refuses an unsigned caller, any other service, and an id that is not one', async () => {
    const id = await order('open');
    const a = await app();
    expect((await a.inject({ method: 'GET', url: `/internal/orders/${id}` })).statusCode).toBe(401);
    expect((await a.inject(get(id, 'svc-bank'))).statusCode).toBe(403);
    expect((await a.inject(get('not-an-id'))).statusCode).toBe(400);
    await a.close();
  });
});
