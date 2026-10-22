/**
 * BK-xfer-10 DR6 (957bd5cae): M1 the approval is re-checked against the LOCKED run before posting; M2 a paused retry
 * refuses with the runner's own code; minor 1 the retry adopt path records the booked amount. Postgres-hard.
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
import { PAUSED_SKIP_REASON } from './transfer-service.js';
import { scheduleRetryApprovalConsumer, scheduleRetryPayloadHash, type ScheduleRetryApprovalConsumer } from './schedule-retry-approval.js';

const USER = '11111111-1111-4111-8111-111111111111';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('DR6 operator retry (Postgres, ledger in refuse mode)', () => {
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
    await sql`TRUNCATE bank.schedule_retry_audit, bank.schedule_edits, bank.transfer_executions, bank.scheduled_transfers RESTART IDENTITY CASCADE`;
    await sql`UPDATE bank.spaces SET archived_at = NULL, locked_until = NULL`;
    ledger = new MemoryLedger({ idempotencyConflict: 'refuse' });
  });

  type Consumed = { status: string; requesterId: string; approverId: string | null };
  function stub(answer: Consumed | Error) {
    const calls: Array<Parameters<ScheduleRetryApprovalConsumer['consume']>[0]> = [];
    const consumer: ScheduleRetryApprovalConsumer = {
      async consume(input) {
        calls.push(input);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { consumer, calls };
  }
  const services = (approvals: ScheduleRetryApprovalConsumer | null) =>
    createBankServices(sql, ledger, memoryLedgerHistory(ledger), { scheduleEditCutoffMinutes: 60, scheduleRetryApprovals: approvals });

  async function rejectedRun(b: ReturnType<typeof createBankServices>) {
    const primary = await b.spaces.ensurePrimary(USER, 'USDT');
    const rent = await b.spaces.create({ userId: USER, assetId: 'USDT', name: `Rent ${randomUUID().slice(0, 6)}` });
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    const schedule = await b.transfers.schedule({
      scheduleId: randomUUID(),
      userId: USER,
      fromSpaceId: primary.id,
      toSpaceId: rent.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt: new Date('2026-01-01T09:00:00Z'),
    });
    await sql`INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code)
              VALUES (${schedule.id}, 0, 100, 'rejected', 'ledger.insufficient_funds')`;
    return schedule;
  }
  const NOW = new Date('2026-01-05T00:00:00Z');
  const req = (scheduleId: string) => ({
    scheduleId,
    occurrence: 0,
    reason: 'customer topped up, retry January rent',
    actorId: 'op-actor',
    approvalId: `ap-${randomUUID()}`,
    operationId: 'op-1',
    now: NOW,
  });
  const key = (id: string) => `bank.transfer.sched:${id}:0`;

  it('M1: the run changing between the approval read and the lock refuses bank.schedule_retry_approval_stale; nothing posts or audits', async () => {
    let scheduleId = '';
    const consumer: ScheduleRetryApprovalConsumer = {
      async consume() {
        // The race: after svc-bank read the run and bound the approval, something rewrites the stored amount.
        await sql`UPDATE bank.transfer_executions SET amount = 150 WHERE schedule_id = ${scheduleId} AND occurrence = 0`;
        return { status: 'CONSUMED', requesterId: 'op-proposer', approverId: 'op-approver' };
      },
    };
    const b = services(consumer);
    const s = await rejectedRun(b);
    scheduleId = s.id;
    await expect(b.scheduleRetryDesk!.retry(req(s.id))).rejects.toMatchObject({ code: 'bank.schedule_retry_approval_stale' });
    expect(await ledger.getTxByKey(key(s.id))).toBeNull();
    expect(await sql`SELECT 1 FROM bank.schedule_retry_audit`).toHaveLength(0);
  });

  it('M1: a status change under the lock (settled by the runner meanwhile) also refuses as stale', async () => {
    let scheduleId = '';
    const consumer: ScheduleRetryApprovalConsumer = {
      async consume() {
        await sql`UPDATE bank.transfer_executions SET status = 'pending', rejection_code = NULL WHERE schedule_id = ${scheduleId} AND occurrence = 0`;
        return { status: 'CONSUMED', requesterId: 'op-proposer', approverId: 'op-approver' };
      },
    };
    const b = services(consumer);
    const s = await rejectedRun(b);
    scheduleId = s.id;
    await expect(b.scheduleRetryDesk!.retry(req(s.id))).rejects.toMatchObject({ code: 'bank.schedule_retry_approval_stale' });
    expect(await ledger.getTxByKey(key(s.id))).toBeNull();
  });

  it('M2: the retry refuses a paused schedule with exactly the code the runner records (PAUSED_SKIP_REASON)', async () => {
    const b = services({
      async consume() {
        return { status: 'CONSUMED', requesterId: 'op-proposer', approverId: 'op-approver' };
      },
    });
    const s = await rejectedRun(b);
    await b.transfers.pauseSchedule(s.id);
    const err = await b.scheduleRetryDesk!.retry(req(s.id)).catch((e: { code: string }) => e);
    const direct = await b.scheduleRetry!.retry({ scheduleId: s.id, occurrence: 0, now: NOW }).catch((e: { code: string }) => e);
    expect(PAUSED_SKIP_REASON).toBe('bank.schedule_paused');
    expect((err as { code: string }).code).toBe(PAUSED_SKIP_REASON);
    expect((direct as { code: string }).code).toBe(PAUSED_SKIP_REASON);
    expect(await ledger.getTxByKey(key(s.id))).toBeNull();
  });

  it('minor 1: the retry adopt path records the BOOKED amount, not the stored one (record == movement)', async () => {
    const b = services(null);
    const s = await rejectedRun(b);
    const sched = await b.transfers.getSchedule(s.id);
    const from = await b.spaces.get(sched.fromSpaceId);
    const to = await b.spaces.get(sched.toSpaceId);
    const booked = await ledger.post(
      recipes.bankTransfer({
        transferId: s.id,
        occurrence: 0,
        from: accountForSpace(from),
        to: accountForSpace(to),
        amount: amt('120'),
        kind: 'scheduled',
        keySpace: 'sched',
      }),
    );
    expect(await b.scheduleRetry!.retry({ scheduleId: s.id, occurrence: 0, now: NOW })).toMatchObject({
      status: 'settled',
      ledgerTxId: booked.id,
      adopted: true,
    });
    const [row] = await sql<Array<{ amount: string }>>`SELECT amount::text FROM bank.transfer_executions WHERE schedule_id = ${s.id}`;
    expect(amt(row!.amount)).toBe(amt('120'));
  });
});
