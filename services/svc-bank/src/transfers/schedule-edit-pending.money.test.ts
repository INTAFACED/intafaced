/**
 * BK-xfer-10 review blocker 1: a pending run is re-driven with its STORED amount, and edits refuse while a run is
 * pending. MemoryLedger runs in its default `refuse` mode: a reused key with a different body throws
 * `ledger.idempotency_conflict`, the production behaviour. Postgres-hard: no skip.
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
import { accountForSpace } from '../spaces/space-service.js';
import { planDue } from './schedule.js';

const USER = '11111111-1111-4111-8111-111111111111';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('once window edge (pure)', () => {
  it('a once schedule whose end is at or before its start never fires and completes', () => {
    const start = new Date('2026-11-01T09:00:00Z');
    for (const endsAt of [start, new Date('2026-10-01T00:00:00Z')]) {
      expect(planDue({ startsAt: start, cadence: 'once', endsAt, lastFired: null, now: new Date('2027-01-01T00:00:00Z') })).toMatchObject({
        occurrences: [],
        completed: true,
      });
    }
  });

  it('suite is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(new RegExp('describe\\.skip' + 'If|\\bit\\.skip\\(|describe\\.skip\\('));
  });
});

describe('pending runs and edits (Postgres, ledger in refuse mode)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: ReturnType<typeof createBankServices>;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('schedule-edit-pending is Postgres-hard: TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE bank.schedule_edits, bank.transfer_executions, bank.scheduled_transfers RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { scheduleEditCutoffMinutes: 60 });
  });

  async function standing(startsAt: Date) {
    const primary = await bank.spaces.ensurePrimary(USER, 'USDT');
    const rent = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: `Rent ${randomUUID().slice(0, 6)}` });
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    const schedule = await bank.transfers.schedule({
      scheduleId: randomUUID(),
      userId: USER,
      fromSpaceId: primary.id,
      toSpaceId: rent.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt,
    });
    return { schedule, primary, rent };
  }

  /** A claim committed at 100, then the instruction moved to 150 (an edit that raced in before this fix). */
  async function pendingAt100ThenEdited(scheduleId: string) {
    await sql`INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status) VALUES (${scheduleId}, 0, 100, 'pending')`;
    await sql`UPDATE bank.scheduled_transfers SET amount = 150 WHERE id = ${scheduleId}`;
  }

  const runs = async (id: string) =>
    (
      await sql<Array<{ occurrence: number; amount: string; status: string; ledger_tx_id: string | null }>>`
      SELECT occurrence, amount::text, status, ledger_tx_id FROM bank.transfer_executions WHERE schedule_id = ${id} ORDER BY occurrence
    `
    ).map((r) => ({ ...r, amount: amt(r.amount) }));

  it('re-drive after an edit, post NOT booked: posts the stored 100, record equals movement', async () => {
    const { schedule } = await standing(new Date('2026-01-01T09:00:00Z'));
    await pendingAt100ThenEdited(schedule.id);
    await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 10 });
    const [run] = await runs(schedule.id);
    expect(run).toMatchObject({ status: 'settled', amount: amt('100') });
    const tx = await ledger.getTxByKey(`bank.transfer.sched:${schedule.id}:0`);
    expect(tx?.id).toBe(run!.ledger_tx_id);
    expect(tx!.entries.some((e) => e.amount === amt('100'))).toBe(true);
    expect(tx!.entries.some((e) => e.amount === amt('150'))).toBe(false);
  });

  it('re-drive after an edit, post ALREADY booked at 100: same body, no idempotency conflict, recorded settled', async () => {
    const { schedule, primary, rent } = await standing(new Date('2026-01-01T09:00:00Z'));
    const booked = await ledger.post(
      recipes.bankTransfer({
        transferId: schedule.id,
        occurrence: 0,
        from: accountForSpace(primary),
        to: accountForSpace(rent),
        amount: amt('100'),
        kind: 'scheduled',
        keySpace: 'sched',
      }),
    );
    await pendingAt100ThenEdited(schedule.id);
    await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 10 });
    expect((await runs(schedule.id))[0]).toMatchObject({ status: 'settled', amount: amt('100'), ledger_tx_id: booked.id });
  });

  it('an edit refuses with bank.schedule_run_pending while a run is pending, and applies after it settles', async () => {
    const { schedule } = await standing(new Date('2026-01-01T09:00:00Z'));
    await sql`INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status) VALUES (${schedule.id}, 0, 100, 'pending')`;
    const now = new Date('2025-12-01T00:00:00Z');
    await expect(
      bank.scheduleEdits!.update({ scheduleId: schedule.id, userId: USER, revision: 0, amount: amt('150'), now }),
    ).rejects.toMatchObject({
      code: 'bank.schedule_run_pending',
    });
    expect((await bank.transfers.getSchedule(schedule.id)).amount).toBe(amt('100'));
    await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 10 });
    const later = new Date('2026-01-02T00:00:00Z');
    const r = await bank.scheduleEdits!.update({ scheduleId: schedule.id, userId: USER, revision: 0, amount: amt('150'), now: later });
    expect(r.revision).toBe(1);
  });

  it('cutoff boundary: exactly at the cutoff is allowed, one ms inside refuses', async () => {
    const { schedule } = await standing(new Date('2030-01-01T09:00:00Z'));
    const next = new Date('2030-01-01T09:00:00Z').getTime();
    await expect(
      bank.scheduleEdits!.update({
        scheduleId: schedule.id,
        userId: USER,
        revision: 0,
        amount: amt('150'),
        now: new Date(next - 60 * 60_000 + 1),
      }),
    ).rejects.toMatchObject({ code: 'bank.schedule_cutoff' });
    const ok = await bank.scheduleEdits!.update({
      scheduleId: schedule.id,
      userId: USER,
      revision: 0,
      amount: amt('150'),
      now: new Date(next - 60 * 60_000),
    });
    expect(ok.revision).toBe(1);
  });

  it('operator retry adopts the existing post and its stored amount; a fresh retry posts the stored amount once', async () => {
    const { schedule, primary, rent } = await standing(new Date('2026-01-01T09:00:00Z'));
    await sql`INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code)
              VALUES (${schedule.id}, 0, 100, 'rejected', 'ledger.insufficient_funds'), (${schedule.id}, 1, 100, 'rejected', 'ledger.insufficient_funds')`;
    const booked = await ledger.post(
      recipes.bankTransfer({
        transferId: schedule.id,
        occurrence: 0,
        from: accountForSpace(primary),
        to: accountForSpace(rent),
        amount: amt('100'),
        kind: 'scheduled',
        keySpace: 'sched',
      }),
    );
    await sql`UPDATE bank.scheduled_transfers SET amount = 150 WHERE id = ${schedule.id}`;
    expect(await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 0 })).toEqual({
      status: 'settled',
      ledgerTxId: booked.id,
      adopted: true,
    });
    const fresh = await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 1 });
    expect(fresh).toMatchObject({ status: 'settled', adopted: false });
    const again = await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 1 });
    expect(again.ledgerTxId).toBe(fresh.ledgerTxId);
    expect((await runs(schedule.id)).map((r) => [r.status, r.amount])).toEqual([
      ['settled', amt('100')],
      ['settled', amt('100')],
    ]);
  });
});
