/**
 * OPS-reconciliation-01. Operator controls beside the three built-in proofs.
 * TEST amounts only. The result row is committed before a source is read.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { actionApprovalSchema, type Context } from '@intafaced/contracts';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db/testing';
import {
  OPS_CONTROL_MARGIN_UNSET,
  OPS_CONTROL_POLICY_UNSET,
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_BUILTIN_IMMUTABLE,
  LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
} from '@intafaced/contracts/ledger-reconciliation';
import { createLedgerRouter } from '../router.js';
import { registerOperatorHttp } from '../operator-http.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { withJournalGuardsOff } from '../db/journal-guards.testkit.js';
import { ReconciliationControlError } from './reconciliation-control-error.js';
import {
  defineReconciliationControl,
  listReconciliationControls,
  runDueReconciliationControls,
  runReconciliationControl,
  updateReconciliationControl,
  type ReconciliationSources,
  type SnapshotRead,
} from './reconciliation-controls.js';
import type { LedgerService } from '../service.js';

const URL = process.env.TEST_DATABASE_URL?.trim() || 'postgres://test:test@127.0.0.1:55432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => (schema: string) => rewriteSchemaSql(readFileSync(join(drizzleDir, file), 'utf8'), 'ledger', schema));

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REASON = 'set the reconciliation control';
const authConfig = {
  secret: 'a-ledger-reconciliation-control-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

async function ctx(scopes: string[], mfa: boolean): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: ACTOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-recon-1' };
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('reconciliation controls (postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({ service: 'ledger', url: URL, migrations });
  const actor = { actorId: ACTOR, requestId: 'req-recon-1' };
  const approvals = stubApprovalConsumer('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  let operation = 0;
  const nextOp = () => `op-recon-${++operation}`;

  afterAll(async () => {
    await db.drop();
  });

  async function insertAccount(ownerId: string, createdAt = '2025-12-01T00:00:00Z'): Promise<string> {
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance, created_at)
      VALUES ('user', ${ownerId}, 'USDT', 'available', '', 0, ${createdAt})
      RETURNING id
    `;
    return rows[0]!.id;
  }

  it('refuses activation with a blank tolerance and leaves the control draft', async () => {
    const before = (await listReconciliationControls(db.sql)).length;
    // Define with activate stores nothing when the policy is incomplete: no orphan draft on a retry.
    await expect(
      defineReconciliationControl(db.sql, actor, {
        template: 'threshold',
        accountSet: { mode: 'query', assetId: 'USDT' },
        reason: REASON,
        activate: true,
      }),
    ).rejects.toMatchObject({ code: OPS_CONTROL_POLICY_UNSET });
    expect(await listReconciliationControls(db.sql)).toHaveLength(before);
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      reason: REASON,
    });
    await expect(
      updateReconciliationControl(db.sql, actor, { controlId: defined.id, reason: REASON, activate: true }),
    ).rejects.toMatchObject({ code: OPS_CONTROL_POLICY_UNSET });
    const draft = (await listReconciliationControls(db.sql)).find((control) => control.id === defined.id);
    expect(draft?.state).toBe('draft');
    expect(draft?.tolerance).toEqual({ status: 'unset' });
    const audit = await db.sql<Array<{ actor_id: string; reason: string; action: string }>>`
      SELECT actor_id, reason, action FROM reconciliation_control_audit WHERE control_id = ${defined.id}
    `;
    expect(audit).toEqual([expect.objectContaining({ actor_id: ACTOR, reason: REASON, action: 'define' })]);
  });

  it('keeps the three built-in controls when a delete is attempted', async () => {
    await expect(db.sql`DELETE FROM reconciliation_controls WHERE builtin_key = 'replay'`).rejects.toThrow(/cannot be removed/);
    const keys = (await listReconciliationControls(db.sql)).filter((control) => control.builtin).map((control) => control.checkKind);
    expect(keys).toEqual([
      { status: 'set', value: 'chain' },
      { status: 'set', value: 'netting' },
      { status: 'set', value: 'replay' },
    ]);
    await expect(
      updateReconciliationControl(db.sql, actor, {
        controlId: '11111111-1111-4111-8111-111111111111',
        reason: REASON,
        explanation: 'remove the built-in',
      }),
    ).rejects.toMatchObject({ code: LEDGER_RECONCILE_BUILTIN_IMMUTABLE });
  });

  it('includes a new matching account on the next run', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', ownerIdPrefix: 'abcdeaaa-1111-4111-8111-' },
      schedule: { cadence: 'weekly', isoWeekday: 1, hour: 0, minute: 0 },
      severity: 'warning',
      tolerance: { default: '0' },
      threshold: { bound: 'min', byAsset: { USDT: '0' } },
      reason: REASON,
    });
    const active = await updateReconciliationControl(db.sql, actor, { controlId: defined.id, reason: REASON, activate: true });
    expect(active.state).toBe('active');
    expect(active.schedule).toMatchObject({ status: 'set', period: 'iso_week' });
    const first = await insertAccount('abcdeaaa-1111-4111-8111-000000000001');
    const run1 = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-1',
      operationId: nextOp(),
    });
    expect(run1.accounts).toEqual([first]);
    expect(run1.status).toBe('PASS');
    const second = await insertAccount('abcdeaaa-1111-4111-8111-000000000002');
    const run2 = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-2',
      operationId: nextOp(),
    });
    expect(run2.accounts).toEqual([first, second].sort());
  });

  it('stores the result row before reading and shows an absent outside balance as unset', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    let seenDuringRead = false;
    const sources: ReconciliationSources = {
      outsideBalance: async () => {
        const rows = await db.sql<Array<{ status: string; sources: { ledger: { asOf: string } } }>>`
          SELECT status, sources FROM reconciliation_control_runs WHERE control_id = ${defined.id}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('started');
        expect(rows[0]!.sources.ledger.asOf).toMatch(/^\d{4}-/);
        seenDuringRead = true;
        const unset: SnapshotRead = { kind: 'unset' };
        return unset;
      },
      parity: async () => ({ kind: 'unset' }),
    };
    const run = await runReconciliationControl(
      db.sql,
      approvals,
      actor,
      {
        controlId: defined.id,
        reason: REASON,
        approvalId: 'appr-3',
        operationId: nextOp(),
      },
      sources,
    );
    expect(seenDuringRead).toBe(true);
    expect(run.outsideSide).toBe('unset');
    expect(run.status).toBe('UNSET');
    expect(run.assets.every((asset) => asset.expected === 'unset' && asset.difference === 'unset')).toBe(true);
  });

  it('reads a past instant minus the margin, accepts 0, and refuses a blank margin or a future instant', async () => {
    const ownerId = 'abcdeaaa-1111-4111-8111-000000000010';
    const accountId = await insertAccount(ownerId);
    await withJournalGuardsOff(db.sql, ['balance'], async () => {
      await db.sql`
        INSERT INTO ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
        VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', 'recon-t1', 'bank', 'bank.transfer.in', '{}'::jsonb, '2026-01-01T00:00:00Z', 'h1', NULL),
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', 'recon-t2', 'bank', 'bank.transfer.in', '{}'::jsonb, '2026-01-02T00:00:00Z', 'h2', 'h1')
      `;
      await db.sql`
        INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
        VALUES
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', ${accountId}::uuid, 'USDT', 'debit', 10, 10),
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', ${accountId}::uuid, 'USDT', 'debit', 15, 25)
      `;
    });
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'explicit', accountIds: [accountId] },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'critical',
      tolerance: { default: '0' },
      threshold: { bound: 'max', byAsset: { USDT: '1000' } },
      reason: REASON,
      activate: true,
    });
    const input = {
      controlId: defined.id,
      reason: REASON,
      asOf: '2026-01-02T00:00:10.000Z',
    };
    await expect(
      runReconciliationControl(db.sql, approvals, actor, { ...input, approvalId: 'appr-4', operationId: nextOp() }),
    ).rejects.toBeInstanceOf(ReconciliationControlError);
    await expect(
      runReconciliationControl(db.sql, approvals, actor, { ...input, approvalId: 'appr-4', operationId: nextOp() }),
    ).rejects.toMatchObject({ code: OPS_CONTROL_MARGIN_UNSET });
    const exact = await runReconciliationControl(db.sql, approvals, actor, {
      ...input,
      margin: '0',
      approvalId: 'appr-5',
      operationId: nextOp(),
    });
    expect(exact.assets.find((asset) => asset.assetId === 'USDT')?.observed).toBe('25');
    const margined = await runReconciliationControl(db.sql, approvals, actor, {
      ...input,
      margin: '20',
      approvalId: 'appr-6',
      operationId: nextOp(),
    });
    expect(margined.readAt).toBe('2026-01-01T23:59:50.000Z');
    expect(margined.assets.find((asset) => asset.assetId === 'USDT')?.observed).toBe('10');
    await expect(
      runReconciliationControl(db.sql, approvals, actor, {
        controlId: defined.id,
        reason: REASON,
        asOf: '2999-01-01T00:00:00.000Z',
        margin: '0',
        approvalId: 'appr-7',
        operationId: nextOp(),
      }),
    ).rejects.toMatchObject({ code: LEDGER_RECONCILE_ASOF_INVALID });
  });

  it('lists controls for compliance and refuses a treasury define without a second factor', async () => {
    const ledger = { sql: db.sql } as unknown as LedgerService;
    const router = createLedgerRouter(ledger, undefined, approvals);
    const listed = await router.createCaller(await ctx(['admin:compliance'], false)).reconciliation.controls.list();
    expect(listed.controls.filter((control) => control.builtin)).toHaveLength(3);
    await expect(
      router.createCaller(await ctx(['admin:treasury'], false)).reconciliation.controls.define({
        template: 'source_parity',
        accountSet: { mode: 'query', assetId: 'USDT' },
        reason: REASON,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('inserts the run when identity already consumed this operation id', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      threshold: { bound: 'min', byAsset: { USDT: '0' } },
      margin: '0',
      reason: REASON,
      activate: true,
    });
    const operationId = nextOp();
    let requestId: string | undefined;
    const replay: ActionApprovalConsumer = {
      async consume(input) {
        requestId = input.requestId;
        return actionApprovalSchema.parse({
          approvalId: input.approvalId,
          operationId: input.operationId,
          payloadHash: input.payloadHash,
          targetService: input.targetService,
          targetId: input.targetId,
          expectedVersion: input.expectedVersion,
          actionType: 'ledger.reconciliation_control.run',
          requesterId: 'founder-a',
          approverId: 'founder-b',
          policyVersion: 'v1',
          createdAt: '2026-09-09T12:00:00.000Z',
          expiresAt: '2026-09-09T12:10:00.000Z',
          status: 'CONSUMED',
          consumption: 'already_consumed_by_this_request',
        });
      },
    };
    const run = await runReconciliationControl(db.sql, replay, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-replay',
      operationId,
    });
    expect(requestId).toBe(operationId);
    expect(run.status).not.toBe('started');
    const stored = await db.sql<Array<{ status: string }>>`
      SELECT status FROM reconciliation_control_runs WHERE operation_id = ${operationId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe(run.status);
  });

  it('finishes a started run as ERROR when evaluate throws, and a later retry stays on that row', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'warning',
      tolerance: { default: '0' },
      threshold: { bound: 'min', byAsset: { USDT: '0' } },
      margin: '0',
      reason: REASON,
      activate: true,
    });
    const operationId = nextOp();
    const first = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-started',
      operationId,
    });
    expect(first.status).not.toBe('started');
    await db.sql`
      UPDATE reconciliation_control_runs
         SET status = 'started', phase = '', error_code = '', finished_at = NULL
       WHERE id = ${first.id}
    `;
    await db.sql`
      UPDATE reconciliation_controls
         SET account_set = '{"mode":"nope"}'::jsonb
       WHERE id = ${defined.id}
    `;
    const resumed = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-started-again',
      operationId,
    });
    expect(resumed.id).toBe(first.id);
    expect(resumed.status).toBe('ERROR');
    expect(resumed.phase).toEqual({ status: 'set', value: 'accounts' });
    expect(resumed.errorCode).toEqual({ status: 'set', value: LEDGER_RECONCILE_SOURCE_UNAVAILABLE });
    const again = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-started-third',
      operationId,
    });
    expect(again).toMatchObject({ id: first.id, status: 'ERROR' });
  });

  it('resumes a started schedule row and skips a terminal one', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      threshold: { bound: 'max', byAsset: { USDT: '1000' } },
      margin: '0',
      reason: REASON,
      activate: true,
    });
    await runDueReconciliationControls(db.sql);
    // The current hour and the hour before it (caught up, so a due instant no tick landed after still runs).
    const opened = await db.sql<Array<{ id: string; status: string; finished_at: Date; period_start: Date }>>`
      SELECT id, status, finished_at, period_start FROM reconciliation_control_runs
       WHERE control_id = ${defined.id} ORDER BY period_start DESC
    `;
    expect(opened).toHaveLength(2);
    expect(opened[0]!.period_start.getTime() - opened[1]!.period_start.getTime()).toBe(3_600_000);
    expect(opened.every((run) => run.status !== 'started')).toBe(true);
    const finishedAt = opened[0]!.finished_at.toISOString();
    await runDueReconciliationControls(db.sql);
    const skipped = await db.sql<Array<{ status: string; finished_at: Date }>>`
      SELECT status, finished_at FROM reconciliation_control_runs WHERE id = ${opened[0]!.id}
    `;
    expect(skipped[0]!.status).toBe(opened[0]!.status);
    expect(skipped[0]!.finished_at.toISOString()).toBe(finishedAt);
    await db.sql`
      UPDATE reconciliation_control_runs
         SET status = 'started', phase = '', error_code = '', finished_at = NULL
       WHERE id = ${opened[0]!.id}
    `;
    await db.sql`
      UPDATE reconciliation_controls
         SET account_set = '{"mode":"nope"}'::jsonb
       WHERE id = ${defined.id}
    `;
    await runDueReconciliationControls(db.sql);
    const resumed = await db.sql<Array<{ status: string; phase: string; error_code: string }>>`
      SELECT status, phase, error_code FROM reconciliation_control_runs WHERE id = ${opened[0]!.id}
    `;
    expect(resumed[0]).toEqual({ status: 'ERROR', phase: 'accounts', error_code: LEDGER_RECONCILE_SOURCE_UNAVAILABLE });
  });

  it('catches a cached balance the entries do not explain, on a run now', async () => {
    const drifted = await insertAccount('abcdeaaa-2222-4222-8222-000000000001');
    await db.sql`UPDATE accounts SET balance = 5 WHERE id = ${drifted}`;
    try {
      const run = await runReconciliationControl(db.sql, approvals, actor, {
        controlId: '11111111-1111-4111-8111-111111111111',
        reason: REASON,
        approvalId: 'appr-drift',
        operationId: nextOp(),
      });
      expect(run.status).toBe('FAIL');
      expect(run.assets).toEqual([expect.objectContaining({ assetId: 'USDT', observed: expect.stringMatching(/^5/) })]);
    } finally {
      await db.sql`UPDATE accounts SET balance = 0 WHERE id = ${drifted}`;
    }
  });

  it('runs an operator ledger invariant as replay only, and passes a healthy subset', async () => {
    const holder = await insertAccount('abcdeaaa-3333-4333-8333-000000000001');
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'ledger_invariant',
      accountSet: { mode: 'explicit', accountIds: [holder] },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    expect(defined.checkKind).toEqual({ status: 'set', value: 'replay' });
    const run = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-subset',
      operationId: nextOp(),
    });
    expect(run.status).toBe('PASS');
  });

  it('refuses an operator run in the scheduled operation-id space', async () => {
    await expect(
      runReconciliationControl(db.sql, approvals, actor, {
        controlId: '11111111-1111-4111-8111-111111111111',
        reason: REASON,
        approvalId: 'appr-reserved',
        operationId: 'schedule:11111111-1111-4111-8111-111111111111:2026-10-24T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });
  });

  it('keeps an outside snapshot with no as-of unset rather than the ledger time', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    const sources: ReconciliationSources = {
      outsideBalance: async () => ({ kind: 'snapshot', balances: [{ assetId: 'USDT', amount: '0' }] }),
      parity: async () => ({ kind: 'unset' }),
    };
    const run = await runReconciliationControl(
      db.sql,
      approvals,
      actor,
      { controlId: defined.id, reason: REASON, approvalId: 'appr-noasof', operationId: nextOp() },
      sources,
    );
    expect(run.sources.outside).toEqual({ asOf: 'unset' });
  });

  it('keeps running later controls when one scheduled control throws', async () => {
    const broken = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      threshold: { bound: 'max', byAsset: { USDT: '1000' } },
      margin: '99999999',
      reason: REASON,
      activate: true,
    });
    const healthy = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      threshold: { bound: 'max', byAsset: { USDT: '1000' } },
      margin: '0',
      reason: REASON,
      activate: true,
    });
    await runDueReconciliationControls(db.sql);
    const runs = await db.sql<Array<{ control_id: string }>>`
      SELECT control_id FROM reconciliation_control_runs WHERE control_id IN (${broken.id}, ${healthy.id})
    `;
    expect(runs.filter((run) => run.control_id === healthy.id).length).toBeGreaterThan(0);
  });

  it('reaches define and run on the operator port', async () => {
    const app = Fastify({ logger: false });
    registerOperatorHttp(app, { sql: db.sql } as unknown as LedgerService, authConfig, approvals);
    await app.ready();
    const treasury = await issueAccessToken(
      { userId: ACTOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes: ['admin:treasury'], tier: 'basic', mfa: true },
      authConfig,
    );
    const headers = { authorization: `Bearer ${treasury.token}` };
    const refused = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls',
      headers,
      payload: {
        template: 'threshold',
        accountSet: { mode: 'query', assetId: 'USDT' },
        reason: REASON,
        activate: true,
      },
    });
    expect(refused.statusCode).toBe(412);
    expect(refused.json()).toMatchObject({ code: OPS_CONTROL_POLICY_UNSET });
    const defined = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls',
      headers,
      payload: {
        template: 'threshold',
        accountSet: { mode: 'query', assetId: 'USDT' },
        schedule: { cadence: 'daily', hour: 1, minute: 0 },
        severity: 'info',
        tolerance: { default: '0' },
        threshold: { bound: 'min', byAsset: { USDT: '0' } },
        reason: REASON,
        activate: true,
      },
    });
    expect(defined.statusCode).toBe(200);
    const controlId = (defined.json() as { id: string }).id;
    const run = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls/run',
      headers,
      payload: { controlId, reason: REASON, approvalId: 'appr-http', operationId: nextOp() },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ controlId, status: 'PASS' });
    const anonymous = await app.inject({ method: 'GET', url: '/operator/reconciliation/controls' });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });
}
