/**
 * Unit card — standing-order INSERT retry is one schedule (caller scheduleId)
 *
 * 1. Promise: schedule() requires a caller-stable scheduleId. Retry of the same
 *    id reuses the row. Fire path stays keyed on (scheduleId, occurrence).
 * 2. Break: INSERT without an id lets Postgres mint a UUID; retry is a second
 *    schedule and a second firing key.
 * 3. Done bar: two schedule() same scheduleId → one row. HTTP omit is 400.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/transfers/transfer-service.ts, router.ts
 * 6. RED: two inserts, two ids; source INSERT has no id column
 * 7. Collision: dest-user-missing mill — this file does not touch that refuse
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
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, subAccountAvailable, userAvailable } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { bankRouterSource } from '../router/router-source.js';

const SECRET = 'bank-standing-schedule-retry-id-secret';
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

describe('schedule pins a required caller scheduleId on INSERT', () => {
  it('schedule INSERT names id, refuses omit, and does not mint', () => {
    const src = readFileSync(join(here, 'transfer-service.ts'), 'utf8');
    const at = src.indexOf('async schedule(input:');
    const getAt = src.indexOf('async getSchedule(scheduleId: string)', at);
    const body = src.slice(at, getAt);
    expect(at).toBeGreaterThan(-1);
    expect(body).toMatch(/bank\.schedule_id_required/);
    expect(body).toMatch(/INSERT INTO bank\.scheduled_transfers/);
    expect(body).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    expect(body).toMatch(/\$\{scheduleId\}/);
    expect(body).not.toMatch(/randomUUID/);
  });

  it('public doors require scheduleId so omit is not a second order', () => {
    const src = bankRouterSource();
    const doorAt = src.indexOf("schedule: scopedProcedure('bank:write'");
    const listAt = src.indexOf("listSchedules: scopedProcedure('bank:read'", doorAt);
    const body = src.slice(doorAt, listAt);
    expect(doorAt).toBeGreaterThan(-1);
    expect(body).toMatch(/scheduleId:\s*z\.string\(\)\.guid\(\)/);
    expect(body).not.toMatch(/scheduleId:\s*z\.string\(\)\.guid\(\)\.optional\(\)/);
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
      createContext: ({ req }) => edgeContext(req),
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

describe('TransferService.schedule — retry with the same scheduleId is one row', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('omit scheduleId refuses bank.schedule_id_required', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    await expect(
      bank.transfers.schedule({
        userId: USER,
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: amt('100'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00.000Z'),
        scheduleId: '',
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_id_required' });
  });

  it('two schedule() calls with the same scheduleId — one row', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const startsAt = new Date('2026-01-01T09:00:00.000Z');
    const scheduleId = randomUUID();
    const input = {
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('100'),
      cadence: 'monthly' as const,
      startsAt,
      scheduleId,
    };

    const first = await bank.transfers.schedule(input);
    const retry = await bank.transfers.schedule(input);
    expect(first.id).toBe(scheduleId);
    expect(retry.id).toBe(first.id);

    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.scheduled_transfers WHERE user_id = ${USER}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(scheduleId);
  });

  it('same scheduleId with different amount refuses bank.schedule_conflict', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const startsAt = new Date('2026-01-01T09:00:00.000Z');
    const scheduleId = randomUUID();
    await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt,
      scheduleId,
    });
    await expect(
      bank.transfers.schedule({
        userId: USER,
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: amt('200'),
        cadence: 'monthly',
        startsAt,
        scheduleId,
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_conflict' });
  });

  it('same scheduleId with the same window returns the stored schedule and posts nothing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        rail: 'test',
        railRef: 'schedule-window-same',
      }),
    );
    const startsAt = new Date('2026-01-01T09:00:00.000Z');
    const endsAt = new Date('2026-06-01T09:00:00.000Z');
    const scheduleId = randomUUID();
    const first = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'monthly',
      startsAt,
      endsAt,
      scheduleId,
    });
    const posts = ledger.journal().length;
    const retry = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'monthly',
      startsAt: new Date(startsAt.toISOString()),
      endsAt: new Date(endsAt.toISOString()),
      scheduleId,
    });

    expect(retry.id).toBe(first.id);
    expect(retry.startsAt.getTime()).toBe(startsAt.getTime());
    expect(retry.endsAt?.getTime()).toBe(endsAt.getTime());
    expect(ledger.journal().length).toBe(posts);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM bank.scheduled_transfers WHERE user_id = ${USER}`;
    expect(rows).toHaveLength(1);
    const executions = await sql`SELECT id FROM bank.transfer_executions`;
    expect(executions).toHaveLength(0);
  });

  it('refuses a same-id retry that changes startsAt and keeps the stored window firing', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const startsAt = new Date('2026-01-01T00:00:00.000Z');
    const scheduleId = randomUUID();
    await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'daily',
      startsAt,
      scheduleId,
    });
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'test',
        railRef: 'schedule-window-start',
      }),
    );
    const posts = ledger.journal().length;

    await expect(
      bank.transfers.schedule({
        userId: USER,
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-02-01T00:00:00.000Z'),
        scheduleId,
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_conflict' });

    expect(ledger.journal().length).toBe(posts);
    const stored = await sql<Array<{ starts_at: Date; ends_at: Date | null }>>`
      SELECT starts_at, ends_at FROM bank.scheduled_transfers WHERE id = ${scheduleId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.starts_at.getTime()).toBe(startsAt.getTime());
    expect(stored[0]!.ends_at).toBeNull();

    const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00.000Z'), limit: 200 });
    expect(report.settled).toBe(1);
    expect(formatAmount((await ledger.balance(subAccountAvailable(to.id, 'USDT'))).amount)).toBe('10');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('90');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a same-id retry that changes endsAt and keeps firing past that end', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const startsAt = new Date('2026-01-01T00:00:00.000Z');
    const scheduleId = randomUUID();
    await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'daily',
      startsAt,
      scheduleId,
    });
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'test',
        railRef: 'schedule-window-end',
      }),
    );
    const posts = ledger.journal().length;

    await expect(
      bank.transfers.schedule({
        userId: USER,
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt,
        endsAt: new Date('2026-01-03T00:00:00.000Z'),
        scheduleId,
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_conflict' });

    expect(ledger.journal().length).toBe(posts);
    const stored = await sql<Array<{ starts_at: Date; ends_at: Date | null }>>`
      SELECT starts_at, ends_at FROM bank.scheduled_transfers WHERE id = ${scheduleId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.starts_at.getTime()).toBe(startsAt.getTime());
    expect(stored[0]!.ends_at).toBeNull();

    const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-08T10:00:00.000Z'), limit: 200 });
    expect(report.settled).toBe(8);
    expect(formatAmount((await ledger.balance(subAccountAvailable(to.id, 'USDT'))).amount)).toBe('80');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('20');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a same-id retry that moves a stored endsAt and does not replace that end', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const startsAt = new Date('2026-01-01T00:00:00.000Z');
    const endsAt = new Date('2026-01-04T00:00:00.000Z');
    const scheduleId = randomUUID();
    await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'daily',
      startsAt,
      endsAt,
      scheduleId,
    });
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'test',
        railRef: 'schedule-window-end-move',
      }),
    );
    const posts = ledger.journal().length;

    await expect(
      bank.transfers.schedule({
        userId: USER,
        fromSpaceId: from.id,
        toSpaceId: to.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt,
        endsAt: new Date('2026-01-02T00:00:00.000Z'),
        scheduleId,
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_conflict' });

    expect(ledger.journal().length).toBe(posts);
    const stored = await sql<Array<{ starts_at: Date; ends_at: Date | null }>>`
      SELECT starts_at, ends_at FROM bank.scheduled_transfers WHERE id = ${scheduleId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.starts_at.getTime()).toBe(startsAt.getTime());
    expect(stored[0]!.ends_at?.getTime()).toBe(endsAt.getTime());

    const report = await bank.transfers.runDueTransfers({ now: new Date('2026-02-01T00:00:00.000Z'), limit: 200 });
    expect(report.settled).toBe(3);
    const executions = await bank.transfers.executions(scheduleId, 50);
    expect(executions.map((row) => row.occurrence)).toEqual([0, 1, 2]);
    expect(formatAmount((await ledger.balance(subAccountAvailable(to.id, 'USDT'))).amount)).toBe('30');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('two caller scheduleIds still create two rows', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const startsAt = new Date('2026-01-01T09:00:00.000Z');
    const a = randomUUID();
    const b = randomUUID();
    const first = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt,
      scheduleId: a,
    });
    const second = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt,
      scheduleId: b,
    });
    expect(first.id).toBe(a);
    expect(second.id).toBe(b);
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM bank.scheduled_transfers WHERE user_id = ${USER}`;
    expect(rows).toHaveLength(2);
  });
});

describe('HTTP /trpc/transfers.schedule — retry with the same scheduleId is one row', () => {
  let ledger: MemoryLedger;

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  it('HTTP without scheduleId is 400', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const app = await mountDoors(bank);
    const omitted = await post(app, 'transfers.schedule', {
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
      cadence: 'monthly',
      startsAt: '2026-01-01T09:00:00.000Z',
    });
    expect(omitted.statusCode).toBe(400);
    await app.close();
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM bank.scheduled_transfers WHERE user_id = ${USER}`;
    expect(rows).toHaveLength(0);
  });

  it('two HTTP posts with the same scheduleId are one row', async () => {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger));
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    const scheduleId = randomUUID();
    const app = await mountDoors(bank);
    const payload = {
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: '100',
      cadence: 'monthly',
      startsAt: '2026-01-01T09:00:00.000Z',
      scheduleId,
    };

    const first = await post(app, 'transfers.schedule', payload);
    expect(first.statusCode).toBe(200);
    const firstData = procedureData(first.body) as { id: string };

    const retry = await post(app, 'transfers.schedule', payload);
    expect(retry.statusCode).toBe(200);
    const retryData = procedureData(retry.body) as { id: string };
    expect(retryData.id).toBe(firstData.id);
    expect(retryData.id).toBe(scheduleId);
    await app.close();

    const rows = await sql<Array<{ id: string }>>`SELECT id FROM bank.scheduled_transfers WHERE user_id = ${USER}`;
    expect(rows).toHaveLength(1);
  });
});
