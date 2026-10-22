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
  await db.sql`TRUNCATE trade.convert_quotes, trade.positions, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
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

async function convertQuote(userId: string, lifecycle: 'open' | 'bound' | 'settled') {
  const quoteId = `cq-${randomUUID()}`;
  const accepted = lifecycle === 'open' ? null : new Date();
  const fill = lifecycle === 'open' ? null : '100';
  const settled = lifecycle === 'settled' ? new Date() : null;
  await db.sql`
    INSERT INTO trade.convert_quotes (
      quote_id, user_id, lifecycle, symbol, market_id, side, base_asset, quote_asset, in_asset, out_asset,
      in_amount, out_amount, requested_qty, filled_qty, book_notional, user_notional, avg_price, convert_spread_bps,
      fully_filled, source_kind, source_symbol, source_as_of, created_at, expires_at, accepted_at, fill_price, fill_notional, settled_at
    ) VALUES (
      ${quoteId}, ${userId}, ${lifecycle}, 'BTC/USDT', 'm-1', 'buy', 'BTC', 'USDT', 'USDT', 'BTC',
      '100', '1', '1', '1', '100', '100', '100', 10,
      true, 'book', 'BTC/USDT', now(), now(), now() + interval '30 seconds', ${accepted}, ${fill}, ${fill}, ${settled}
    )
  `;
  return quoteId;
}

it('mounts the signed route from svc-trade index', () => {
  const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  expect(index).toMatch(/registerClosureCheck\(app, \{ sql, secret: env\.INTERNAL_SERVICE_SECRET, s2s: doorS2s \}\)/);
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

const SUB_LISTED = '44444444-4444-4444-8444-444444444444';
const SUB_UNLISTED = '55555555-5555-4555-8555-555555555555';

function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

it('refuses a request from a signed service that is not identity with 403', async () => {
  const raw = JSON.stringify({ userId: USER, subAccountIds: [] });
  const response = await app.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-pay', SECRET, raw) },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).not.toHaveProperty('blockers');
});

it('accepts 100 sub-account ids and refuses 101 with 400', async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => uuidN(i + 1));
  expect((await post({ userId: USER, subAccountIds: hundred })).statusCode).toBe(200);
  const tooMany = await post({ userId: USER, subAccountIds: [...hundred, uuidN(101)] });
  expect(tooMany.statusCode).toBe(400);
  expect(tooMany.json()).toMatchObject({ code: 'trade.closure_check_input' });
});

it('refuses a malformed body with 400 and never an empty blocker list', async () => {
  const bad: unknown[] = [
    null,
    [],
    {},
    { userId: USER },
    { subAccountIds: [] },
    { userId: 'not-a-uuid', subAccountIds: [] },
    { userId: USER, subAccountIds: 'nope' },
    { userId: USER, subAccountIds: ['not-a-uuid'] },
    { userId: USER, subAccountIds: [42] },
    { userId: 42, subAccountIds: [] },
  ];
  for (const body of bad) {
    const response = await post(body);
    expect(response.statusCode, JSON.stringify(body)).toBe(400);
    expect(response.json()).toMatchObject({ code: 'trade.closure_check_input' });
    expect(response.json()).not.toHaveProperty('blockers');
  }
});

it('counts rows on a listed sub-account and ignores an unlisted one', async () => {
  const marketId = await market();
  const insertOrder = (userId: string, subAccountId: string | null) => db.sql`
    INSERT INTO trade.orders (id, user_id, sub_account_id, market_id, side, type, price, qty, hold_asset, hold_amount, status)
    VALUES (${randomUUID()}, ${userId}, ${subAccountId}, ${marketId}, 'buy', 'limit', '1', '1', 'USDT', '1', 'open')
  `;
  // Only unlisted sub-account activity exists: nothing may appear.
  await insertOrder(OTHER, SUB_UNLISTED);
  await db.sql`
    INSERT INTO trade.positions (user_id, market_id, side, size, entry_price, margin_initial, margin_current, margin_asset, status)
    VALUES (${SUB_UNLISTED}, ${marketId}, 'long', '1', '1', '1', '1', 'USDT', 'open')
  `;
  const none = await post({ userId: USER, subAccountIds: [SUB_LISTED] });
  expect(none.statusCode).toBe(200);
  expect(none.json()).toMatchObject({ blockers: [] });

  // An order tagged with the listed sub-account, and a position owned by it.
  await insertOrder(OTHER, SUB_LISTED);
  await db.sql`
    INSERT INTO trade.positions (user_id, market_id, side, size, entry_price, margin_initial, margin_current, margin_asset, status)
    VALUES (${SUB_LISTED}, ${marketId}, 'long', '1', '1', '1', '1', 'USDT', 'open')
  `;
  const listed = await post({ userId: USER, subAccountIds: [SUB_LISTED] });
  expect(listed.json()).toMatchObject({
    blockers: [
      { code: 'open_order', count: 1 },
      { code: 'open_position', count: 1 },
    ],
  });
  // The same rows do not show when the sub-account is not listed.
  const unlisted = await post({ userId: USER, subAccountIds: [] });
  expect(unlisted.json()).toMatchObject({ blockers: [] });
});

describe('convert hold (RC-identity-15)', () => {
  it('counts a bound convert quote as convert_hold with its count, and clears it when the quote settles', async () => {
    const first = await convertQuote(USER, 'bound');
    await convertQuote(USER, 'bound');
    const response = await post({ userId: USER, subAccountIds: [] });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { blockers: unknown[] }).blockers).toEqual([{ code: 'convert_hold', count: 2 }]);
    await db.sql`UPDATE trade.convert_quotes SET lifecycle = 'settled', settled_at = now() WHERE quote_id = ${first}`;
    const after = await post({ userId: USER, subAccountIds: [] });
    expect((after.json() as { blockers: unknown[] }).blockers).toEqual([{ code: 'convert_hold', count: 1 }]);
  });

  it("ignores an open (unaccepted) or settled quote, and another user's bound quote", async () => {
    await convertQuote(USER, 'open');
    await convertQuote(USER, 'settled');
    await convertQuote(OTHER, 'bound');
    expect(await codes()).toEqual([]);
  });

  it('lists open_order and convert_hold together', async () => {
    const marketId = await market();
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, side, type, price, qty, hold_asset, hold_amount, status)
      VALUES (${randomUUID()}, ${USER}, ${marketId}, 'buy', 'limit', '1', '1', 'USDT', '1', 'open')
    `;
    await convertQuote(USER, 'bound');
    expect(await codes()).toEqual(['open_order', 'convert_hold']);
  });

  it('counts a sub-account bound quote for the account and for scope sub_accounts, never the main account alone', async () => {
    const SUB = '44444444-4444-4444-8444-444444444444';
    await convertQuote(SUB, 'bound');
    expect(await codes()).toEqual([]);
    const all = await post({ userId: USER, subAccountIds: [SUB] });
    expect((all.json() as { blockers: unknown[] }).blockers).toEqual([{ code: 'convert_hold', count: 1 }]);
    await convertQuote(USER, 'bound');
    const subOnly = await post({ userId: USER, subAccountIds: [SUB], scope: 'sub_accounts' });
    expect((subOnly.json() as { blockers: unknown[] }).blockers).toEqual([{ code: 'convert_hold', count: 1 }]);
  });
});

