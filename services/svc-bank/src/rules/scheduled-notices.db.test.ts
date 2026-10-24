/**
 * BK-acct-10 (J-bank-06 #6): the payment reminder rule and the standing-order notice outbox over Postgres and a
 * MemoryLedger, with real standing orders and their runs; and the customer door over HTTP.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { createBankRouter, type BankRouter } from '../router.js';
import { memoryRecipientState } from '../recipient-state.js';
import {
  eventScheduledNotices,
  type ScheduledFailedNotice,
  type ScheduledNoticeSink,
  type ScheduledReminderNotice,
} from './scheduled-notices.js';

const SECRET = 'bank-rules-principal-secret-32-chars-xx';
const USER = '71111111-1111-4111-8111-111111111111';
const OTHER = '72222222-2222-4222-8222-222222222222';

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

const HOUR = 3_600_000;
const NOW = new Date('2026-11-10T09:00:00.000Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`
    TRUNCATE bank.scheduled_notices, bank.reminder_rules, bank.schedule_revisions, bank.transfer_executions,
             bank.scheduled_transfers, bank.spaces
    RESTART IDENTITY CASCADE
  `;
  ledger = new MemoryLedger();
});

/** A sink that keeps what it was told, and can be made to fail. */
function recordingSink() {
  const told = { reminders: [] as ScheduledReminderNotice[], failures: [] as ScheduledFailedNotice[], down: false };
  const sink: ScheduledNoticeSink = {
    async reminder(n) {
      if (told.down) throw new Error('bus unreachable');
      told.reminders.push(n);
    },
    async failed(n) {
      if (told.down) throw new Error('bus unreachable');
      told.failures.push(n);
    },
  };
  return { told, sink };
}

function services(sink?: ScheduledNoticeSink) {
  return createBankServices(sql, ledger, memoryLedgerHistory(ledger), { recipients: memoryRecipientState(), scheduledNotices: sink });
}

async function fund(amount: string, ref: string, userId = USER) {
  await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: ref }));
}

async function standingOrder(bank: ReturnType<typeof services>, startsAt: Date, amount = '20', userId = USER) {
  const from = await bank.spaces.ensurePrimary(userId, 'USDT');
  const existing = (await bank.spaces.list(userId, 'USDT', 50)).find((s) => s.name === 'Rent');
  const to = existing ?? (await bank.spaces.create({ userId, assetId: 'USDT', name: 'Rent' }));
  return bank.transfers.schedule({
    userId,
    fromSpaceId: from.id,
    toSpaceId: to.id,
    amount: amt(amount),
    cadence: 'weekly',
    startsAt,
    scheduleId: randomUUID(),
  });
}

describe('the reminder rule', () => {
  it('is saved under its business key, read back on a replay, and a stale write is refused', async () => {
    const bank = services();
    expect(await bank.scheduledNotices.reminderRule(USER)).toBeNull();

    const first = await bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 24, expectedRevision: 0, clientRequestId: 'r-1' });
    expect(first).toMatchObject({ ruleKey: `reminder:${USER}`, leadHours: 24, revision: 1 });
    // The same request again is the same row, not a second rule.
    expect(
      await bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 24, expectedRevision: 0, clientRequestId: 'r-1' }),
    ).toEqual(first);
    // Another write that read no rule is stale now.
    await expect(
      bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 72, expectedRevision: 0, clientRequestId: 'r-2' }),
    ).rejects.toMatchObject({ code: 'bank.reminder_revision_conflict' });

    const off = await bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: null, expectedRevision: 1, clientRequestId: 'r-3' });
    expect(off).toMatchObject({ ruleKey: `reminder:${USER}`, leadHours: null, revision: 2 });
    await expect(
      bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 168, expectedRevision: 1, clientRequestId: 'r-4' }),
    ).rejects.toMatchObject({ code: 'bank.reminder_revision_conflict' });
    await expect(
      bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 5, expectedRevision: 2, clientRequestId: 'r-5' }),
    ).rejects.toMatchObject({ code: 'bank.reminder_lead_invalid' });

    expect(await bank.scheduledNotices.reminderRule(USER)).toEqual(off);
    expect(await bank.scheduledNotices.reminderRule(OTHER)).toBeNull();
    expect(await sql`SELECT user_id FROM bank.reminder_rules`).toHaveLength(1);
  });

  it('refuses a rule that moves money while the owner has published no terms, and stores nothing', () => {
    const bank = services();
    expect(() => bank.scheduledNotices.createMoneyRule()).toThrow(BankError);
    try {
      bank.scheduledNotices.createMoneyRule();
    } catch (err) {
      expect((err as BankError).code).toBe('bank.rule_terms_unset');
    }
  });
});

