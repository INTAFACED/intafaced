import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustodyTaskExecutionError } from './errors.js';
import { CustodyApprovalService, payloadHashOf, type TaskExecution } from './service.js';

/** Custody approval tasks, the admin quorum and the approver registry against a real Postgres. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_custody_tasks_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-initiator';
const A1 = 'approver-1';
const A2 = 'approver-2';
const A3 = 'approver-3';
const OUTSIDER = 'not-registered';
const PAYLOAD = { vault: 'v-1', network: 'ethereum', to: '0x1111111111111111111111111111111111111111', amount: '1' };

describe('custody approval tasks (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let clock: Date;
  let ran: TaskExecution[];
  let fault: (() => Error | null) | null;
  let service: CustodyApprovalService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(() => {
    clock = new Date();
    ran = [];
    fault = null;
    service = build();
  });

  const build = (over: Partial<ConstructorParameters<typeof CustodyApprovalService>[0]> = {}) =>
    new CustodyApprovalService({
      sql: db.sql,
      now: () => clock,
      transactionExecutor: async (t) => {
        const f = fault?.();
        if (f) throw f;
        ran.push(t);
      },
      configAppliers: {
        policy: async (t) => {
          ran.push(t);
        },
      },
      ...over,
    });

  // Pending tasks from other tests would show in `pending`/`list`; each test uses refs of its own and filters by them.
  let n = 0;
  const ref = () => `task-${Date.now()}-${++n}`;
  const setUp = async (required = 2, expirySeconds = 600) => {
    await service.setQuorum('owner', { kind: 'custody_transaction', requiredApprovals: required, expirySeconds });
    await service.setQuorum('owner', { kind: 'config', requiredApprovals: required, expirySeconds });
    for (const [id, role] of [
      [A1, 'founder'],
      [A2, 'keyless'],
      [A3, 'founder'],
    ] as const) {
      await service.registerApprover('owner', { userId: id, label: id, role });
    }
  };
  const start = (over: Partial<{ payload: Record<string, unknown>; clientRef: string }> = {}) =>
    service.initiate(FOUNDER, { title: 'Send 1 ETH', payload: PAYLOAD, clientRef: ref(), ...over });

  it('a blank quorum refuses, and nothing wired to run the task refuses too', async () => {
    // TRUNCATE is not an UPDATE or DELETE, so it clears the append-only history for a state with no quorum ever set.
    await db.sql`TRUNCATE pay.custody_task_quorum_events`;
    await expect(start()).rejects.toMatchObject({ code: 'custody_approval.quorum_unset' });
    await expect(service.proposeConfig(FOUNDER, { scope: 'policy', title: 't', payload: {}, clientRef: ref() })).rejects.toMatchObject({
      code: 'custody_approval.quorum_unset',
    });
    expect(await service.quorum('config')).toBeNull();
    await expect(
      build({ transactionExecutor: undefined }).initiate(FOUNDER, { title: 't', payload: PAYLOAD, clientRef: ref() }),
    ).rejects.toMatchObject({ code: 'custody_approval.executor_unwired' });
    await expect(service.proposeConfig(FOUNDER, { scope: 'users', title: 't', payload: {}, clientRef: ref() })).rejects.toMatchObject({
      code: 'custody_approval.executor_unwired',
      detail: { scope: 'users' },
    });
  });

  it('the initiator cannot approve or reject their own task, even when registered', async () => {
    await setUp();
    await service.registerApprover('owner', { userId: FOUNDER, label: 'initiator', role: 'founder' });
    const task = await start();
    await expect(service.approve(FOUNDER, task.id, task.payloadHash)).rejects.toMatchObject({
      code: 'custody_approval.initiator_cannot_decide',
    });
    await expect(service.reject(FOUNDER, task.id, task.payloadHash)).rejects.toMatchObject({
      code: 'custody_approval.initiator_cannot_decide',
    });
    expect((await service.get(FOUNDER, task.id)).approvalCount).toBe(0);
  });

  it('runs only at quorum: one approval waits, the second runs it once under the task key', async () => {
    await setUp(2);
    const task = await start();
    expect(task).toMatchObject({ status: 'pending', requiredApprovals: 2, kind: 'custody_transaction', initiator: FOUNDER });
    expect(task.payloadHash).toBe(payloadHashOf('custody_transaction', null, PAYLOAD));
    const one = await service.approve(A1, task.id, task.payloadHash);
    expect(one).toMatchObject({ status: 'pending', approvalCount: 1, approvedByMe: true });
    expect(ran).toHaveLength(0);
    const two = await service.approve(A2, task.id, task.payloadHash);
    expect(two).toMatchObject({ status: 'executed', approvalCount: 2 });
    expect(two.executedAt).not.toBeNull();
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ idempotencyKey: `custody-task:${task.id}`, payload: PAYLOAD, taskId: task.id });
    // A later approve of a finished task runs nothing again.
    await service.approve(A3, task.id, task.payloadHash);
    expect(ran).toHaveLength(1);
  });

  it('the same person approving twice counts once', async () => {
    await setUp(2);
    const task = await start();
    await service.approve(A1, task.id, task.payloadHash);
    const again = await service.approve(A1, task.id, task.payloadHash);
    expect(again).toMatchObject({ status: 'pending', approvalCount: 1 });
    expect(ran).toHaveLength(0);
  });

  it('only an active registered approver counts; a revoked one does not', async () => {
    await setUp(1);
    const task = await start();
    await expect(service.approve(OUTSIDER, task.id, task.payloadHash)).rejects.toMatchObject({
      code: 'custody_approval.approver_not_registered',
    });
    await service.revokeApprover('owner', A1);
    await expect(service.approve(A1, task.id, task.payloadHash)).rejects.toMatchObject({
      code: 'custody_approval.approver_not_registered',
    });
    expect((await service.listApprovers()).find((a) => a.userId === A1)).toMatchObject({ active: false });
    await service.registerApprover('owner', { userId: A1, label: A1, role: 'founder' });
    expect((await service.listApprovers()).find((a) => a.userId === A1)).toMatchObject({ active: true });
    await expect(service.revokeApprover('owner', 'nobody')).rejects.toMatchObject({ code: 'custody_approval.approver_unknown' });
  });

  it('an approver revoked after approving no longer counts toward quorum', async () => {
    await setUp(2);
    const task = await start();
    await service.approve(A1, task.id, task.payloadHash);
    await service.revokeApprover('owner', A1);
    const second = await service.approve(A2, task.id, task.payloadHash);
    expect(second).toMatchObject({ status: 'pending', approvalCount: 1 });
    expect(ran).toHaveLength(0);
    await service.approve(A3, task.id, task.payloadHash);
    expect(ran).toHaveLength(1);
  });

  it('the payload hash binds the task: a wrong hash is refused, a changed payload is a new task', async () => {
    await setUp();
    const a = await start({ clientRef: 'bind-a' });
    await expect(service.approve(A1, a.id, 'f'.repeat(64))).rejects.toMatchObject({ code: 'custody_approval.hash_mismatch' });
    const b = await start({ clientRef: 'bind-b', payload: { ...PAYLOAD, amount: '2' } });
    expect(b.payloadHash).not.toBe(a.payloadHash);
    await expect(service.approve(A1, a.id, b.payloadHash)).rejects.toMatchObject({ code: 'custody_approval.hash_mismatch' });
    // The same reference with a changed payload is refused, not overwritten.
    await expect(start({ clientRef: 'bind-a', payload: { ...PAYLOAD, amount: '9' } })).rejects.toMatchObject({
      code: 'custody_approval.conflict',
    });
    expect((await start({ clientRef: 'bind-a' })).id).toBe(a.id);
    // The initiator who made the task is the only one who may reuse its reference.
    await expect(service.initiate('someone-else', { title: 't', payload: PAYLOAD, clientRef: 'bind-a' })).rejects.toMatchObject({
      code: 'custody_approval.conflict',
    });
  });

  it('one rejection ends the task, and nothing runs', async () => {
    await setUp(2);
    const task = await start();
    await service.approve(A1, task.id, task.payloadHash);
    const rejected = await service.reject(A2, task.id, task.payloadHash);
    expect(rejected.status).toBe('rejected');
    await expect(service.approve(A3, task.id, task.payloadHash)).rejects.toMatchObject({ code: 'custody_approval.not_pending' });
    expect(ran).toHaveLength(0);
  });

  it('expiry ends a waiting task as expired, not executed, and an approval after the deadline is refused', async () => {
    await setUp(2, 60);
    const task = await start();
    await service.approve(A1, task.id, task.payloadHash);
    clock = new Date(clock.getTime() + 61_000);
    await expect(service.approve(A2, task.id, task.payloadHash)).rejects.toMatchObject({ code: 'custody_approval.expired' });
    expect((await service.get(A1, task.id)).status).toBe('expired');
    expect(ran).toHaveLength(0);
    // The sweep expires one nobody touched.
    const other = await start();
    clock = new Date(clock.getTime() + 61_000);
    const result = await service.settleDue('system');
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await service.get(A1, other.id)).status).toBe('expired');
    expect((await service.settleDue('system')).expired).toBe(0); // idempotent
  });

  it('an approved task never expires: a crash before the run resumes with the same key, once', async () => {
    await setUp(1, 60);
    const task = await start();
    fault = () => new CustodyTaskExecutionError('rail.timeout', 'unknown outcome', true);
    await expect(service.approve(A1, task.id, task.payloadHash)).rejects.toMatchObject({ code: 'rail.timeout' });
    expect((await service.get(A1, task.id)).status).toBe('approved');
    clock = new Date(clock.getTime() + 3_600_000);
    fault = null;
    const settled = await service.settleDue('system');
    expect(settled.executed).toBeGreaterThanOrEqual(1);
    expect((await service.get(A1, task.id)).status).toBe('executed');
    expect(ran.filter((r) => r.taskId === task.id)).toHaveLength(1);
    expect(ran[0]!.idempotencyKey).toBe(`custody-task:${task.id}`);
    await service.settleDue('system');
    expect(ran.filter((r) => r.taskId === task.id)).toHaveLength(1);
  });

  it('a refused execution ends the task failed with its code, and is not run again', async () => {
    await setUp(1);
    const task = await start();
    fault = () => new CustodyTaskExecutionError('wallet.policy_refused', 'no');
    await expect(service.approve(A1, task.id, task.payloadHash)).rejects.toMatchObject({ code: 'wallet.policy_refused' });
    expect(await service.get(A1, task.id)).toMatchObject({ status: 'failed', failureCode: 'wallet.policy_refused' });
    fault = null;
    await service.settleDue('system');
    expect(ran).toHaveLength(0);
  });

  it('only the initiator cancels, and only while the task waits', async () => {
    await setUp(2);
    const task = await start();
    await expect(service.cancel(A1, task.id)).rejects.toMatchObject({ code: 'custody_approval.not_found' });
    expect((await service.cancel(FOUNDER, task.id)).status).toBe('canceled');
    await expect(service.approve(A1, task.id, task.payloadHash)).rejects.toMatchObject({ code: 'custody_approval.not_pending' });
    await expect(service.cancel(FOUNDER, task.id)).resolves.toMatchObject({ status: 'canceled' });
    const done = await start();
    await service.approve(A1, done.id, done.payloadHash);
    await service.approve(A2, done.id, done.payloadHash);
    await expect(service.cancel(FOUNDER, done.id)).rejects.toMatchObject({ code: 'custody_approval.not_pending' });
  });

  it('keeps a per-reviewer timeline in order', async () => {
    await setUp(2);
    const task = await start();
    await service.approve(A1, task.id, task.payloadHash);
    await service.approve(A2, task.id, task.payloadHash);
    const detail = await service.get(A3, task.id);
    expect(detail.timeline.map((e) => [e.kind, e.actor])).toEqual([
      ['initiated', FOUNDER],
      ['approved', A1],
      ['approved', A2],
      ['quorum', A2],
      ['executed', 'system'],
    ]);
  });

  it('config changes need an applier for the scope, run through it once, and cannot be decided as a transaction task', async () => {
    await setUp(2);
    const change = await service.proposeConfig(FOUNDER, {
      scope: 'policy',
      title: 'Raise limit',
      payload: { rule: 'r1' },
      clientRef: ref(),
    });
    expect(change).toMatchObject({ kind: 'config', scope: 'policy' });
    await expect(service.approve(A1, change.id, change.payloadHash, 'custody_transaction')).rejects.toMatchObject({
      code: 'custody_approval.wrong_kind',
    });
    await service.approve(A1, change.id, change.payloadHash, 'config');
    await service.approve(A2, change.id, change.payloadHash, 'config');
    expect((await service.get(A1, change.id)).status).toBe('executed');
    expect(ran).toMatchObject([{ kind: 'config', scope: 'policy', payload: { rule: 'r1' } }]);
    await expect(service.proposeConfig(FOUNDER, { scope: 'users', title: 't', payload: {}, clientRef: ref() })).rejects.toMatchObject({
      code: 'custody_approval.executor_unwired',
    });
  });

  it('the key-less approver sees what they may decide, and nothing they already decided or started', async () => {
    await setUp(2);
    const mine = await start();
    const theirs = await service.initiate(A2, { title: 'by approver 2', payload: { ...PAYLOAD, amount: '3' }, clientRef: ref() });
    await service.approve(A1, mine.id, mine.payloadHash);
    const forA1 = (await service.pending(A1, { limit: 200 })).map((t) => t.id);
    expect(forA1).not.toContain(mine.id); // already decided
    expect(forA1).toContain(theirs.id);
    const forA2 = (await service.pending(A2, { limit: 200 })).map((t) => t.id);
    expect(forA2).toContain(mine.id);
    expect(forA2).not.toContain(theirs.id); // their own
    await expect(service.pending(OUTSIDER, { limit: 5 })).rejects.toMatchObject({ code: 'custody_approval.approver_not_registered' });
    await expect(service.pending(A1, {})).rejects.toMatchObject({ code: 'custody_approval.list_limit_unset' });
  });

  it('lists by status and kind with a required bound', async () => {
    await setUp(1);
    const task = await start();
    await expect(service.list(A1, {})).rejects.toMatchObject({ code: 'custody_approval.list_limit_unset' });
    const waiting = await service.list(A1, { status: 'pending', kind: 'custody_transaction', limit: 200 });
    expect(waiting.map((t) => t.id)).toContain(task.id);
    expect((await service.list(A1, { status: 'executed', limit: 200 })).map((t) => t.id)).not.toContain(task.id);
  });

  it('two approvals landing together run the task once', async () => {
    await setUp(2);
    const task = await start();
    await Promise.allSettled([service.approve(A1, task.id, task.payloadHash), service.approve(A2, task.id, task.payloadHash)]);
    await service.settleDue('system');
    expect(ran.filter((r) => r.taskId === task.id)).toHaveLength(1);
    expect((await service.get(A1, task.id)).status).toBe('executed');
  });

  it('history is append-only', async () => {
    await setUp();
    await expect(db.sql`UPDATE pay.custody_task_quorum_events SET required_approvals = 1`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM pay.custody_approver_events`).rejects.toThrow(/append-only/);
    await expect(db.sql`DELETE FROM pay.custody_task_events`).rejects.toThrow(/append-only/);
  });
});
