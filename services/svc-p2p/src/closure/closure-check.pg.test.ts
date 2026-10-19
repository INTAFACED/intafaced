/**
 * P2P closure check. Fails on main: there is no route.
 * This check does not erase trades, offers, or disputes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const SECRET = 'p2p-closure-check-secret-at-least-32-characters';
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
const db: TestDatabase = await createTestDatabase({ service: 'p2p', url: adminUrl(), migrations });
const app = Fastify();
retainRawBody(app);
registerClosureCheck(app, { sql: db.sql, secret: SECRET });

beforeEach(async () => {
  await db.sql`TRUNCATE p2p.p2p_disputes, p2p.p2p_trades, p2p.offers RESTART IDENTITY CASCADE`;
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

async function offer(maker: string) {
  const rows = await db.sql<{ id: string }[]>`
    INSERT INTO p2p.offers (maker_id, side, asset, fiat_currency, price_type, price, min_amt, max_amt, total_amt, remaining_amt)
    VALUES (${maker}, 'sell', 'USDT', 'USD', 'fixed', '1', '1', '2', '2', '2')
    RETURNING id
  `;
  return rows[0]!.id;
}

it('mounts the signed route from svc-p2p index', () => {
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

it('detects an open offer, trade, and dispute, and clears each when the row closes', async () => {
  const offerId = await offer(USER);
  expect(await codes()).toContain('open_offer');
  await db.sql`UPDATE p2p.offers SET status = 'closed' WHERE id = ${offerId}`;
  expect(await codes()).not.toContain('open_offer');

  const liveOffer = await offer(USER);
  await db.sql`UPDATE p2p.offers SET status = 'closed' WHERE id = ${liveOffer}`;
  const trade = await db.sql<{ id: string }[]>`
    INSERT INTO p2p.p2p_trades (
      offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency, amount, price, fiat_amount, method, status, deadline_at
    ) VALUES (
      ${liveOffer}, ${OTHER}, ${USER}, ${USER}, ${OTHER}, 'USDT', 'USD', '1', '1', '1', 'sepa', 'created', now() + interval '1 hour'
    ) RETURNING id
  `;
  expect(await codes()).toContain('open_trade');
  await db.sql`UPDATE p2p.p2p_trades SET escrow_lock_attempts = 1 WHERE id = ${trade[0]!.id}`;
  await db.sql`
    UPDATE p2p.p2p_trades
    SET status = 'cancelled', resolution = 'voided', deadline_at = NULL, resolved_at = now()
    WHERE id = ${trade[0]!.id}
  `;
  expect(await codes()).not.toContain('open_trade');

  const disputeOffer = await offer(USER);
  await db.sql`UPDATE p2p.offers SET status = 'closed' WHERE id = ${disputeOffer}`;
  const disputed = await db.sql<{ id: string }[]>`
    INSERT INTO p2p.p2p_trades (
      offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency, amount, price, fiat_amount, method, status, deadline_at
    ) VALUES (
      ${disputeOffer}, ${OTHER}, ${USER}, ${USER}, ${OTHER}, 'USDT', 'USD', '1', '1', '1', 'sepa', 'created', now() + interval '1 hour'
    ) RETURNING id
  `;
  const dispute = await db.sql<{ id: string }[]>`
    INSERT INTO p2p.p2p_disputes (trade_id, opened_by, reason, deadline_at)
    VALUES (${disputed[0]!.id}, ${USER}, 'closure', now() + interval '1 hour')
    RETURNING id
  `;
  expect(await codes()).toContain('open_dispute');
  await db.sql`
    UPDATE p2p.p2p_disputes
    SET status = 'resolved', resolution = 'refund', moderator_id = ${OTHER}, resolved_at = now(), four_eyes = false
    WHERE id = ${dispute[0]!.id}
  `;
  expect(await codes()).not.toContain('open_dispute');
});

it('does not count another user', async () => {
  await offer(OTHER);
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
  expect(tooMany.json()).toMatchObject({ code: 'p2p.closure_check_input' });
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
    expect(response.json()).toMatchObject({ code: 'p2p.closure_check_input' });
    expect(response.json()).not.toHaveProperty('blockers');
  }
});

it('counts rows on a listed sub-account and ignores an unlisted one', async () => {
  // Only unlisted sub-account activity exists: nothing may appear.
  const unlistedOffer = await offer(SUB_UNLISTED);
  await db.sql`
    INSERT INTO p2p.p2p_trades (
      offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency, amount, price, fiat_amount, method, status, deadline_at
    ) VALUES (
      ${unlistedOffer}, ${OTHER}, ${SUB_UNLISTED}, ${SUB_UNLISTED}, ${OTHER}, 'USDT', 'USD', '1', '1', '1', 'sepa', 'created', now() + interval '1 hour'
    )
  `;
  const none = await post({ userId: USER, subAccountIds: [SUB_LISTED] });
  expect(none.statusCode).toBe(200);
  expect(none.json()).toMatchObject({ blockers: [] });

  // A listed sub-account as maker of an offer, as buyer of a trade, and as opener of a dispute.
  const listedOffer = await offer(SUB_LISTED);
  const trade = await db.sql<{ id: string }[]>`
    INSERT INTO p2p.p2p_trades (
      offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency, amount, price, fiat_amount, method, status, deadline_at
    ) VALUES (
      ${listedOffer}, ${SUB_LISTED}, ${OTHER}, ${OTHER}, ${SUB_LISTED}, 'USDT', 'USD', '1', '1', '1', 'sepa', 'created', now() + interval '1 hour'
    ) RETURNING id
  `;
  await db.sql`
    INSERT INTO p2p.p2p_disputes (trade_id, opened_by, reason, deadline_at)
    VALUES (${trade[0]!.id}, ${SUB_LISTED}, 'closure', now() + interval '1 hour')
  `;
  const listed = await post({ userId: USER, subAccountIds: [SUB_LISTED] });
  expect(listed.json()).toMatchObject({
    blockers: [
      { code: 'open_offer', count: 1 },
      { code: 'open_trade', count: 1 },
      { code: 'open_dispute', count: 1 },
    ],
  });
  // The same rows do not show when the sub-account is not listed.
  const unlisted = await post({ userId: USER, subAccountIds: [] });
  expect(unlisted.json()).toMatchObject({ blockers: [] });
});
