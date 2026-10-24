/**
 * BK-acct-10 (J-bank-06 #5): the money calendar over Postgres and a MemoryLedger, with real standing orders and their
 * runs, a TEST direct debit and a fixed-term earn position; and the customer door over HTTP.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { memoryRecipientState } from '../recipient-state.js';
import { directDebitSimScheme } from '../direct-debits/scheme.js';
import { LOAN_SCHEDULE_UNSET } from './calendar.js';

const SECRET = 'bank-calendar-principal-secret-32chars-x';
const USER = '61111111-1111-4111-8111-111111111111';
const OTHER = '62222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T09:00:00.000Z');
const FROM = new Date('2026-11-01T00:00:00.000Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`
    TRUNCATE bank.dd_refund_requests, bank.dd_collections, bank.dd_mandates, bank.schedule_revisions,
             bank.transfer_executions, bank.scheduled_transfers, bank.earn_positions, bank.earn_pools, bank.spaces
    RESTART IDENTITY CASCADE
  `;
  ledger = new MemoryLedger();
});

function services() {
  return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
    recipients: memoryRecipientState(),
    directDebitScheme: directDebitSimScheme({
      label: 'TEST direct debit stand-in',
      guaranteeDays: 30,
      creditors: [{ id: 'TEST-GYM', name: 'TEST Gym' }],
    }),
  });
}

async function fund(amount: string, ref: string, userId = USER) {
  await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: ref }));
}

const window = (bank: ReturnType<typeof services>, userId = USER) =>
  bank.calendar.window({ userId, from: FROM, days: 30, limit: 50, now: NOW });

describe('the calendar over the real sources', () => {
  it('shows a settled run as done, a run with too little money as failed by name, and what is still to come', async () => {
    const bank = services();
    const from = await bank.spaces.ensurePrimary(USER, 'USDT');
    const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
    await fund('30', 'cal-1');
    const weekly = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('20'),
      cadence: 'weekly',
      startsAt: new Date('2026-11-02T08:00:00.000Z'),
      scheduleId: randomUUID(),
    });
    // 2 Nov posts 20; 9 Nov finds 10 left and fails; 16, 23 and 30 Nov are still to come.
    await bank.transfers.runDueTransfers({ now: new Date('2026-11-02T08:05:00.000Z'), limit: 10 });
    await bank.transfers.runDueTransfers({ now: new Date('2026-11-09T08:05:00.000Z'), limit: 10 });

    await bank.directDebits.setUpMandate({ mandateId: 'MD-1', userId: USER, creditorId: 'TEST-GYM', reference: 'TEST 1', assetId: 'USDT' });
    await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-1', amount: '5', dueAt: at(3).toISOString() });

    const pool = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'fixed',
      name: 'TEST fixed 10 days',
      aprBps: 100,
      termDays: 10,
      minDeposit: 0n,
    });
    await fund('100', 'cal-earn');
    const position = await bank.earn.deposit({ poolId: pool.id, userId: USER, amount: amt('50'), positionId: randomUUID(), now: NOW });

    const posts = ledger.journal().length;
    const view = await window(bank);
    expect(view.items.map((i) => [i.source, i.date.slice(0, 10), i.status, i.reasonCode])).toEqual([
      ['standing_orders', '2026-11-02', 'done', null],
      ['standing_orders', '2026-11-09', 'failed', expect.stringMatching(/insufficient/)],
      ['direct_debits', '2026-11-13', 'upcoming', null],
      ['standing_orders', '2026-11-16', 'upcoming', null],
      ['earn', '2026-11-20', 'upcoming', null],
      ['standing_orders', '2026-11-23', 'upcoming', null],
      ['standing_orders', '2026-11-30', 'upcoming', null],
    ]);
    expect(view.items.filter((i) => i.source === 'standing_orders').every((i) => i.refId === weekly.id)).toBe(true);
    expect(new Set(view.items.map((i) => i.key)).size).toBe(view.items.length);
    expect(view.items.find((i) => i.source === 'earn')).toMatchObject({ refId: position.id, amount: '50' });
    expect(view.sources.find((s) => s.source === 'loans')).toEqual({
      source: 'loans',
      state: 'not_set',
      count: 0,
      code: LOAN_SCHEDULE_UNSET,
      complete: true,
    });
    expect(view.sources.find((s) => s.source === 'bills')).toMatchObject({ state: 'ok', count: 0, code: 'bank.bills_psp_unset' });

    // A paused order keeps its future dates on the calendar, marked paused.
    await bank.transfers.pauseSchedule(weekly.id);
    const paused = await bank.calendar.window({ userId: USER, from: FROM, days: 30, limit: 50, now: NOW });
    expect(paused.items.filter((i) => i.source === 'standing_orders').map((i) => i.status)).toEqual([
      'done',
      'failed',
      'paused',
      'paused',
      'paused',
    ]);

    // The calendar posted nothing.
    expect(ledger.journal().length).toBe(posts);

    // Another person's calendar holds none of it.
    const theirs = await window(bank, OTHER);
    expect(theirs.items).toEqual([]);
  });
});

describe('the customer door', () => {
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  function headers(userId: string): Record<string, string> {
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: '63333333-3333-4333-8333-333333333333',
      scopes: ['bank:read'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    };
  }

  it('answers the signed person with their own window, and refuses a window without a page size or over two months', async () => {
    const bank = services();
    await bank.directDebits.setUpMandate({ mandateId: 'MD-1', userId: USER, creditorId: 'TEST-GYM', reference: 'TEST 1', assetId: 'USDT' });
    const due = new Date(Date.now() + 2 * DAY);
    await bank.directDebits.present({ mandateId: 'MD-1', collectionId: 'C-1', amount: '5', dueAt: due.toISOString() });
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: createBankRouter(bank),
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
    });
    await app.ready();
    const get = (userId: string, input: unknown) =>
      app.inject({
        method: 'GET',
        url: `/trpc/calendar.window?input=${encodeURIComponent(JSON.stringify(input))}`,
        headers: headers(userId),
      });
    try {
      const from = new Date(Date.now() - DAY).toISOString().slice(0, 10);
      const mine = await get(USER, { from, days: 31, limit: 50 });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().result.data.items).toEqual([
        expect.objectContaining({ source: 'direct_debits', refId: 'MD-1', label: 'TEST Gym', status: 'upcoming' }),
      ]);
      expect((await get(OTHER, { from, days: 31, limit: 50 })).json().result.data.items).toEqual([]);
      expect((await get(USER, { from, days: 31 })).statusCode).toBe(400);
      expect((await get(USER, { from, days: 63, limit: 50 })).statusCode).toBe(400);
      expect((await get(USER, { from: '2026-02-30', days: 28, limit: 50 })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
