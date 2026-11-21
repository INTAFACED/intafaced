/**
 * The risk desk's halt of one live strategy or of every one (J-algo-dev-11; halts.ts). Real Postgres via
 * TEST_DATABASE_URL. One operator halts one strategy with an audit row naming them; halting every strategy and every
 * restore wait as a request until a second founder confirms, which consumes the approval once.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { principalFor } from '../../spot/testing.js';
import { MemoryApprovalBook, payloadHash, TradeOpsError } from '../../admin/common.js';
import { StrategyHaltDesk, actionTypeOf, expectedVersionOf, haltApprovalPayload, type HaltOp } from './halts.js';
import { SqlLiveRunStore } from './sql-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const A = '33333333-3333-4333-8333-3333333333a1';
const B = '44444444-4444-4444-8444-4444444444b2';
const founder = (id: string) => principalFor(id, ['admin:read', 'admin:write']);
const P1 = 'person-1';
const P2 = 'person-2';

let n = 0;
const id = () => {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
const hex = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

async function refusedCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(TradeOpsError);
    return (error as TradeOpsError).code;
  }
  throw new Error('expected a refusal');
}

describe('halt one strategy or every strategy (J-algo-dev-11)', () => {
  let db: TestDatabase;
  let book: MemoryApprovalBook;
  let desk: StrategyHaltDesk;
  let store: SqlLiveRunStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  async function run(userId: string, strategyId: string, state: 'running' | 'stopped' = 'running') {
    const runId = id();
    n += 1;
    await store.insertOnce({
      userId,
      runId,
      strategyId,
      strategyVersion: 2,
      strategyName: `TEST ${strategyId}`,
      venueId: 'test-venue',
      region: 'DE',
      owner: hex(n),
      subAccount: hex(n + 1000),
      agentAddress: hex(n + 2000),
      asset: 'USDC',
      cap: parseAmount('100'),
      plan: [],
      restartAttempts: 1,
      statePolicy: 'keep',
      liveControl: true,
      state,
      endReason: state === 'stopped' ? 'user_stop' : null,
      permission: 'active',
      restarts: 0,
      nextSeq: 1,
      strategyState: { ticks: 0 },
      heartbeatAt: null,
      createdAt: new Date(Date.now() + n),
      startedAt: null,
      stoppedAt: null,
      stopSeq: null,
    });
    return runId;
  }

  /** Founder A files identity's approval for a request and records it; founder B approves it in identity. */
  async function ask(op: HaltOp, haltId: string | null, reason: string) {
    const requestId = id();
    const approvalId = `approval-${requestId}`;
    const request = await desk.propose(founder(A), { requestId, op, haltId, reason, approvalId });
    book.put({
      approvalId,
      actionType: actionTypeOf(op),
      targetService: 'svc-trade',
      targetId: requestId,
      expectedVersion: expectedVersionOf(op, haltId),
      payloadHash: payloadHash(haltApprovalPayload({ requestId, op, haltId, reason })),
      requesterId: A,
      approverId: B,
    });
    return request;
  }

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_audit, trade.quant_live_halts, trade.quant_live_halt_requests,
      trade.quant_live_run_events, trade.quant_live_run_orders, trade.quant_live_runs RESTART IDENTITY CASCADE`;
    book = new MemoryApprovalBook();
    desk = new StrategyHaltDesk({ sql: db.sql, approvals: book, now: () => new Date() });
    store = new SqlLiveRunStore(db.sql);
  });

  it('lists every run with owner, state and version; one operator halts one strategy with an audit row naming them', async () => {
    const r1 = await run(P1, 's1');
    await run(P2, 's2');
    await run(P2, 's3', 'stopped');
    let view = await desk.desk(founder(A));
    expect(view.runs).toHaveLength(3);
    expect(view.runs.find((r) => r.runId === r1)).toMatchObject({
      userId: P1,
      strategyId: 's1',
      strategyVersion: 2,
      state: 'running',
      halt: null,
    });
    expect(view.counts).toEqual({ runs: 3, live: 2, haltedLive: 0 });

    const requestId = id();
    const halt = await desk.halt(founder(A), { requestId, userId: P1, strategyId: 's1', reason: 'TEST risk review' });
    expect(halt).toMatchObject({ userId: P1, strategyId: 's1', scope: 'one', haltedBy: A });
    // The same request again is the same halt; another halt of it refuses.
    expect((await desk.halt(founder(A), { requestId, userId: P1, strategyId: 's1', reason: 'TEST risk review' })).id).toBe(halt.id);
    expect(await refusedCode(desk.halt(founder(A), { requestId: id(), userId: P1, strategyId: 's1', reason: 'again' }))).toBe(
      'quant_halt_already_halted',
    );
    expect(await refusedCode(desk.halt(founder(A), { requestId: id(), userId: P1, strategyId: 'none', reason: 'TEST' }))).toBe(
      'quant_halt_strategy_not_found',
    );
    expect((await desk.haltOf(P1, 's1'))?.id).toBe(halt.id);
    expect(await desk.haltOf(P2, 's2')).toBeNull();
    view = await desk.desk(founder(A));
    expect(view.counts.haltedLive).toBe(1);
    expect(view.audit).toMatchObject([{ kind: 'quant_live.halt', operatorId: A, accountId: P1, reason: 'TEST risk review' }]);
    // A reader can't halt.
    await expect(
      desk.halt(principalFor(A, ['admin:read']), { requestId: id(), userId: P2, strategyId: 's2', reason: 'TEST' }),
    ).rejects.toThrow();
  });

  it('halt-all stays a request until a second founder confirms; then every live run halts and the count is answered', async () => {
    await run(P1, 's1');
    await run(P2, 's2');
    await run(P2, 's2');
    await desk.halt(founder(A), { requestId: id(), userId: P1, strategyId: 's1', reason: 'TEST earlier halt' });
    const request = await ask('halt_all', null, 'TEST halt every strategy');
    expect(request.status).toBe('awaiting_second');
    expect(await desk.haltOf(P2, 's2')).toBeNull();
    expect((await desk.desk(founder(A))).waiting.map((w) => w.id)).toEqual([request.id]);
    // The founder who asked cannot confirm.
    expect(await refusedCode(desk.confirm(founder(A), { requestId: request.id, operationId: 'op' }))).toBe('approval_mismatch');
    expect(await desk.haltOf(P2, 's2')).toBeNull();

    const done = await desk.confirm(founder(B), { requestId: request.id, operationId: 'op' });
    expect(done).toMatchObject({ status: 'applied', approverId: B, confirmedBy: B, appliedRuns: 3, appliedStrategies: 1 });
    expect(await desk.haltOf(P2, 's2')).toMatchObject({ scope: 'all', haltedBy: A, haltApprover: B });
    // s1 keeps its own halt.
    expect((await desk.haltOf(P1, 's1'))?.scope).toBe('one');
    const view = await desk.desk(founder(A));
    expect(view.counts).toEqual({ runs: 3, live: 3, haltedLive: 3 });
    expect(view.audit[0]).toMatchObject({ kind: 'quant_live.halt_all', operatorId: A, approverId: B, detail: { runs: 3 } });
    // The same confirm again answers the applied request; the approval is spent.
    expect((await desk.confirm(founder(B), { requestId: request.id, operationId: 'op' })).status).toBe('applied');
  });

  it('a restore needs the same two-person rule and writes an audit row; restore-all lifts every halt', async () => {
    await run(P1, 's1');
    await run(P2, 's2');
    const halt = await desk.halt(founder(A), { requestId: id(), userId: P1, strategyId: 's1', reason: 'TEST risk review' });
    const request = await ask('restore', halt.id, 'TEST cleared');
    expect(await desk.haltOf(P1, 's1')).not.toBeNull();
    expect(await refusedCode(desk.confirm(founder(A), { requestId: request.id, operationId: 'op' }))).toBe('approval_mismatch');
    // An approval the asker gave themself is refused too.
    const self = id();
    await desk.propose(founder(B), {
      requestId: self,
      op: 'restore',
      haltId: halt.id,
      reason: 'TEST self',
      approvalId: `approval-${self}`,
    });
    book.put({
      approvalId: `approval-${self}`,
      actionType: actionTypeOf('restore'),
      targetService: 'svc-trade',
      targetId: self,
      expectedVersion: expectedVersionOf('restore', halt.id),
      payloadHash: payloadHash(haltApprovalPayload({ requestId: self, op: 'restore', haltId: halt.id, reason: 'TEST self' })),
      requesterId: B,
      approverId: B,
    });
    expect(await refusedCode(desk.confirm(founder(A), { requestId: self, operationId: 'op' }))).toBe('approval_mismatch');

    const done = await desk.confirm(founder(B), { requestId: request.id, operationId: 'op' });
    expect(done).toMatchObject({ status: 'applied', appliedRuns: 1, appliedStrategies: 1 });
    expect(await desk.haltOf(P1, 's1')).toBeNull();
    const audit = (await desk.desk(founder(A))).audit;
    expect(audit[0]).toMatchObject({ kind: 'quant_live.restore', operatorId: A, approverId: B, accountId: P1, objectId: 'strategy:s1' });
    // Restoring what no longer stands refuses before anything is filed.
    expect(
      await refusedCode(desk.propose(founder(A), { requestId: id(), op: 'restore', haltId: halt.id, reason: 'TEST', approvalId: 'x' })),
    ).toBe('quant_halt_not_halted');

    const all = await ask('halt_all', null, 'TEST every strategy');
    await desk.confirm(founder(B), { requestId: all.id, operationId: 'op' });
    const back = await ask('restore_all', null, 'TEST all clear');
    expect((await desk.confirm(founder(B), { requestId: back.id, operationId: 'op' })).appliedStrategies).toBe(2);
    expect((await desk.desk(founder(A))).halts).toEqual([]);
  });
});
