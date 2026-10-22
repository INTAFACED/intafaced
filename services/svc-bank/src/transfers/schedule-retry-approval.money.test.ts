/**
 * BK-xfer-10 review #7 and D89: four-eyes, audited operator retry; a paused schedule is skipped by the runner AND refused
 * by the retry. Identity is a stub consumer here (the real client is shared-secret createIdentityApprovalClient). Postgres-hard.
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
import { scheduleRetryApprovalConsumer, scheduleRetryPayloadHash, type ScheduleRetryApprovalConsumer } from './schedule-retry-approval.js';

const USER = '11111111-1111-4111-8111-111111111111';
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

describe('four-eyes operator retry (Postgres, ledger in refuse mode)', () => {
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
  const audits = async () => sql`SELECT * FROM bank.schedule_retry_audit`;

  it('unwired identity refuses bank.schedule_retry_approval_unwired: no post, no audit', async () => {
    const b = services(null);
    const s = await rejectedRun(b);
    await expect(b.scheduleRetryDesk!.retry(req(s.id))).rejects.toMatchObject({ code: 'bank.schedule_retry_approval_unwired' });
    expect(await ledger.getTxByKey(key(s.id))).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it('blank env builds no consumer (fail closed)', () => {
    expect(scheduleRetryApprovalConsumer(undefined, 's')).toBeNull();
    expect(scheduleRetryApprovalConsumer('http://identity', '')).toBeNull();
    expect(scheduleRetryApprovalConsumer(' ', 's')).toBeNull();
  });

  it('approved by a second person: consumes with the sha256 payload hash, settles once, writes one audit row', async () => {
    const { consumer, calls } = stub({ status: 'CONSUMED', requesterId: 'op-proposer', approverId: 'op-approver' });
    const b = services(consumer);
    const s = await rejectedRun(b);
    const input = req(s.id);
    const out = await b.scheduleRetryDesk!.retry(input);
    expect(out).toMatchObject({ status: 'settled', adopted: false });
    expect(calls).toEqual([
      {
        approvalId: input.approvalId,
        operationId: 'op-1',
        payloadHash: scheduleRetryPayloadHash(s.id, 0, '100', input.reason),
        targetService: 'svc-bank',
        targetId: `${s.id}:0`,
        expectedVersion: 'rejected:100',
      },
    ]);
    expect(calls[0]!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: 'op-actor',
      requester_id: 'op-proposer',
      approver_id: 'op-approver',
      approval_id: input.approvalId,
      reason: input.reason,
      outcome: 'settled',
      ledger_tx_id: out.ledgerTxId,
    });
  });

  it('refuses when the approver is the proposer, the actor, missing, or the approval is not CONSUMED', async () => {
    const answers: Consumed[] = [
      { status: 'CONSUMED', requesterId: 'op-a', approverId: 'OP-A' },
      { status: 'CONSUMED', requesterId: 'op-proposer', approverId: 'op-actor' },
      { status: 'CONSUMED', requesterId: 'op-proposer', approverId: null },
      { status: 'APPROVED', requesterId: 'op-proposer', approverId: 'op-approver' },
    ];
    for (const a of answers) {
      const b = services(stub(a).consumer);
      const s = await rejectedRun(b);
      await expect(b.scheduleRetryDesk!.retry(req(s.id))).rejects.toMatchObject({ code: 'bank.schedule_retry_approval_refused' });
      expect(await ledger.getTxByKey(key(s.id))).toBeNull();
    }
    expect(await audits()).toHaveLength(0);
  });

  it('identity throwing, or a blank reason, refuses with nothing posted', async () => {
    const b = services(stub(new Error('identity down')).consumer);
    const s = await rejectedRun(b);
    await expect(b.scheduleRetryDesk!.retry(req(s.id))).rejects.toMatchObject({ code: 'bank.schedule_retry_approval_refused' });
    const ok = services(stub({ status: 'CONSUMED', requesterId: 'p', approverId: 'q' }).consumer);
    await expect(ok.scheduleRetryDesk!.retry({ ...req(s.id), reason: '  ' })).rejects.toMatchObject({
      code: 'bank.schedule_retry_approval_refused',
    });
    expect(await ledger.getTxByKey(key(s.id))).toBeNull();
  });

  it('D89: the runner SKIPS a paused schedule, and the approved retry REFUSES it with bank.schedule_inactive', async () => {
    const b = services(stub({ status: 'CONSUMED', requesterId: 'op-proposer', approverId: 'op-approver' }).consumer);
    const s = await rejectedRun(b);
    await b.transfers.pauseSchedule(s.id);
    await b.transfers.runDueTransfers({ now: new Date('2026-03-05T00:00:00Z'), limit: 10 });
    const fired = await sql`SELECT occurrence FROM bank.transfer_executions WHERE schedule_id = ${s.id} AND status <> 'rejected'`;
    expect(fired).toHaveLength(0);
    expect(await ledger.getTxByKey(`bank.transfer.sched:${s.id}:1`)).toBeNull();
    await expect(b.scheduleRetryDesk!.retry(req(s.id))).rejects.toMatchObject({ code: 'bank.schedule_inactive' });
    expect(await ledger.getTxByKey(key(s.id))).toBeNull();
    expect(await audits()).toHaveLength(0);
  });
});
