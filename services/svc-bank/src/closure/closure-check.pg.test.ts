/**
 * Bank closure check. Fails on main: there is no route.
 * Balances come from packages/ledger-client. A failed read is 503.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, type LedgerClient } from '@intafaced/ledger-client';
import { deposit } from '@intafaced/ledger-client/recipes';
import { registerClosureCheck } from './closure-check.js';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const SECRET = 'bank-closure-check-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

// PG-hard: never skip-green. TEST_DATABASE_URL is required; an unset or unreachable
// database fails this suite instead of skipping it.
const db: TestDatabase = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
const ledger = new MemoryLedger();
const app = Fastify();
retainRawBody(app);
registerClosureCheck(app, { sql: db.sql, ledger, secret: SECRET });

beforeEach(async () => {
  // The fraud list's history refuses TRUNCATE (append-only), and nothing here writes it: the reset skips that table.
  const tables = await db.sql<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${db.schema} AND tablename <> 'destination_fraud_list_history'
  `;
  await db.sql.unsafe(`TRUNCATE ${tables.map((t) => `"${db.schema}"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
});
afterAll(async () => {
  await app.close();
  await db.drop();
});

async function post(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody('svc-identity', secret, raw),
  };
  return app.inject({ method: 'POST', url: '/internal/closure-check', payload: raw, headers });
}

async function codes(userId = USER, subAccountIds: string[] = []) {
  const response = await post({ userId, subAccountIds });
  expect(response.statusCode).toBe(200);
  return response.json() as { blockers: Array<{ code: string; count: number }>; balances: Array<{ assetId: string; amount: string }> };
}

it('mounts the signed route from svc-bank index', () => {
  const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  expect(index).toMatch(/registerClosureCheck\(app, \{ sql, ledger, secret: env\.INTERNAL_SERVICE_SECRET, s2s: doorS2s \}\)/);
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

it('returns an empty list when the user has nothing open', async () => {
  const body = await codes();
  expect(body.blockers).toEqual([]);
  expect(body.balances).toEqual([]);
});

it('blocks on a dust balance and on a sub-account hold, and ignores another user', async () => {
  const dustLedger = new MemoryLedger();
  await dustLedger.post(
    deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('0.000000000000000001'), rail: 'test', railRef: 'dust' }),
  );
  await dustLedger.post(deposit({ userId: OTHER, assetId: 'BTC', amount: parseAmount('2'), rail: 'test', railRef: 'other' }));
  const dustApp = Fastify();
  retainRawBody(dustApp);
  registerClosureCheck(dustApp, { sql: db.sql, ledger: dustLedger, secret: SECRET });
  const dustRaw = JSON.stringify({ userId: USER, subAccountIds: [] });
  const dustResponse = await dustApp.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: dustRaw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, dustRaw) },
  });
  expect(dustResponse.statusCode).toBe(200);
  const dust = dustResponse.json() as {
    blockers: Array<{ code: string; count: number }>;
    balances: Array<{ assetId: string; amount: string }>;
  };
  expect(dust.blockers).toEqual([{ code: 'balance_remaining', count: 1 }]);
  expect(dust.balances).toEqual([{ assetId: 'USDT', amount: '0.000000000000000001' }]);
  await dustApp.close();

  const holdLedger = {
    async balances(ownerType: 'user' | 'subaccount', ownerId: string) {
      if (ownerType === 'subaccount' && ownerId === SUB) {
        return [{ account: { ownerType, ownerId, assetId: 'ETH', kind: 'hold' as const, purpose: 'order:1' }, amount: 1n }];
      }
      return [];
    },
  } as unknown as Pick<LedgerClient, 'balances'>;
  const holdApp = Fastify();
  retainRawBody(holdApp);
  registerClosureCheck(holdApp, { sql: db.sql, ledger: holdLedger, secret: SECRET });
  const raw = JSON.stringify({ userId: USER, subAccountIds: [SUB] });
  const response = await holdApp.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, raw) },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    blockers: [{ code: 'balance_remaining', count: 1 }],
    balances: [{ assetId: 'ETH', amount: '0.000000000000000001' }],
  });
  await holdApp.close();
});

it('detects each bank blocker and clears it when the row closes', async () => {
  const product = await db.sql<{ id: string }[]>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps,
      max_ltv_bps, margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      'closure', 'USDT', 'BTC', 'USDT', 100,
      5000, 6000, 7000, 8000, 4000,
      100, 1000, 60
    ) RETURNING id
  `;
  const loan = await db.sql<{ id: string }[]>`
    INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal)
    VALUES (${product[0]!.id}, ${USER}, 'USDT', 'BTC', 'USDT', 100, '1')
    RETURNING id
  `;
  expect((await codes()).blockers.map((row) => row.code)).toContain('open_loan');
  await db.sql`UPDATE bank.loans SET status = 'repaid' WHERE id = ${loan[0]!.id}`;
  expect((await codes()).blockers.map((row) => row.code)).not.toContain('open_loan');

  const card = await db.sql<{ id: string }[]>`
    INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit)
    VALUES (${USER}, 'USDT', 'USDT', 'card-sim', 'ref-1', '4242', '10')
    RETURNING id
  `;
  expect((await codes()).blockers.map((row) => row.code)).toContain('active_card');
  await db.sql`UPDATE bank.cards SET status = 'closed' WHERE id = ${card[0]!.id}`;
  expect((await codes()).blockers.map((row) => row.code)).not.toContain('active_card');

  const from = await db.sql<{ id: string }[]>`
    INSERT INTO bank.spaces (user_id, asset_id, name) VALUES (${USER}, 'USDT', 'from') RETURNING id
  `;
  const to = await db.sql<{ id: string }[]>`
    INSERT INTO bank.spaces (user_id, asset_id, name) VALUES (${USER}, 'USDT', 'to') RETURNING id
  `;
  const schedule = await db.sql<{ id: string }[]>`
    INSERT INTO bank.scheduled_transfers (user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, next_run_at)
    VALUES (${USER}, 'USDT', ${from[0]!.id}, ${to[0]!.id}, '1', 'daily', now(), now())
    RETURNING id
  `;
  expect((await codes()).blockers.map((row) => row.code)).toContain('active_schedule');
  await db.sql`UPDATE bank.scheduled_transfers SET status = 'cancelled' WHERE id = ${schedule[0]!.id}`;
  expect((await codes()).blockers.map((row) => row.code)).not.toContain('active_schedule');

  const ramp = await db.sql<{ id: string }[]>`
    INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, rail, rail_ref, credited_by)
    VALUES (${USER}, 'USDT', '1', 'test', 'rail-1', 'test')
    RETURNING id
  `;
  expect((await codes()).blockers.map((row) => row.code)).toContain('pending_ramp');
  await db.sql`UPDATE bank.ramp_onramps SET status = 'settled', ledger_tx_id = 'tx-closure' WHERE id = ${ramp[0]!.id}`;
  expect((await codes()).blockers.map((row) => row.code)).not.toContain('pending_ramp');

  const pool = await db.sql<{ id: string }[]>`
    INSERT INTO bank.earn_pools (asset_id, kind, name, apr_bps) VALUES ('USDT', 'flexible', 'closure', 100) RETURNING id
  `;
  const position = await db.sql<{ id: string }[]>`
    INSERT INTO bank.earn_positions (pool_id, user_id, asset_id, principal, status)
    VALUES (${pool[0]!.id}, ${USER}, 'USDT', '1', 'active')
    RETURNING id
  `;
  expect((await codes()).blockers.map((row) => row.code)).toContain('earn_position');
  await db.sql`UPDATE bank.earn_positions SET status = 'closed' WHERE id = ${position[0]!.id}`;
  expect((await codes()).blockers.map((row) => row.code)).not.toContain('earn_position');
});

it('does not count another user', async () => {
  const product = await db.sql<{ id: string }[]>`
    INSERT INTO bank.loan_products (
      name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps,
      max_ltv_bps, margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps,
      penalty_bps, max_tranche_bps, grace_seconds
    ) VALUES (
      'other', 'USDT', 'BTC', 'USDT', 100,
      5000, 6000, 7000, 8000, 4000,
      100, 1000, 60
    ) RETURNING id
  `;
  await db.sql`
    INSERT INTO bank.loans (product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal)
    VALUES (${product[0]!.id}, ${OTHER}, 'USDT', 'BTC', 'USDT', 100, '1')
  `;
  expect((await codes()).blockers).toEqual([]);
});

it('answers 503 when the ledger or the database fails, never an empty list', async () => {
  const downLedger = {
    async balances() {
      throw new Error('ledger down');
    },
  } as unknown as Pick<LedgerClient, 'balances'>;
  const downApp = Fastify();
  retainRawBody(downApp);
  registerClosureCheck(downApp, { sql: db.sql, ledger: downLedger, secret: SECRET });
  const raw = JSON.stringify({ userId: USER, subAccountIds: [] });
  const ledgerDown = await downApp.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, raw) },
  });
  expect(ledgerDown.statusCode).toBe(503);
  expect(ledgerDown.json()).not.toMatchObject({ blockers: [] });
  await downApp.close();

  const broken = (() => {
    throw new Error('db down');
  }) as unknown as typeof db.sql;
  const dbApp = Fastify();
  retainRawBody(dbApp);
  registerClosureCheck(dbApp, {
    sql: broken,
    ledger: {
      async balances() {
        return [];
      },
    },
    secret: SECRET,
  });
  const dbDown = await dbApp.inject({
    method: 'POST',
    url: '/internal/closure-check',
    payload: raw,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, raw) },
  });
  expect(dbDown.statusCode).toBe(503);
  expect(dbDown.json()).not.toMatchObject({ blockers: [] });
  await dbApp.close();
});

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
  expect(tooMany.json()).toMatchObject({ code: 'bank.closure_check_input' });
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
    expect(response.json()).toMatchObject({ code: 'bank.closure_check_input' });
    expect(response.json()).not.toHaveProperty('blockers');
  }
});

it('counts rows on a listed sub-account and ignores an unlisted one', async () => {
  const card = (owner: string, ref: string) => db.sql`
    INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit)
    VALUES (${owner}, 'USDT', 'USDT', 'card-sim', ${ref}, '4242', '10')
  `;
  // Only an unlisted sub-account has an open card: nothing may appear.
  await card(SUB_UNLISTED, 'ref-unlisted');
  expect((await codes(USER, [SUB])).blockers).toEqual([]);
  // The listed sub-account's card blocks; the unlisted one still does not add to the count.
  await card(SUB, 'ref-listed');
  expect((await codes(USER, [SUB])).blockers).toEqual([{ code: 'active_card', count: 1 }]);
  // Not listed: neither card is seen.
  expect((await codes(USER, [])).blockers).toEqual([]);
});

describe('scope sub_accounts leaves the main account out', () => {
  const card = (owner: string, ref: string) => db.sql`
    INSERT INTO bank.cards (user_id, asset_id, settlement_asset_id, issuer, issuer_ref, pan_tail, per_authorization_limit)
    VALUES (${owner}, 'USDT', 'USDT', 'card-sim', ${ref}, '4242', '10')
  `;

  it('ignores a main-account card and counts the named sub-account card', async () => {
    await card(USER, 'ref-main');
    const sub = async () => {
      const response = await post({ userId: USER, subAccountIds: [SUB], scope: 'sub_accounts' });
      expect(response.statusCode).toBe(200);
      return (response.json() as { blockers: unknown[] }).blockers;
    };
    expect(await sub()).toEqual([]);
    await card(SUB, 'ref-sub');
    expect(await sub()).toEqual([{ code: 'active_card', count: 1 }]);
    // Without the scope the main account's card still counts too.
    expect((await codes(USER, [SUB])).blockers).toEqual([{ code: 'active_card', count: 2 }]);
  });

  it('does not read the main account balance', async () => {
    const mainLedger = new MemoryLedger();
    await mainLedger.post(deposit({ userId: USER, assetId: 'BTC', amount: parseAmount('1'), rail: 'test', railRef: 'main-only' }));
    const scoped = Fastify();
    retainRawBody(scoped);
    registerClosureCheck(scoped, { sql: db.sql, ledger: mainLedger, secret: SECRET });
    const raw = JSON.stringify({ userId: USER, subAccountIds: [SUB], scope: 'sub_accounts' });
    const response = await scoped.inject({
      method: 'POST',
      url: '/internal/closure-check',
      payload: raw,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', SECRET, raw) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ blockers: [], balances: [] });
    await scoped.close();
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
