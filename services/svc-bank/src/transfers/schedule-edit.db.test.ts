/**
 * BK-xfer-10 (J-bank-06 #1-#3): a one-off payment, editing a standing order at its revision, and a failed run.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger. Each case drives the runner with its own `now`.
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

const SECRET = 'bank-schedule-edit-principal-secret-32chars';
const USER = '31111111-1111-4111-8111-111111111111';
const OTHER = '32222222-2222-4222-8222-222222222222';

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

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T09:00:00.000Z');
const TOMORROW = new Date(NOW.getTime() + DAY);

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`
    TRUNCATE bank.schedule_revisions, bank.transfer_executions, bank.scheduled_transfers, bank.spaces
    RESTART IDENTITY CASCADE
  `;
  ledger = new MemoryLedger();
});

/** `null` is an unpublished cutoff (a default parameter would turn `undefined` into the TEST value). */
function services(cutoff: string | null = '60') {
  return createBankServices(sql, ledger, memoryLedgerHistory(ledger), { scheduleEditCutoffMinutes: cutoff ?? undefined });
}

async function fund(amount: string, ref: string) {
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: ref }));
}

async function spacesFor(bank: ReturnType<typeof services>) {
  const from = await bank.spaces.ensurePrimary(USER, 'USDT');
  const to = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Rent' });
  return { from, to };
}

const balance = async (spaceId: string) => formatAmount((await ledger.balance(subAccountAvailable(spaceId, 'USDT'))).amount);
const primary = async () => formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);

describe('a one-off payment dated tomorrow', () => {
  it('posts nothing today, posts once on its date, ends, and a second pass posts nothing', async () => {
    const bank = services();
    const { from, to } = await spacesFor(bank);
    await fund('100', 'once-1');
    const scheduled = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('25'),
      cadence: 'once',
      startsAt: TOMORROW,
      scheduleId: randomUUID(),
    });
    expect(scheduled).toMatchObject({ cadence: 'once', status: 'active', nextRunAt: TOMORROW, revision: 1 });

    expect(await bank.transfers.runDueTransfers({ now: NOW, limit: 10 })).toMatchObject({ settled: 0 });
    expect(await balance(to.id)).toBe('0');

    expect(await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 60_000), limit: 10 })).toMatchObject({ settled: 1 });
    expect(await balance(to.id)).toBe('25');
    expect(await primary()).toBe('75');
    expect(await bank.transfers.getSchedule(scheduled.id)).toMatchObject({ status: 'completed' });

    const posts = ledger.journal().length;
    expect(await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 40 * DAY), limit: 10 })).toMatchObject({
      settled: 0,
      schedulesConsidered: 0,
    });
    expect(ledger.journal().length).toBe(posts);
    expect(await bank.transfers.executions(scheduled.id, 10)).toEqual([
      expect.objectContaining({ occurrence: 0, amount: '25', status: 'settled', rejectionCode: null }),
    ]);
  });

  it('has a date and no end date: an end is refused by the service and by the table', async () => {
    const bank = services();
    const { from, to } = await spacesFor(bank);
    const input = {
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('5'),
      cadence: 'once' as const,
      startsAt: TOMORROW,
      endsAt: new Date(TOMORROW.getTime() + DAY),
      scheduleId: randomUUID(),
    };
    await expect(bank.transfers.schedule(input)).rejects.toMatchObject({ code: 'bank.validation_failed' });
    await expect(sql`
      INSERT INTO bank.scheduled_transfers (id, user_id, asset_id, from_space_id, to_space_id, amount, cadence, starts_at, ends_at, next_run_at)
      VALUES (${randomUUID()}, ${USER}, 'USDT', ${from.id}, ${to.id}, 5, 'once', ${TOMORROW}, ${input.endsAt}, ${TOMORROW})
    `).rejects.toThrow(/scheduled_transfers_once_no_end_ck/);
  });
});

