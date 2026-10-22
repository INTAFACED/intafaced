/**
 * BK-xfer-10 — one-off scheduled payments and standing-order edits. Postgres-hard: no skip; a missing
 * TEST_DATABASE_URL fails the suite.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';
import { dueOccurrence, lastOccurrenceBefore, occurrenceStart, planDue } from './schedule.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('once cadence (pure)', () => {
  const start = new Date('2026-11-01T09:00:00Z');
  it('once cadence -> one occurrence only', () => {
    expect(occurrenceStart(start, 'once', 0)).toEqual(start);
    expect(() => occurrenceStart(start, 'once', 1)).toThrow(RangeError);
    expect(dueOccurrence(start, 'once', new Date('2027-06-01T00:00:00Z'))).toBe(0);
    expect(lastOccurrenceBefore(start, 'once', null)).toBe(0);
    const first = planDue({ startsAt: start, cadence: 'once', endsAt: null, lastFired: null, now: new Date('2027-01-01T00:00:00Z') });
    expect(first).toMatchObject({ occurrences: [0], completed: true });
    const again = planDue({ startsAt: start, cadence: 'once', endsAt: null, lastFired: 0, now: new Date('2027-01-01T00:00:00Z') });
    expect(again).toMatchObject({ occurrences: [], completed: true });
  });

  it('suite is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(new RegExp('describe\\.skip' + 'If|\\bit\\.skip\\(|describe\\.skip\\('));
  });
});

describe('schedules (Postgres)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: ReturnType<typeof createBankServices>;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('schedule-once-edit is Postgres-hard: TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function services(cutoff?: number) {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), cutoff === undefined ? {} : { scheduleEditCutoffMinutes: cutoff });
  }

  beforeEach(async () => {
    await sql`TRUNCATE bank.schedule_edits, bank.transfer_executions, bank.scheduled_transfers RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    bank = services(60);
  });

  async function standing(cadence: 'once' | 'monthly', startsAt: Date) {
    const primary = await bank.spaces.ensurePrimary(USER, 'USDT');
    const rent = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: `Rent ${randomUUID().slice(0, 6)}` });
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    const schedule = await bank.transfers.schedule({
      scheduleId: randomUUID(),
      userId: USER,
      fromSpaceId: primary.id,
      toSpaceId: rent.id,
      amount: amt('100'),
      cadence,
      startsAt,
    });
    return { schedule, rent };
  }

  const settled = async (scheduleId: string) =>
    (
      await sql<Array<{ occurrence: number; amount: string }>>`
      SELECT occurrence, amount::text FROM bank.transfer_executions WHERE schedule_id = ${scheduleId} AND status = 'settled' ORDER BY occurrence
    `
    ).map((r) => [r.occurrence, amt(r.amount)]);

  it('a once schedule fires exactly once across passes and completes', async () => {
    const { schedule } = await standing('once', new Date('2026-01-05T09:00:00Z'));
    await bank.transfers.runDueTransfers({ now: new Date('2026-03-01T00:00:00Z'), limit: 10 });
    await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), limit: 10 });
    expect(await settled(schedule.id)).toEqual([[0, amt('100')]]);
    expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('completed');
  });

  it('update same revision twice -> one change; stale revision conflicts', async () => {
    const { schedule } = await standing('monthly', new Date('2030-01-01T09:00:00Z'));
    const now = new Date('2029-12-01T00:00:00Z');
    const a = await bank.scheduleEdits!.update({ scheduleId: schedule.id, userId: USER, revision: 0, amount: amt('150'), now });
    const b = await bank.scheduleEdits!.update({ scheduleId: schedule.id, userId: USER, revision: 0, amount: amt('150'), now });
    expect(a).toEqual(b);
    expect(a.revision).toBe(1);
    expect((await bank.transfers.getSchedule(schedule.id)).amount).toBe(amt('150'));
    await expect(
      bank.scheduleEdits!.update({ scheduleId: schedule.id, userId: USER, revision: 0, amount: amt('170'), now }),
    ).rejects.toMatchObject({
      code: 'bank.schedule_revision_conflict',
    });
    await expect(
      bank.scheduleEdits!.update({ scheduleId: schedule.id, userId: USER, revision: 5, amount: amt('170'), now }),
    ).rejects.toMatchObject({
      code: 'bank.schedule_revision_conflict',
    });
    expect(await sql`SELECT 1 FROM bank.schedule_edits`).toHaveLength(1);
  });

  it('edit after cutoff -> bank.schedule_cutoff; blank cutoff -> bank.schedule_cutoff_unset', async () => {
    const { schedule } = await standing('monthly', new Date('2030-01-01T09:00:00Z'));
    await expect(
      bank.scheduleEdits!.update({
        scheduleId: schedule.id,
        userId: USER,
        revision: 0,
        amount: amt('150'),
        now: new Date('2030-01-01T08:30:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_cutoff' });
    await expect(
      services().scheduleEdits!.update({
        scheduleId: schedule.id,
        userId: USER,
        revision: 0,
        amount: amt('150'),
        now: new Date('2029-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_cutoff_unset' });
    expect((await bank.transfers.getSchedule(schedule.id)).amount).toBe(amt('100'));
  });

  it('another user cannot edit; the next run moves the edited amount under the same key space', async () => {
    const { schedule } = await standing('monthly', new Date('2030-01-01T09:00:00Z'));
    await expect(
      bank.scheduleEdits!.update({
        scheduleId: schedule.id,
        userId: OTHER,
        revision: 0,
        amount: amt('1'),
        now: new Date('2029-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'bank.not_owner' });
    await bank.scheduleEdits!.update({
      scheduleId: schedule.id,
      userId: USER,
      revision: 0,
      amount: amt('40'),
      now: new Date('2029-01-01T00:00:00Z'),
    });
    await bank.transfers.runDueTransfers({ now: new Date('2030-01-02T00:00:00Z'), limit: 10 });
    expect(await settled(schedule.id)).toEqual([[0, amt('40')]]);
    expect(await ledger.getTxByKey(`bank.transfer.sched:${schedule.id}:0`)).not.toBeNull();
  });

  it('a schedule that already ran cannot change cadence', async () => {
    const { schedule } = await standing('monthly', new Date('2026-01-01T09:00:00Z'));
    await bank.transfers.runDueTransfers({ now: new Date('2026-01-02T00:00:00Z'), limit: 10 });
    await expect(
      bank.scheduleEdits!.update({
        scheduleId: schedule.id,
        userId: USER,
        revision: 0,
        cadence: 'once',
        now: new Date('2026-01-02T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_conflict' });
  });
});
