/**
 * BK-xfer-10 review #6 and #8: the operator retry uses the runner's exact product gates and refuses a stopped schedule;
 * a fresh claim adopts a key the ledger already booked (crash after post) with ITS amount. Postgres-hard: no skip.
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

const USER = '11111111-1111-4111-8111-111111111111';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('operator retry gates and crash-after-post adoption (Postgres, ledger in refuse mode)', () => {
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
    await sql`UPDATE bank.spaces SET archived_at = NULL, locked_until = NULL`;
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
    await sql`INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code)
              VALUES (${schedule.id}, 0, 100, 'rejected', 'ledger.insufficient_funds')`;
    return { schedule, primary, rent };
  }
  const key = (id: string) => `bank.transfer.sched:${id}:0`;
  const run0 = async (id: string) =>
    (
      await sql<Array<{ status: string; rejection_code: string | null; amount: string }>>`
      SELECT status, rejection_code, amount::text FROM bank.transfer_executions WHERE schedule_id = ${id} AND occurrence = 0`
    )[0];
  const NOW = new Date('2026-01-05T00:00:00Z');

  it('retry refuses a debit space the user LOCKED (rent-lock drain): no post, run stays rejected with the code', async () => {
    const { schedule, primary } = await standing(new Date('2026-01-01T09:00:00Z'));
    await sql`UPDATE bank.spaces SET locked_until = ${new Date('2026-06-01T00:00:00Z')} WHERE id = ${primary.id}`;
    expect(await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 0, now: NOW })).toMatchObject({
      status: 'rejected',
      rejectionCode: 'bank.space_locked',
    });
    expect(await ledger.getTxByKey(key(schedule.id))).toBeNull();
    expect(await run0(schedule.id)).toMatchObject({ status: 'rejected', rejection_code: 'bank.space_locked' });
  });

  it('retry refuses an ARCHIVED debit space', async () => {
    const { schedule, primary } = await standing(new Date('2026-01-01T09:00:00Z'));
    await sql`UPDATE bank.spaces SET archived_at = now() WHERE id = ${primary.id}`;
    expect(await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 0, now: NOW })).toMatchObject({
      status: 'rejected',
      rejectionCode: 'bank.space_archived',
    });
    expect(await ledger.getTxByKey(key(schedule.id))).toBeNull();
  });

  it('retry refuses an ARCHIVED recipient space (credit side gated too)', async () => {
    const { schedule, rent } = await standing(new Date('2026-01-01T09:00:00Z'));
    await sql`UPDATE bank.spaces SET archived_at = now() WHERE id = ${rent.id}`;
    const r = await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 0, now: NOW }).catch((e: { code: string }) => e);
    expect(await ledger.getTxByKey(key(schedule.id))).toBeNull();
    expect(r).toBeTruthy();
    expect((await run0(schedule.id))?.status).toBe('rejected');
  });

  it('retry refuses a CANCELLED schedule and a PAUSED one (bank.schedule_inactive / bank.schedule_paused, DR6 M2); nothing posts', async () => {
    expect.assertions(4);
    for (const status of ['cancelled', 'paused']) {
      const { schedule } = await standing(new Date('2026-01-01T09:00:00Z'));
      await sql`UPDATE bank.scheduled_transfers SET status = ${status} WHERE id = ${schedule.id}`;
      await expect(bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 0, now: NOW })).rejects.toMatchObject({
        code: status === 'paused' ? 'bank.schedule_paused' : 'bank.schedule_inactive',
      });
      expect(await ledger.getTxByKey(key(schedule.id))).toBeNull();
    }
  });

  it('a cancelled schedule whose key is ALREADY booked is recorded settled (adopt, no new money)', async () => {
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
    await sql`UPDATE bank.scheduled_transfers SET status = 'cancelled' WHERE id = ${schedule.id}`;
    expect(await bank.scheduleRetry!.retry({ scheduleId: schedule.id, occurrence: 0, now: NOW })).toMatchObject({
      status: 'settled',
      ledgerTxId: booked.id,
      adopted: true,
    });
  });

  it('crash after post (no run row, key booked at 100), then edited to 150: the next claim adopts the booking at 100', async () => {
    const { schedule, primary, rent } = await standing(new Date('2026-01-01T09:00:00Z'));
    await sql`DELETE FROM bank.transfer_executions WHERE schedule_id = ${schedule.id}`;
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
    await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 10 });
    const rows = await sql<Array<{ status: string; amount: string; ledger_tx_id: string }>>`
      SELECT status, amount::text, ledger_tx_id FROM bank.transfer_executions WHERE schedule_id = ${schedule.id} AND occurrence = 0`;
    expect(rows[0]).toMatchObject({ status: 'settled', ledger_tx_id: booked.id });
    expect(amt(rows[0]!.amount)).toBe(amt('100'));
  });
});