describe('editing a standing order at its revision', () => {
  async function monthly(bank: ReturnType<typeof services>) {
    const { from, to } = await spacesFor(bank);
    const schedule = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'monthly',
      startsAt: TOMORROW,
      scheduleId: randomUUID(),
    });
    return { from, to, schedule };
  }

  it('lands once per revision, keeps what it replaced, and the next run posts the new amount', async () => {
    const bank = services();
    const { to, schedule } = await monthly(bank);
    await fund('100', 'edit-1');

    const edited = await bank.transfers.updateSchedule({
      scheduleId: schedule.id,
      userId: USER,
      revision: 1,
      amount: amt('15'),
      endsAt: null,
      now: NOW,
    });
    expect(edited).toMatchObject({ revision: 2, amount: amt('15') });

    // A second, different edit sent at the same revision changes nothing.
    await expect(
      bank.transfers.updateSchedule({ scheduleId: schedule.id, userId: USER, revision: 1, amount: amt('99'), endsAt: null, now: NOW }),
    ).rejects.toMatchObject({ code: 'bank.schedule_revision_conflict' });
    expect(await bank.transfers.getSchedule(schedule.id)).toMatchObject({ revision: 2, amount: amt('15') });

    // The same edit sent again (a retry of the one that landed) is answered with the revision it made.
    expect(
      await bank.transfers.updateSchedule({
        scheduleId: schedule.id,
        userId: USER,
        revision: 1,
        amount: amt('15'),
        endsAt: null,
        now: NOW,
      }),
    ).toMatchObject({ revision: 2 });

    expect(await bank.transfers.scheduleRevisions(schedule.id)).toEqual([
      expect.objectContaining({ revision: 1, amount: amt('10'), endsAt: null }),
    ]);

    await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 60_000), limit: 10 });
    expect(await balance(to.id)).toBe('15');
    expect(await bank.transfers.executions(schedule.id, 10)).toEqual([
      expect.objectContaining({ occurrence: 0, amount: '15', status: 'settled' }),
    ]);
  });

  it('an end date closes the window: the order completes after its last run', async () => {
    const bank = services();
    const { to, schedule } = await monthly(bank);
    await fund('100', 'edit-end');
    const end = new Date(TOMORROW.getTime() + 10 * DAY);
    expect(
      await bank.transfers.updateSchedule({ scheduleId: schedule.id, userId: USER, revision: 1, amount: amt('10'), endsAt: end, now: NOW }),
    ).toMatchObject({ revision: 2, endsAt: end });
    await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 60 * DAY), limit: 10 });
    expect(await balance(to.id)).toBe('10');
    expect(await bank.transfers.getSchedule(schedule.id)).toMatchObject({ status: 'completed' });
  });

  it('an end at or before the next run completes the order at the edit', async () => {
    const bank = services();
    const { to, schedule } = await monthly(bank);
    await fund('100', 'edit-close');
    await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 60_000), limit: 10 });
    expect(await balance(to.id)).toBe('10');
    const later = new Date(TOMORROW.getTime() + 2 * DAY);
    const closed = await bank.transfers.updateSchedule({
      scheduleId: schedule.id,
      userId: USER,
      revision: 1,
      amount: amt('10'),
      endsAt: new Date(TOMORROW.getTime() + 10 * DAY),
      now: later,
    });
    expect(closed).toMatchObject({ revision: 2, status: 'completed' });
    expect(await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 90 * DAY), limit: 10 })).toMatchObject({
      schedulesConsidered: 0,
    });
    expect(await balance(to.id)).toBe('10');
  });

  it('a paused order has no run coming, so the cutoff does not stop its edit', async () => {
    const bank = services();
    const { schedule } = await monthly(bank);
    await bank.transfers.pauseSchedule(schedule.id);
    const inside = new Date(TOMORROW.getTime() - 59 * 60_000);
    expect(
      await bank.transfers.updateSchedule({
        scheduleId: schedule.id,
        userId: USER,
        revision: 1,
        amount: amt('11'),
        endsAt: null,
        now: inside,
      }),
    ).toMatchObject({ revision: 2, status: 'paused', amount: amt('11') });
  });

  it('a retry of the create after an edit is the same order, compared on the terms it was created with', async () => {
    const bank = services();
    const { from, to, schedule } = await monthly(bank);
    await bank.transfers.updateSchedule({ scheduleId: schedule.id, userId: USER, revision: 1, amount: amt('15'), endsAt: null, now: NOW });
    const create = { userId: USER, fromSpaceId: from.id, toSpaceId: to.id, cadence: 'monthly' as const, startsAt: TOMORROW };
    expect(await bank.transfers.schedule({ ...create, amount: amt('10'), scheduleId: schedule.id })).toMatchObject({
      id: schedule.id,
      revision: 2,
      amount: amt('15'),
    });
    await expect(bank.transfers.schedule({ ...create, amount: amt('15'), scheduleId: schedule.id })).rejects.toMatchObject({
      code: 'bank.schedule_conflict',
    });
  });

  it('refuses while the cutoff is unpublished, inside the cutoff, when finished, and for another person', async () => {
    const { schedule } = await monthly(services());
    const edit = (bank: ReturnType<typeof services>, now: Date, over: Partial<{ userId: string; revision: number }> = {}) =>
      bank.transfers.updateSchedule({ scheduleId: schedule.id, userId: USER, revision: 1, amount: amt('12'), endsAt: null, now, ...over });

    await expect(edit(services(null), NOW)).rejects.toMatchObject({ code: 'bank.schedule_edit_cutoff_unset' });
    await expect(edit(services(' '), NOW)).rejects.toMatchObject({ code: 'bank.schedule_edit_cutoff_unset' });
    await expect(edit(services('sixty'), NOW)).rejects.toMatchObject({ code: 'bank.schedule_edit_cutoff_unset' });
    // 59 minutes before the run, with a 60-minute cutoff.
    await expect(edit(services(), new Date(TOMORROW.getTime() - 59 * 60_000))).rejects.toMatchObject({ code: 'bank.schedule_cutoff' });
    await expect(edit(services(), NOW, { userId: OTHER })).rejects.toMatchObject({ code: 'bank.schedule_not_found' });
    await expect(
      services().transfers.updateSchedule({
        scheduleId: schedule.id,
        userId: USER,
        revision: 1,
        amount: amt('12'),
        endsAt: new Date(NOW.getTime() - DAY),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'bank.validation_failed' });
    expect(await services().transfers.scheduleRevisions(schedule.id)).toEqual([]);

    await services().transfers.cancelSchedule(schedule.id);
    await expect(edit(services(), NOW)).rejects.toMatchObject({ code: 'bank.schedule_inactive' });
    expect(await services().transfers.getSchedule(schedule.id)).toMatchObject({ revision: 1, amount: amt('10') });
  });
});