describe('reminders before a run', () => {
  it('owes one reminder for a run inside the lead time, and a second pass tells nobody again', async () => {
    const { told, sink } = recordingSink();
    const bank = services(sink);
    const soon = await standingOrder(bank, at(10));
    await standingOrder(bank, at(50)); // outside a day's lead
    await standingOrder(bank, at(5), '9', OTHER); // its owner has no rule
    await bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 24, expectedRevision: 0, clientRequestId: 'r-1' });

    const posts = ledger.journal().length;
    expect(await bank.scheduledNotices.run({ limit: 10, now: NOW })).toEqual({ reminders: 1, failures: 0, announced: 1, owed: 0 });
    expect(told.reminders).toEqual([
      {
        noticeId: expect.any(String),
        userId: USER,
        scheduleId: soon.id,
        occurrence: 0,
        dueAt: at(10).toISOString(),
        amount: '20',
        assetId: 'USDT',
        leadHours: 24,
      },
    ]);
    expect(await bank.scheduledNotices.run({ limit: 10, now: at(1) })).toEqual({ reminders: 0, failures: 0, announced: 0, owed: 0 });
    expect(told.reminders).toHaveLength(1);
    // A reminder is about a run, not a movement: nothing was posted.
    expect(ledger.journal()).toHaveLength(posts);
  });

  it('reminds of the next week once the first run is done, and sends none while reminders are off', async () => {
    const { told, sink } = recordingSink();
    const bank = services(sink);
    await fund('100', 'rem-1');
    const weekly = await standingOrder(bank, at(2));
    await bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: 168, expectedRevision: 0, clientRequestId: 'r-1' });
    await bank.scheduledNotices.run({ limit: 10, now: NOW });
    await bank.transfers.runDueTransfers({ now: at(3), limit: 10 });
    await bank.scheduledNotices.run({ limit: 10, now: at(3) });
    expect(told.reminders.map((r) => [r.scheduleId, r.occurrence])).toEqual([
      [weekly.id, 0],
      [weekly.id, 1],
    ]);

    await bank.scheduledNotices.setReminderRule({ userId: USER, leadHours: null, expectedRevision: 1, clientRequestId: 'r-2' });
    await bank.transfers.runDueTransfers({ now: at(2 + 7 * 24 + 1), limit: 10 });
    expect((await bank.scheduledNotices.run({ limit: 10, now: at(2 + 7 * 24 + 1) })).reminders).toBe(0);
    expect(told.reminders).toHaveLength(2);
  });
});

