/**
 * Trade closure check. Fails on main: there is no route.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { registerClosureCheck } from './closure-check.js';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const SECRET = 'trade-closure-check-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

// PG-hard: never skip-green. TEST_DATABASE_URL is required; an unset or unreachable
// database fails this suite instead of skipping it.
const db: TestDatabase = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
const app = Fastify();
retainRawBody(app);
registerClosureCheck(app, { sql: db.sql, secret: SECRET });

beforeEach(async () => {
  await db.sql`TRUNCATE trade.positions, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function post(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', secret, raw) },
  });
}

async function codes(userId = USER) {
  const response = await post({ userId, subAccountIds: [] });
  expect(response.statusCode).toBe(200);
  return (response.json() as { blockers: Array<{ code: string }> }).blockers.map((row) => row.code);
}

async function market() {
  const symbol = `C/${randomUUID().slice(0, 8)}`;
  const rows = await db.sql<{ id: string }[]>`
    INSERT INTO trade.markets (symbol, display_name, base_asset, quote_asset, tick_size, lot_size, min_qty, min_notional, maker_bps, taker_bps)
    VALUES (${symbol}, ${symbol}, 'BTC', 'USDT', '0.01', '0.0001', '0.0001', '1', 10, 20)
    RETURNING id
  `;
  return rows[0]!.id;
}

it('mounts the signed route from svc-trade index', () => {
  const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  expect(index).toMatch(/registerClosureCheck\(app, \{ sql, secret: env\.INTERNAL_SERVICE_SECRET \}\)/);
});

it('refuses a missing or bad signature with 401', async () => {
  const raw = JSON.stringify({ userId: USER, subAccountIds: [] });
  const missing = await app.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json' },
  });
  expect(missing.statusCode).toBe(401);
  const bad = await post({ userId: USER, subAccountIds: [] }, 'wrong-secret-that-is-long-enough-for-hmac');
  expect(bad.statusCode).toBe(401);
});

it('returns an empty list when nothing is open', async () => {
  expect(await codes()).toEqual([]);
});

it('detects an open order and an open position, and clears each when the row closes', async () => {
  const marketId = await market();
  const orderId = randomUUID();
  await db.sql`
    INSERT INTO trade.orders (id, user_id, market_id, side, type, price, qty, hold_asset, hold_amount, status)
    VALUES (${orderId}, ${USER}, ${marketId}, 'buy', 'limit', '1', '1', 'USDT', '1', 'open')
  `;
  expect(await codes()).toContain('open_order');
  await db.sql`UPDATE trade.orders SET status = 'cancelled' WHERE id = ${orderId}`;
  expect(await codes()).not.toContain('open_order');

  const position = await db.sql<{ id: string }[]>`
    INSERT INTO trade.positions (user_id, market_id, side, size, entry_price, margin_initial, margin_current, margin_asset, status)
    VALUES (${USER}, ${marketId}, 'long', '1', '1', '1', '1', 'USDT', 'open')
    RETURNING id
  `;
  expect(await codes()).toContain('open_position');
  await db.sql`UPDATE trade.positions SET status = 'closed' WHERE id = ${position[0]!.id}`;
  expect(await codes()).not.toContain('open_position');
});

it('does not count another user', async () => {
  const marketId = await market();
  await db.sql`
    INSERT INTO trade.orders (id, user_id, market_id, side, type, price, qty, hold_asset, hold_amount, status)
    VALUES (${randomUUID()}, ${OTHER}, ${marketId}, 'buy', 'limit', '1', '1', 'USDT', '1', 'open')
  `;
  expect(await codes()).toEqual([]);
});

it('answers 503 when the database fails', async () => {
  const broken = (() => {
    throw new Error('db down');
  }) as unknown as typeof db.sql;
  const down = Fastify();
  retainRawBody(down);
  registerClosureCheck(down, { sql: broken, secret: SECRET });
  const raw = JSON.stringify({ userId: USER, subAccountIds: [] });
  const response = await down.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, raw) },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json()).not.toMatchObject({ blockers: [] });
  await down.close();
});