describe('a run with too little money', () => {
  it('is recorded as failed with insufficient funds, posts nothing, is not made up, and the next run happens', async () => {
    const bank = services();
    const { from, to } = await spacesFor(bank);
    await fund('4', 'short-1');
    const schedule = await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'weekly',
      startsAt: TOMORROW,
      scheduleId: randomUUID(),
    });
    const posts = ledger.journal().length;
    expect(await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 60_000), limit: 10 })).toMatchObject({
      rejected: 1,
      settled: 0,
    });
    expect(ledger.journal().length).toBe(posts);
    expect(await primary()).toBe('4');

    await fund('20', 'short-2');
    expect(await bank.transfers.runDueTransfers({ now: new Date(TOMORROW.getTime() + 7 * DAY + 60_000), limit: 10 })).toMatchObject({
      settled: 1,
    });
    expect(await balance(to.id)).toBe('10');
    expect(await bank.transfers.executions(schedule.id, 10)).toEqual([
      expect.objectContaining({
        occurrence: 0,
        amount: '10',
        status: 'rejected',
        ledgerTxId: null,
        rejectionCode: 'ledger.insufficient_funds',
      }),
      expect.objectContaining({ occurrence: 1, amount: '10', status: 'settled' }),
    ]);
  });
});

describe('the edit door', () => {
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  function headers(userId: string): Record<string, string> {
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: '33333333-3333-4333-8333-333333333333',
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
  async function mount(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: createBankRouter(services()),
        createContext: ({ req }) => edgeContext(req),
      } satisfies FastifyTRPCPluginOptions<BankRouter>['trpcOptions'],
    });
    await app.ready();
    return app;
  }

  it('lists the revision, edits at it, refuses the same revision twice, and refuses another person', async () => {
    const bank = services();
    const { from, to } = await spacesFor(bank);
    const scheduleId = randomUUID();
    await bank.transfers.schedule({
      userId: USER,
      fromSpaceId: from.id,
      toSpaceId: to.id,
      amount: amt('10'),
      cadence: 'monthly',
      // Far enough out that the 60-minute cutoff against the real clock never closes it.
      startsAt: new Date(Date.now() + 30 * DAY),
      scheduleId,
    });
    const app = await mount();
    try {
      const list = await app.inject({
        method: 'GET',
        url: `/trpc/transfers.listSchedules?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`,
        headers: headers(USER),
      });
      expect(list.json().result.data[0]).toMatchObject({ id: scheduleId, revision: 1, endsAt: null, cadence: 'monthly' });

      const update = (userId: string, body: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/trpc/transfers.updateSchedule',
          headers: headers(userId),
          payload: { scheduleId, endsAt: null, ...body },
        });

      const first = await update(USER, { revision: 1, amount: '12.5' });
      expect(first.statusCode).toBe(200);
      expect(first.json().result.data).toMatchObject({ revision: 2, amount: '12.5', endsAt: null });

      const second = await update(USER, { revision: 1, amount: '13' });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.message).toContain('revision 2');

      const stranger = await update(OTHER, { revision: 2, amount: '1' });
      expect(stranger.statusCode).toBe(403);

      // endsAt is required, so leaving it out never clears an end by accident.
      const missing = await app.inject({
        method: 'POST',
        url: '/trpc/transfers.updateSchedule',
        headers: headers(USER),
        payload: { scheduleId, revision: 2, amount: '1' },
      });
      expect(missing.statusCode).toBe(400);
      expect(await bank.transfers.getSchedule(scheduleId)).toMatchObject({ revision: 2, amount: amt('12.5') });
    } finally {
      await app.close();
    }
  });
});