describe('failure notices', () => {
  // A run's attempt is stamped by the database clock, so these read the window around the real now.
  const now = () => new Date();
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
  it('tells the owner once of a run refused for too little money, with what it tried to move and why', async () => {
    const { told, sink } = recordingSink();
    const bank = services(sink);
    const empty = await standingOrder(bank, ago(1), '25');
    const run = await bank.transfers.runDueTransfers({ now: now(), limit: 10 });
    expect(run.rejected).toBe(1);

    expect(await bank.scheduledNotices.run({ limit: 10, now: now() })).toEqual({ reminders: 0, failures: 1, announced: 1, owed: 0 });
    expect(told.failures).toEqual([
      {
        noticeId: expect.any(String),
        userId: USER,
        scheduleId: empty.id,
        occurrence: 0,
        amount: '25',
        assetId: 'USDT',
        reasonCode: 'ledger.insufficient_funds',
        failedAt: expect.any(String),
      },
    ]);
    expect((await bank.scheduledNotices.run({ limit: 10, now: now() })).failures).toBe(0);
    expect(told.failures).toHaveLength(1);
  });

  it('keeps a notice owed while the bus is down and sends it on the next pass; with no bus it says so', async () => {
    const { told, sink } = recordingSink();
    const bank = services(sink);
    await standingOrder(bank, ago(1));
    await bank.transfers.runDueTransfers({ now: now(), limit: 10 });

    told.down = true;
    expect(await bank.scheduledNotices.run({ limit: 10, now: now() })).toEqual({ reminders: 0, failures: 1, announced: 0, owed: 1 });
    told.down = false;
    expect(await bank.scheduledNotices.run({ limit: 10, now: now() })).toEqual({ reminders: 0, failures: 0, announced: 1, owed: 0 });
    expect(told.failures).toHaveLength(1);

    const unwired = services();
    await standingOrder(unwired, ago(1), '30', OTHER);
    await unwired.transfers.runDueTransfers({ now: now(), limit: 10 });
    await expect(unwired.scheduledNotices.run({ limit: 10, now: now() })).rejects.toMatchObject({ code: 'bank.scheduled_notify_unwired' });
    expect(await sql`SELECT kind FROM bank.scheduled_notices WHERE user_id = ${OTHER} AND announced_at IS NULL`).toHaveLength(1);
  });

  it('publishes each notice on the bus under its schedule, occurrence and kind', async () => {
    const bus = new MemoryEventBus();
    const bank = services(eventScheduledNotices(bus));
    const empty = await standingOrder(bank, ago(1));
    await bank.transfers.runDueTransfers({ now: now(), limit: 10 });
    await bank.scheduledNotices.run({ limit: 10, now: now() });
    const sent = bus.emitted('bankScheduledFailed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      subject: 'intafaced.bank.scheduled_run.failed',
      idempotencyKey: `bank.scheduled_failed:${empty.id}:0`,
      payload: { scheduleId: empty.id, reasonCode: 'ledger.insufficient_funds' },
    });
  });
});

describe('the customer door', () => {
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  function headers(userId: string): Record<string, string> {
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: '73333333-3333-4333-8333-333333333333',
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
      'content-type': 'application/json',
    };
  }

  it('saves the signed person’s own rule, and refuses a money rule with the missing terms', async () => {
    const bank = services();
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: createBankRouter(bank),
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
    });
    await app.ready();
    const get = (userId: string) => app.inject({ method: 'GET', url: '/trpc/rules.get', headers: headers(userId) });
    const post = (userId: string, path: string, body: unknown) =>
      app.inject({ method: 'POST', url: `/trpc/${path}`, headers: headers(userId), payload: JSON.stringify(body) });
    try {
      expect((await get(USER)).json().result.data).toEqual({
        reminder: null,
        leadChoices: [24, 48, 72, 168],
        moneyRules: { state: 'not_set', code: 'bank.rule_terms_unset' },
      });
      const saved = await post(USER, 'rules.setReminder', { leadHours: 48, expectedRevision: 0, clientRequestId: 'web-1' });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().result.data).toMatchObject({ ruleKey: `reminder:${USER}`, leadHours: 48, revision: 1 });
      expect((await get(USER)).json().result.data.reminder).toMatchObject({ ruleKey: `reminder:${USER}`, leadHours: 48 });
      expect((await get(OTHER)).json().result.data.reminder).toBeNull();
      // A lead time that is not offered, and a body naming someone else, are refused by shape.
      expect((await post(USER, 'rules.setReminder', { leadHours: 5, expectedRevision: 1, clientRequestId: 'web-2' })).statusCode).toBe(400);
      expect(
        (await post(USER, 'rules.setReminder', { leadHours: 24, expectedRevision: 1, clientRequestId: 'web-3', userId: OTHER })).statusCode,
      ).toBe(400);
      expect((await post(USER, 'rules.setReminder', { leadHours: 24, expectedRevision: 0, clientRequestId: 'web-4' })).statusCode).toBe(
        409,
      );

      const money = await post(USER, 'rules.createMoneyRule', {
        name: 'Sweep TEST',
        fromSpaceId: randomUUID(),
        toSpaceId: randomUUID(),
        trigger: { kind: 'balance', above: '500' },
        amount: '100',
        clientRequestId: 'web-5',
      });
      expect(money.statusCode).toBe(412);
      expect(JSON.stringify(money.json())).toContain('bank.rule_terms_unset');
    } finally {
      await app.close();
    }
  });
});