describe('scope sub_accounts leaves the main account out', () => {
  const SUB = '33333333-3333-4333-8333-333333333333';
  const openOrder = async (userId: string, subAccountId: string | null) => {
    const marketId = await market();
    await db.sql`
      INSERT INTO trade.orders (id, user_id, sub_account_id, market_id, side, type, price, qty, hold_asset, hold_amount, status)
      VALUES (${randomUUID()}, ${userId}, ${subAccountId}, ${marketId}, 'buy', 'limit', '1', '1', 'USDT', '1', 'open')
    `;
  };
  const sub = async () => {
    const response = await post({ userId: USER, subAccountIds: [SUB], scope: 'sub_accounts' });
    expect(response.statusCode).toBe(200);
    return (response.json() as { blockers: Array<{ code: string }> }).blockers.map((row) => row.code);
  };

  it('ignores a main-account order and counts an order placed under the sub-account', async () => {
    await openOrder(USER, null);
    expect(await sub()).toEqual([]);
    await openOrder(USER, SUB);
    expect(await sub()).toEqual(['open_order']);
  });

  it('counts an open position held under the sub-account id', async () => {
    const marketId = await market();
    await db.sql`
      INSERT INTO trade.positions (user_id, market_id, side, size, entry_price, margin_initial, margin_current, margin_asset, status)
      VALUES (${SUB}, ${marketId}, 'long', '1', '1', '1', '1', 'USDT', 'open')
    `;
    expect(await sub()).toEqual(['open_position']);
  });

  it('refuses a sub-account question that names no sub-account, and an unknown scope', async () => {
    for (const body of [
      { userId: USER, subAccountIds: [], scope: 'sub_accounts' },
      { userId: USER, subAccountIds: [USER], scope: 'sub_accounts' },
      { userId: USER, subAccountIds: [SUB], scope: 'everything' },
    ]) {
      const response = await post(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).not.toHaveProperty('blockers');
    }
  });
});
