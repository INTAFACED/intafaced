/**
 * Unit card — earn.deposit retry is one stake (caller positionId)
 *
 * 1. Promise: deposit requires a caller-stable positionId. Retry of the same
 *    positionId is one earn_positions row and one bank.earn.deposited. Ledger
 *    keys on positionId.
 * 2. Break: `positionId ?? crypto.randomUUID()` makes a retry without a stable
 *    client id a second stake. Hashing user/pool/amount merges two genuine
 *    same-amount deposits.
 * 3. Done bar: two deposit() same positionId → one row / one ledger post.
 *    HTTP omit positionId is 400. Distinct positionIds still open two.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/earn/earn-service.ts, router.ts (earn.deposit)
 * 6. RED: omit mints UUID / two same-id deposits post twice
 * 7. Collision: night Bank.vue; this file does not touch 05_Web_Front
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';

const SECRET = 'bank-earn-deposit-retry-id-secret-32!!';
const USER = '11111111-1111-4111-8111-111111111111';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

type WireBody = {
  result?: { data?: unknown };
  error?: { message?: string; data?: { code?: string; httpStatus?: number } };
};

describe('earn.deposit pins a required caller positionId', () => {
  it('deposit refuses omit and does not mint UUID', () => {
    const src = readFileSync(join(here, 'earn-service.ts'), 'utf8');
    const depAt = src.indexOf('async deposit(input:');
    const reuseAt = src.indexOf('private async reuseOrRefuse(', depAt);
    const body = src.slice(depAt, reuseAt);
    expect(depAt).toBeGreaterThan(-1);
    expect(body).toMatch(/bank\.position_id_required/);
    expect(body).not.toMatch(/randomUUID/);
    expect(body).not.toMatch(/crypto\.randomUUID/);
  });

  it('public door requires positionId so omit is not a second stake', () => {
    const src = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    const doorAt = src.indexOf("deposit: scopedProcedure('bank:write'");
    const wdAt = src.indexOf("withdraw: scopedProcedure('bank:write'", doorAt);
    const body = src.slice(doorAt, wdAt);
    expect(doorAt).toBeGreaterThan(-1);
    expect(body).toMatch(/positionId:\s*z\.string\(\)\.uuid\(\)/);
    expect(body).not.toMatch(/positionId:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });
});

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

afterAll(async () => {
  await db.drop();
}, 30_000);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
    'content-type': 'application/json',
  };
}

async function mountDoors(bank: ReturnType<typeof createBankServices>): Promise<FastifyInstance> {
  const router = createBankRouter(bank);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
  });
  await app.ready();
  return app;
}

async function post(app: FastifyInstance, path: string, input: Record<string, unknown>): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers: signedHeaders(), payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

function procedureData(body: WireBody): unknown {
  const data = body.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

async function fund(ledger: MemoryLedger, userId: string, value: string) {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId: 'USDT',
      amount: amt(value),
      rail: 'test',
      railRef: `${userId}:USDT:${randomUUID()}`,
    }),
  );
}

function depositCount(ledger: MemoryLedger): number {
  return ledger.journal().filter((tx) => tx.reason === 'bank.earn.deposited').length;
}

describe('EarnService.deposit — retry with the same positionId is one stake', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.interest_accruals, bank.earn_positions, bank.earn_pools
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('omit positionId refuses bank.position_id_required and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'USDT flex',
      aprBps: 3650,
    });
    await fund(ledger, USER, '5000');
    await expect(bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId: '' })).rejects.toMatchObject({
      code: 'bank.position_id_required',
    });
    expect(depositCount(ledger)).toBe(0);
  });

  it('two deposits with the same positionId — one row, one ledger post', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'USDT flex',
      aprBps: 3650,
    });
    await fund(ledger, USER, '5000');
    const positionId = randomUUID();

    const first = await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId });
    const retry = await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId });

    expect(retry.id).toBe(first.id);
    expect(retry.id).toBe(positionId);
    expect(depositCount(ledger)).toBe(1);
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.earn_positions WHERE pool_id = ${pool.id} AND user_id = ${USER}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(positionId);
  });

  it('timeout after stake posts, retry same positionId — still one deposit', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'USDT flex',
      aprBps: 3650,
    });
    await fund(ledger, USER, '5000');
    const positionId = randomUUID();

    const innerPost = ledger.post.bind(ledger);
    let timedOut = false;
    ledger.post = async (request) => {
      const posted = await innerPost(request);
      if (!timedOut && request.reason === 'bank.earn.deposited') {
        timedOut = true;
        throw new Error('timed out after earn deposit posted');
      }
      return posted;
    };

    await expect(bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId })).rejects.toThrow(
      /timed out after earn deposit posted/,
    );
    expect(depositCount(ledger)).toBe(1);

    const retry = await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId });
    expect(retry.status).toBe('active');
    expect(retry.id).toBe(positionId);
    expect(depositCount(ledger)).toBe(1);
  });

  it('two caller positionIds open two positions', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'USDT flex',
      aprBps: 3650,
    });
    await fund(ledger, USER, '5000');
    const a = randomUUID();
    const b = randomUUID();
    const first = await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId: a });
    const second = await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('1000'), positionId: b });
    expect(first.id).toBe(a);
    expect(second.id).toBe(b);
    expect(depositCount(ledger)).toBe(2);
  });
});

describe('HTTP /trpc/earn.deposit — retry with the same positionId is one stake', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.interest_accruals, bank.earn_positions, bank.earn_pools
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('HTTP without positionId is 400', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'USDT flex',
      aprBps: 3650,
    });
    await fund(ledger, USER, '5000');
    const app = await mountDoors(bank);
    const omitted = await post(app, 'earn.deposit', { poolId: pool.id, amount: '1000' });
    expect(omitted.statusCode).toBe(400);
    await app.close();
    expect(depositCount(ledger)).toBe(0);
  });

  it('two HTTP posts with the same positionId are one stake', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'USDT flex',
      aprBps: 3650,
    });
    await fund(ledger, USER, '5000');
    const positionId = randomUUID();
    const app = await mountDoors(bank);

    const first = await post(app, 'earn.deposit', { poolId: pool.id, amount: '1000', positionId });
    expect(first.statusCode).toBe(200);
    const firstData = procedureData(first.body) as { positionId: string };

    const retry = await post(app, 'earn.deposit', { poolId: pool.id, amount: '1000', positionId });
    expect(retry.statusCode).toBe(200);
    const retryData = procedureData(retry.body) as { positionId: string };
    expect(retryData.positionId).toBe(firstData.positionId);
    expect(retryData.positionId).toBe(positionId);
    await app.close();

    expect(depositCount(ledger)).toBe(1);
  });
});
