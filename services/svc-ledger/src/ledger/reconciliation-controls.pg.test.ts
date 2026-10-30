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
import { formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db/testing';
import {
  OPS_CONTROL_MARGIN_UNSET,
  OPS_CONTROL_POLICY_UNSET,
  OPS_CONTROL_STATE_ILLEGAL,
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_BUILTIN_IMMUTABLE,
  LEDGER_RECONCILE_CONTROL_NOT_FOUND,
  LEDGER_RECONCILE_ITEMS_MOVED,
  LEDGER_RECONCILE_ITEMS_NOW_ONLY,
  LEDGER_RECONCILE_RAIL_SOURCE_UNSET,
  LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
  updateReconciliationControlInputSchema,
} from '@intafaced/contracts/ledger-reconciliation';
import { createLedgerRouter } from '../router.js';
import { registerOperatorHttp } from '../operator-http.js';
import { ledgerActionPayloadHash, stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { withJournalGuardsOff } from '../db/journal-guards.testkit.js';
import { ReconciliationControlError } from './reconciliation-control-error.js';
import { PostgresLedger } from './postgres-ledger.js';
import {
  defineReconciliationControl,
  listReconciliationControlRuns,
  listReconciliationEvaluations,
  RECONCILIATION_EVALUATION_SETTLE_SECONDS,
  listReconciliationControls,
  runDueReconciliationControls,
  runReconciliationControl,
  updateReconciliationControl,
  type ReconciliationSources,
  type SnapshotRead,
} from './reconciliation-controls.js';
import { reconciliationSourcesFrom } from './reconciliation-sources.js';
import { transactionsExist } from './transactions-exist.js';
import type { LedgerService } from '../service.js';

// PG-hard: no skip. A run without a database fails instead of reporting a silent absence.
const URL = process.env.TEST_DATABASE_URL?.trim();
if (!URL) throw new Error('TEST_DATABASE_URL is required for the reconciliation-controls postgres proof');
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

{
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
      updateReconciliationControl(db.sql, actor, { controlId: defined.id, reason: REASON, activate: true }, approvals),
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
      updateReconciliationControl(
        db.sql,
        actor,
        {
          controlId: '11111111-1111-4111-8111-111111111111',
          reason: REASON,
          explanation: 'remove the built-in',
        },
        approvals,
      ),
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
    const active = await updateReconciliationControl(db.sql, actor, { controlId: defined.id, reason: REASON, activate: true }, approvals);
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
      railStatement: async () => ({ kind: 'unset' }),
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

  const replayingIdentity = (attested: boolean, seen: { requestId?: string }): ActionApprovalConsumer => ({
    async consume(input) {
      seen.requestId = input.requestId;
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
        ...(attested ? { requesterIsFounder: true, approverIsFounder: true } : {}),
      });
    },
  });

  const replayControl = () =>
    defineReconciliationControl(db.sql, actor, {
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

  it('inserts the run when identity replays an attested consume of this operation id', async () => {
    const defined = await replayControl();
    const operationId = nextOp();
    const seen: { requestId?: string } = {};
    const run = await runReconciliationControl(db.sql, replayingIdentity(true, seen), actor, {
      controlId: defined.id,
      reason: REASON,
      approvalId: 'appr-replay',
      operationId,
    });
    expect(seen.requestId).toBe(operationId);
    expect(run.status).not.toBe('started');
    const stored = await db.sql<Array<{ status: string }>>`
      SELECT status FROM reconciliation_control_runs WHERE operation_id = ${operationId}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe(run.status);
  });

  it('refuses a replayed consume without the founder attestation and stores no run', async () => {
    const defined = await replayControl();
    const operationId = nextOp();
    await expect(
      runReconciliationControl(db.sql, replayingIdentity(false, {}), actor, {
        controlId: defined.id,
        reason: REASON,
        approvalId: 'appr-replay-unattested',
        operationId,
      }),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    const stored = await db.sql`SELECT 1 FROM reconciliation_control_runs WHERE operation_id = ${operationId}`;
    expect(stored).toHaveLength(0);
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

  it('pauses, resumes and retires a control: paused and retired run nothing, retired is final', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', ownerIdPrefix: 'abcdeaaa-3333-4333-8333-' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'warning',
      tolerance: { default: '0' },
      threshold: { bound: 'min', byAsset: { USDT: '0' } },
      reason: REASON,
    });
    const id = defined.id;
    const runCount = async () =>
      Number(
        (await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM reconciliation_control_runs WHERE control_id = ${id}`)[0]!.n,
      );
    const run = () =>
      runReconciliationControl(db.sql, approvals, actor, { controlId: id, reason: REASON, approvalId: 'appr-life', operationId: nextOp() });
    const move = (lifecycle: 'pause' | 'resume' | 'retire') =>
      updateReconciliationControl(
        db.sql,
        actor,
        { controlId: id, reason: REASON, lifecycle, approvalId: 'appr-move', operationId: nextOp() },
        approvals,
      );

    // A draft cannot be paused or resumed; a lifecycle move travels alone.
    await expect(move('pause')).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    await expect(move('resume')).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    await expect(
      updateReconciliationControl(
        db.sql,
        actor,
        { controlId: id, reason: REASON, lifecycle: 'pause', activate: true, approvalId: 'appr-move', operationId: nextOp() },
        approvals,
      ),
    ).rejects.toThrow(OPS_CONTROL_STATE_ILLEGAL);
    await updateReconciliationControl(db.sql, actor, { controlId: id, reason: REASON, activate: true }, approvals);

    const paused = await move('pause');
    expect(paused.state).toBe('paused');
    await expect(run()).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    await runDueReconciliationControls(db.sql);
    expect(await runCount()).toBe(0);
    // A paused control takes edits and stays paused; it is not activated by an update.
    const edited = await updateReconciliationControl(db.sql, actor, { controlId: id, reason: REASON, severity: 'critical' }, approvals);
    expect(edited).toMatchObject({ state: 'paused', severity: { status: 'set', value: 'critical' } });
    await expect(
      updateReconciliationControl(db.sql, actor, { controlId: id, reason: REASON, activate: true }, approvals),
    ).rejects.toMatchObject({
      code: OPS_CONTROL_STATE_ILLEGAL,
    });
    await expect(move('pause')).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });

    const resumed = await move('resume');
    expect(resumed.state).toBe('active');
    // The hours that fell due while it was paused are not caught up on resume.
    await runDueReconciliationControls(db.sql);
    expect(await runCount()).toBe(0);
    expect((await run()).status).toBe('PASS');
    expect(await runCount()).toBe(1);

    const retired = await move('retire');
    expect(retired.state).toBe('retired');
    await expect(run()).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    for (const lifecycle of ['pause', 'resume', 'retire'] as const) {
      await expect(move(lifecycle)).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    }
    await expect(
      updateReconciliationControl(db.sql, actor, { controlId: id, reason: REASON, explanation: 'revive' }, approvals),
    ).rejects.toMatchObject({
      code: OPS_CONTROL_STATE_ILLEGAL,
    });
    await runDueReconciliationControls(db.sql);
    // Retired keeps its row, its one run and its history.
    expect(await runCount()).toBe(1);
    expect((await db.sql<Array<{ state: string }>>`SELECT state FROM reconciliation_controls WHERE id = ${id}`)[0]?.state).toBe('retired');
    const audit = await db.sql<Array<{ detail: { lifecycle?: string; from?: string; state?: string } }>>`
      SELECT detail FROM reconciliation_control_audit WHERE control_id = ${id} AND detail ? 'lifecycle' ORDER BY id
    `;
    expect(audit.map((row) => [row.detail.lifecycle, row.detail.from, row.detail.state])).toEqual([
      ['pause', 'active', 'paused'],
      ['resume', 'paused', 'active'],
      ['retire', 'active', 'retired'],
    ]);
  });

  it('refuses a lifecycle move on a built-in control, and retires a draft', async () => {
    const [builtin] = await db.sql<Array<{ id: string }>>`SELECT id FROM reconciliation_controls WHERE builtin LIMIT 1`;
    await expect(
      updateReconciliationControl(
        db.sql,
        actor,
        { controlId: builtin!.id, reason: REASON, lifecycle: 'pause', approvalId: 'appr-move', operationId: nextOp() },
        approvals,
      ),
    ).rejects.toMatchObject({ code: LEDGER_RECONCILE_BUILTIN_IMMUTABLE });
    const draft = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', assetId: 'USDT' },
      reason: REASON,
    });
    const retired = await updateReconciliationControl(
      db.sql,
      actor,
      { controlId: draft.id, reason: REASON, lifecycle: 'retire', approvalId: 'appr-move', operationId: nextOp() },
      approvals,
    );
    expect(retired.state).toBe('retired');
  });

  it('binds a lifecycle move to two founders: the control, the move and the reason at the version read', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', ownerIdPrefix: 'abcdeaaa-4444-4444-8444-' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'warning',
      tolerance: { default: '0' },
      threshold: { bound: 'min', byAsset: { USDT: '0' } },
      reason: REASON,
    });
    const active = await updateReconciliationControl(db.sql, actor, { controlId: defined.id, reason: REASON, activate: true }, approvals);
    // Without the approval ids the move is refused before it reads anything.
    expect(updateReconciliationControlInputSchema.safeParse({ controlId: defined.id, reason: REASON, lifecycle: 'pause' }).success).toBe(
      false,
    );
    expect(
      updateReconciliationControlInputSchema.safeParse({
        controlId: defined.id,
        reason: REASON,
        severity: 'info',
        approvalId: 'a',
        operationId: 'o',
      }).success,
    ).toBe(false);
    // An identity that refuses leaves the control as it was.
    const refusing: ActionApprovalConsumer = {
      async consume() {
        throw new Error('identity refused');
      },
    };
    await expect(
      updateReconciliationControl(
        db.sql,
        actor,
        { controlId: defined.id, reason: REASON, lifecycle: 'pause', approvalId: 'appr-no', operationId: nextOp() },
        refusing,
      ),
    ).rejects.toThrow('identity refused');
    expect((await db.sql<Array<{ state: string }>>`SELECT state FROM reconciliation_controls WHERE id = ${defined.id}`)[0]?.state).toBe(
      'active',
    );
    const seen: Array<Parameters<ActionApprovalConsumer['consume']>[0]> = [];
    const recording: ActionApprovalConsumer = {
      async consume(input) {
        seen.push(input);
        return approvals.consume(input);
      },
    };
    const paused = await updateReconciliationControl(
      db.sql,
      actor,
      { controlId: defined.id, reason: REASON, lifecycle: 'pause', approvalId: 'appr-yes', operationId: 'op-life-yes' },
      recording,
    );
    expect(paused.state).toBe('paused');
    expect(seen).toEqual([
      {
        approvalId: 'appr-yes',
        operationId: 'op-life-yes',
        payloadHash: ledgerActionPayloadHash('ledger.reconciliation_control.lifecycle', {
          controlId: defined.id,
          lifecycle: 'pause',
          reason: REASON,
        }),
        targetService: 'svc-ledger',
        targetId: 'posting_reconciliation_control.lifecycle',
        expectedVersion: String(active.version),
      },
    ]);
    // An illegal move is refused before identity is asked, so it spends no approval.
    await expect(
      updateReconciliationControl(
        db.sql,
        actor,
        { controlId: defined.id, reason: REASON, lifecycle: 'pause', approvalId: 'appr-again', operationId: nextOp() },
        recording,
      ),
    ).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    expect(seen).toHaveLength(1);
  });

  it('opens no run on a control paused after it was read, and still finishes a run that had opened', async () => {
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'threshold',
      accountSet: { mode: 'query', ownerIdPrefix: 'abcdeaaa-5555-4555-8555-' },
      schedule: { cadence: 'hourly', minute: 0 },
      severity: 'warning',
      tolerance: { default: '0' },
      threshold: { bound: 'min', byAsset: { USDT: '0' } },
      reason: REASON,
    });
    const id = defined.id;
    await updateReconciliationControl(db.sql, actor, { controlId: id, reason: REASON, activate: true }, approvals);
    // The pause commits while the run is between its read and its insert (here: while identity answers).
    const pausing: ActionApprovalConsumer = {
      async consume(input) {
        await db.sql`UPDATE reconciliation_controls SET state = 'paused', version = version + 1 WHERE id = ${id}`;
        return approvals.consume(input);
      },
    };
    await expect(
      runReconciliationControl(db.sql, pausing, actor, { controlId: id, reason: REASON, approvalId: 'appr-race', operationId: nextOp() }),
    ).rejects.toMatchObject({ code: OPS_CONTROL_STATE_ILLEGAL });
    expect(
      (await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM reconciliation_control_runs WHERE control_id = ${id}`)[0]!.n,
    ).toBe('0');

    // A run that opened before the pause is answered on retry, not stranded.
    await db.sql`UPDATE reconciliation_controls SET state = 'active', version = version + 1 WHERE id = ${id}`;
    const operationId = nextOp();
    const first = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: id,
      reason: REASON,
      approvalId: 'appr-done',
      operationId,
    });
    await db.sql`UPDATE reconciliation_controls SET state = 'paused', version = version + 1 WHERE id = ${id}`;
    const again = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: id,
      reason: REASON,
      approvalId: 'appr-done',
      operationId,
    });
    expect(again).toEqual(first);
    await db.sql`UPDATE reconciliation_control_runs SET status = 'started' WHERE id = ${first.id}`;
    const resumed = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: id,
      reason: REASON,
      approvalId: 'appr-done',
      operationId,
    });
    expect(resumed.id).toBe(first.id);
    expect(resumed.status).not.toBe('started');
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
      // The row observes the summed size of each USDT account's drift against 0: this account's 5 on top of the one-sided
      // fixture rows earlier tests leave in the whole book.
      expect(run.assets).toEqual([expect.objectContaining({ assetId: 'USDT', expected: '0' })]);
      expect(amt(run.assets[0]!.observed) >= amt('5')).toBe(true);
    } finally {
      await db.sql`UPDATE accounts SET balance = 0 WHERE id = ${drifted}`;
    }
  });

  it('leaves an account created and funded after read_at out of every side, and its counter-leg at read_at: the total stays 0', async () => {
    const REPLAY = '11111111-1111-4111-8111-111111111111';
    const NETTING = '33333333-3333-4333-8333-333333333333';
    const engine = new PostgresLedger(db.sql);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const fund = (userId: string, railRef: string) =>
      engine.post(recipes.deposit({ userId, assetId: 'BTC', amount: amt('7'), rail: 'test', railRef }));
    // The first deposit makes the rail boundary account, so the counter-leg exists before read_at.
    await fund('abcdeaaa-4444-4444-8444-000000000001', 'recon-snap-1');
    // Whole-book controls: an earlier test leaves one-sided USDT rows, so each run is judged on its BTC row alone.
    const btc = (run: { assets: Array<{ assetId: string }> }) => run.assets.find((asset) => asset.assetId === 'BTC');
    const zero = { assetId: 'BTC', observed: '0', expected: '0', difference: '0', tolerance: '0' };
    const open = async (controlId: string, approvalId: string) => {
      const operationId = nextOp();
      const run = await runReconciliationControl(db.sql, approvals, actor, { controlId, reason: REASON, approvalId, operationId });
      expect(btc(run)).toEqual(zero);
      return { run, operationId };
    };
    const netting = await open(NETTING, 'appr-snap-1');
    const replay = await open(REPLAY, 'appr-snap-2');
    // Hold both runs at one read_at, on a millisecond as the driver reads it, with the deposits strictly either side.
    await tick();
    const [stamp] = await db.sql<Array<{ read_at: Date }>>`
      UPDATE reconciliation_control_runs
         SET status = 'started', phase = '', error_code = '', finished_at = NULL,
             read_at = date_trunc('milliseconds', clock_timestamp())
       WHERE id IN ${db.sql([netting.run.id, replay.run.id])}
      RETURNING read_at
    `;
    const readAt = stamp!.read_at;
    await tick();
    await fund('abcdeaaa-4444-4444-8444-000000000002', 'recon-snap-2');
    const legs = await db.sql<Array<{ id: string; created_at: Date; owner_id: string }>>`
      SELECT a.id, a.created_at, a.owner_id
        FROM ledger_entries e
        JOIN ledger_tx t ON t.id = e.tx_id
        JOIN accounts a ON a.id = e.account_id
       WHERE t.idempotency_key LIKE '%recon-snap-2%'
    `;
    expect(legs).toHaveLength(2);
    const fresh = legs.find((leg) => leg.owner_id === 'abcdeaaa-4444-4444-8444-000000000002')!;
    const boundary = legs.find((leg) => leg.id !== fresh.id)!;
    expect(fresh.created_at.getTime()).toBeGreaterThan(readAt.getTime());
    expect(boundary.created_at.getTime()).toBeLessThan(readAt.getTime());

    // The run resumes after the deposit, at the current instant: the fresh account is in no side, the boundary is counted
    // at read_at, and the BTC total is exactly 0.
    const resumed = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: NETTING,
      reason: REASON,
      approvalId: 'appr-snap-3',
      operationId: netting.operationId,
    });
    expect(resumed.id).toBe(netting.run.id);
    expect(resumed.status).not.toBe('started');
    expect(btc(resumed)).toEqual(zero);
    expect(resumed.accounts).toContain(boundary.id);
    expect(resumed.accounts).not.toContain(fresh.id);
    expect(resumed.sources.ledger.asOf).toBe(readAt.toISOString());

    // The replay reports balance_after against the entries at read_at, and checks the cached column against the entries
    // on its snapshot: no drift from a deposit that landed after read_at.
    const replayed = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: REPLAY,
      reason: REASON,
      approvalId: 'appr-snap-4',
      operationId: replay.operationId,
    });
    expect(replayed.id).toBe(replay.run.id);
    expect(replayed.status).not.toBe('started');
    expect(btc(replayed)).toEqual(zero);
    expect(replayed.accounts).not.toContain(fresh.id);

    // A past run at that read_at agrees with the resumed run.
    const past = await runReconciliationControl(db.sql, approvals, actor, {
      controlId: NETTING,
      reason: REASON,
      asOf: readAt.toISOString(),
      margin: '0',
      approvalId: 'appr-snap-5',
      operationId: nextOp(),
    });
    expect(past.accounts).toContain(boundary.id);
    expect(past.accounts).not.toContain(fresh.id);
    expect(btc(past)).toEqual(zero);
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

  it('fails a replay now when two accounts drift by amounts that cancel in the asset total', async () => {
    const engine = new PostgresLedger(db.sql);
    const funded = async (userId: string) => {
      const posted = await engine.post(
        recipes.deposit({ userId, assetId: 'ETH', amount: amt('5'), rail: 'test', railRef: `recon-cancel-${userId}` }),
      );
      const [account] = await db.sql<Array<{ id: string }>>`
        SELECT id FROM accounts WHERE owner_id = ${userId} AND id = ANY(${posted.entries.map((entry) => entry.accountId)}::uuid[])
      `;
      return account!.id;
    };
    const up = await funded('abcdeaaa-5555-4555-8555-000000000001');
    const down = await funded('abcdeaaa-5555-4555-8555-000000000002');
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'ledger_invariant',
      accountSet: { mode: 'explicit', accountIds: [up, down] },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    await db.sql`UPDATE accounts SET balance = balance + 3 WHERE id = ${up}`;
    await db.sql`UPDATE accounts SET balance = balance - 3 WHERE id = ${down}`;
    try {
      const run = await runReconciliationControl(db.sql, approvals, actor, {
        controlId: defined.id,
        reason: REASON,
        approvalId: 'appr-cancel',
        operationId: nextOp(),
      });
      expect(run.status).toBe('FAIL');
      // Each account drifts by 3; the asset row observes the summed size, 6, against 0.
      expect(run.assets).toEqual([expect.objectContaining({ assetId: 'ETH', observed: '6', expected: '0', difference: '6' })]);
    } finally {
      await db.sql`UPDATE accounts SET balance = balance - 3 WHERE id = ${up}`;
      await db.sql`UPDATE accounts SET balance = balance + 3 WHERE id = ${down}`;
    }
  });

  it("reconciles one rail's boundary against that rail's own statement: equal is PASS, a gap is FAIL, a blank URL is UNSET with its code", async () => {
    const engine = new PostgresLedger(db.sql);
    // Two rails take deposits; the control over recon-rail must count its boundary alone (-7), never recon-other's.
    await engine.post(
      recipes.deposit({
        userId: 'abcdeaaa-8888-4888-8888-000000000001',
        assetId: 'USDT',
        amount: amt('7'),
        rail: 'recon-rail',
        railRef: 'recon-rail-1',
      }),
    );
    await engine.post(
      recipes.deposit({
        userId: 'abcdeaaa-8888-4888-8888-000000000002',
        assetId: 'USDT',
        amount: amt('4'),
        rail: 'recon-other',
        railRef: 'recon-other-1',
      }),
    );
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', rail: 'recon-rail', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'critical',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    let amount = '-7';
    const asked: Array<{ rail?: string; asOf?: string }> = [];
    const server = Fastify();
    server.get('/statement', async (req) => {
      const query = req.query as { rail?: string; asOf?: string };
      asked.push(query);
      // The statement lists every asset on the rail; the control is scoped to USDT and judges USDT alone.
      return {
        source: 'rail',
        rail: query.rail,
        asOf: '2026-01-01T00:00:00.000Z',
        balances: [
          { assetId: 'USDT', amount },
          { assetId: 'BTC', amount: '-3' },
        ],
      };
    });
    server.get('/book', async () => ({ source: 'rail', asOf: '2026-01-01T00:00:00.000Z', balances: [{ assetId: 'USDT', amount: '-7' }] }));
    const base = await server.listen({ port: 0, host: '127.0.0.1' });
    const run = (sources: ReconciliationSources) =>
      runReconciliationControl(
        db.sql,
        approvals,
        actor,
        { controlId: defined.id, reason: REASON, approvalId: 'appr-rail', operationId: nextOp() },
        sources,
      );
    try {
      const railUrls = new Map([['recon-rail', `${base}/statement`]]);
      const pass = await run(reconciliationSourcesFrom(undefined, railUrls));
      expect(pass).toMatchObject({ status: 'PASS', outsideSide: 'snapshot', sources: { outside: { asOf: '2026-01-01T00:00:00.000Z' } } });
      expect(pass.assets).toEqual([{ assetId: 'USDT', observed: '-7', expected: '-7', difference: '0', tolerance: '0' }]);
      expect(pass.accounts).toHaveLength(1);
      expect(asked).toEqual([{ rail: 'recon-rail', asOf: pass.readAt }]);

      // The outside side is one cent short of the boundary: FAIL to the cent, never rounded away.
      amount = '-6.99';
      const fail = await run(reconciliationSourcesFrom(undefined, railUrls));
      expect(fail.status).toBe('FAIL');
      expect(fail.assets).toEqual([expect.objectContaining({ assetId: 'USDT', observed: '-7', expected: '-6.99' })]);
      expect(amt(fail.assets[0]!.difference) === 0n).toBe(false);

      // No URL for this rail: UNSET with the typed code, even when the whole-book snapshot URL is set and would match.
      const unset = await run(reconciliationSourcesFrom(`${base}/book`, new Map([['recon-other', `${base}/statement`]])));
      expect(unset).toMatchObject({
        status: 'UNSET',
        outsideSide: 'unset',
        errorCode: { status: 'set', value: LEDGER_RECONCILE_RAIL_SOURCE_UNSET },
      });
      expect(unset.assets.every((asset) => asset.expected === 'unset')).toBe(true);
      expect(asked).toHaveLength(2);
    } finally {
      await server.close();
    }

    // A rail names its boundary itself: an owner type, an owner id prefix or a kind other than available beside it is refused.
    for (const clash of [{ ownerType: 'user' }, { ownerIdPrefix: 'rail:' }, { kind: 'hold' }]) {
      await expect(
        defineReconciliationControl(db.sql, actor, {
          template: 'outside_balance',
          accountSet: { mode: 'query', rail: 'recon-rail', ...clash },
          schedule: { cadence: 'daily', hour: 0, minute: 0 },
          severity: 'critical',
          tolerance: { default: '0' },
          reason: REASON,
          activate: true,
        } as never),
      ).rejects.toThrow();
    }
  });

  it("takes a rail's named open items out of its difference: PASS names every item, a residual of one unit or an unlisted transfer FAILs, an unreadable list is ERROR", async () => {
    // Lead ruling 2026-10-30: the rail passes only when its difference is exactly the open items svc-pay lists, each named.
    const engine = new PostgresLedger(db.sql);
    await engine.post(
      recipes.deposit({
        userId: 'abcdeaaa-8888-4888-8888-000000000003',
        assetId: 'USDT',
        amount: amt('7'),
        rail: 'recon-items',
        railRef: 'recon-items-1',
      }),
    );
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', rail: 'recon-items', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'critical',
      // A tolerance of 1 that the items rule must not apply: a residual of 0.01 still FAILs.
      tolerance: { default: '1' },
      reason: REASON,
      activate: true,
    });
    const held = (id: string, amount: string) => ({ kind: 'held' as const, id, amount });
    const unfunded = (id: string, amount: string) => ({ kind: 'reversal_unfunded' as const, id, amount });
    let statement = '-10';
    let listed: Array<{ kind: 'held' | 'reversal_unfunded'; id: string; amount: string }> = [];
    let itemsStatus = 200;
    const asked: unknown[] = [];
    const signed: string[] = [];
    const server = Fastify();
    server.get('/statement', async (req) => ({
      source: 'rail',
      rail: (req.query as { rail: string }).rail,
      asOf: '2026-01-01T00:00:00.000Z',
      balances: [{ assetId: 'USDT', amount: statement }],
    }));
    server.post('/items', async (req, reply) => {
      asked.push(req.body);
      signed.push(String(req.headers['x-test-signed']));
      if (itemsStatus !== 200) return reply.code(itemsStatus).send({ error: 'pay.custody_open_items_unavailable' });
      const { offset, limit } = req.body as { offset: number; limit: number };
      const all = listed.map((item, i) => ({
        depositId: item.id,
        kind: item.kind,
        userId: 'abcdeaaa-8888-4888-8888-000000000003',
        assetId: 'USDT',
        networkId: 'ethereum',
        txHash: `0xtest${i}`,
        outputIndex: 0,
        amount: item.amount.replace('-', ''),
        signedAmount: item.amount,
        status: item.kind === 'held' ? 'held_travel_rule' : 'needs_review',
        reason: item.kind === 'held' ? null : 'reversal_unfunded',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }));
      const sum = (kind: string) => listed.filter((i) => i.kind === kind).reduce((n, i) => n + amt(i.amount.replace('-', '')), 0n);
      return {
        items: all.slice(offset, offset + limit),
        total: all.length,
        sums: all.length
          ? [
              {
                networkId: 'ethereum',
                assetId: 'USDT',
                held: formatAmount(sum('held')),
                heldCount: listed.filter((i) => i.kind === 'held').length,
                reversalUnfunded: formatAmount(sum('reversal_unfunded')),
                reversalUnfundedCount: listed.filter((i) => i.kind === 'reversal_unfunded').length,
                net: formatAmount(sum('held') - sum('reversal_unfunded')),
              },
            ]
          : [],
      };
    });
    const base = await server.listen({ port: 0, host: '127.0.0.1' });
    const sources = () =>
      reconciliationSourcesFrom(undefined, new Map([['recon-items', `${base}/statement`]]), fetch, undefined, {
        urls: new Map([['recon-items', `${base}/items`]]),
        sign: (payload) => ({ 'x-test-signed': payload }),
      });
    const run = () =>
      runReconciliationControl(
        db.sql,
        approvals,
        actor,
        { controlId: defined.id, reason: REASON, approvalId: 'appr-items', operationId: nextOp() },
        sources(),
      );
    try {
      // Custody shows 10, the ledger 7: two held deposits (2 + 2) and one credited deposit the chain took back uncovered
      // (-1) explain it exactly. PASS, with every item named by id and amount on the run.
      listed = [held('dep-held-1', '2'), held('dep-held-2', '2'), unfunded('dep-unfunded-1', '-1')];
      const pass = await run();
      expect(pass.status).toBe('PASS');
      expect(pass.assets).toEqual([
        { assetId: 'USDT', observed: '-7', expected: '-10', difference: '3', tolerance: '1', reconcilingItems: '3', residual: '0' },
      ]);
      expect(pass.reconcilingItems).toEqual([
        { source: 'svc-pay', id: 'dep-held-1', kind: 'held', assetId: 'USDT', amount: '2' },
        { source: 'svc-pay', id: 'dep-held-2', kind: 'held', assetId: 'USDT', amount: '2' },
        { source: 'svc-pay', id: 'dep-unfunded-1', kind: 'reversal_unfunded', assetId: 'USDT', amount: '-1' },
      ]);
      // Read twice, before the ledger snapshot and after the statement, each body signed as sent.
      expect(asked).toEqual([
        { rail: 'recon-items', offset: 0, limit: 200 },
        { rail: 'recon-items', offset: 0, limit: 200 },
      ]);
      expect(signed).toEqual(asked.map((body) => JSON.stringify(body)));
      // The stored run reads back the same items.
      const stored = await listReconciliationControlRuns(db.sql, { controlId: defined.id });
      expect(stored.runs.find((r) => r.id === pass.id)?.reconcilingItems).toEqual(pass.reconcilingItems);

      // One hundredth over the items: FAIL naming the residual, though the tolerance is 1.
      statement = '-10.01';
      const cent = await run();
      expect(cent.status).toBe('FAIL');
      expect(cent.assets[0]).toMatchObject({ difference: '3.01', reconcilingItems: '3', residual: '0.01' });

      // A transfer custody received that no item lists (2 more on the rail): FAIL, the residual is that transfer.
      statement = '-12';
      const unlisted = await run();
      expect(unlisted.status).toBe('FAIL');
      expect(unlisted.assets[0]).toMatchObject({ difference: '5', reconcilingItems: '3', residual: '2' });
      expect(unlisted.reconcilingItems).toHaveLength(3);

      // No items at all and no difference: PASS with an empty, named list, not the old path.
      statement = '-7';
      listed = [];
      const none = await run();
      expect(none.status).toBe('PASS');
      expect(none.reconcilingItems).toEqual([]);
      expect(none.assets[0]).toMatchObject({ reconcilingItems: '0', residual: '0' });

      // svc-pay cannot answer: ERROR at items, never PASS on the statement alone.
      itemsStatus = 503;
      const down = await run();
      expect(down).toMatchObject({
        status: 'ERROR',
        phase: { status: 'set', value: 'items' },
        errorCode: { status: 'set', value: LEDGER_RECONCILE_SOURCE_UNAVAILABLE },
      });
      expect(down.reconcilingItems).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('judges a rail asset only the items explain, FAILs ahead of an unset asset, leaves out an item seen after the statement, catches an item that moves, and reads a scheduled run now', async () => {
    const engine = new PostgresLedger(db.sql);
    const userId = 'abcdeaaa-8888-4888-8888-000000000004';
    await engine.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('7'), rail: 'recon-items-b', railRef: 'recon-items-b-1' }));
    // The ledger also holds BTC on the rail; the statement never names BTC, so BTC stays unset on every run below.
    await engine.post(recipes.deposit({ userId, assetId: 'BTC', amount: amt('1'), rail: 'recon-items-b', railRef: 'recon-items-b-2' }));
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', rail: 'recon-items-b' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'critical',
      tolerance: { default: '1' },
      margin: '0',
      reason: REASON,
      activate: true,
    });
    type Listed = { kind: 'held' | 'reversal_unfunded'; id: string; assetId: string; amount: string; seen?: string };
    let listed: Listed[] = [];
    // Called on each items read with its 1-based number: lets one read differ from the one before it.
    let onRead: (n: number) => void = () => {};
    const asked: unknown[] = [];
    const server = Fastify();
    server.get('/statement', async () => ({
      source: 'rail',
      rail: 'recon-items-b',
      asOf: '2026-01-01T00:00:00.000Z',
      // USDC: custody holds 4 the ledger never booked (a held first deposit posts nothing, so the ledger has no USDC account).
      balances: [
        { assetId: 'USDT', amount: '-10' },
        { assetId: 'USDC', amount: '-4' },
      ],
    }));
    server.post('/items', async (req) => {
      asked.push(req.body);
      onRead(asked.length);
      const items = listed.map((item, i) => ({
        depositId: item.id,
        kind: item.kind,
        userId,
        assetId: item.assetId,
        networkId: 'ethereum',
        txHash: `0xb${i}`,
        outputIndex: 0,
        amount: item.amount.replace('-', ''),
        signedAmount: item.amount,
        status: item.kind === 'held' ? 'held_travel_rule' : 'needs_review',
        reason: item.kind === 'held' ? null : 'reversal_unfunded',
        detectedAt: item.seen ?? '2026-01-01T00:00:00.000Z',
      }));
      const assets = [...new Set(listed.map((i) => i.assetId))];
      return {
        items,
        total: items.length,
        sums: assets.map((assetId) => {
          const of = (kind: string) => listed.filter((i) => i.assetId === assetId && i.kind === kind);
          const add = (rows: Listed[]) => rows.reduce((n, i) => n + amt(i.amount.replace('-', '')), 0n);
          return {
            networkId: 'ethereum',
            assetId,
            held: formatAmount(add(of('held'))),
            heldCount: of('held').length,
            reversalUnfunded: formatAmount(add(of('reversal_unfunded'))),
            reversalUnfundedCount: of('reversal_unfunded').length,
            net: formatAmount(add(of('held')) - add(of('reversal_unfunded'))),
          };
        }),
      };
    });
    const base = await server.listen({ port: 0, host: '127.0.0.1' });
    const sources = () =>
      reconciliationSourcesFrom(undefined, new Map([['recon-items-b', `${base}/statement`]]), fetch, undefined, {
        urls: new Map([['recon-items-b', `${base}/items`]]),
        sign: (payload) => ({ 'x-test-signed': payload }),
      });
    const run = (extra: Record<string, string> = {}) =>
      runReconciliationControl(
        db.sql,
        approvals,
        actor,
        { controlId: defined.id, reason: REASON, approvalId: 'appr-items-b', operationId: nextOp(), ...extra },
        sources(),
      );
    try {
      // USDT is one unit over its items (a residual of 1 within a tolerance of 1 still FAILs); USDC is explained exactly by
      // its held deposit; BTC is unset. FAIL: a known break is never hidden behind the unset asset.
      listed = [
        { kind: 'held', id: 'dep-b-usdt', assetId: 'USDT', amount: '2' },
        { kind: 'held', id: 'dep-b-usdc', assetId: 'USDC', amount: '4' },
      ];
      const broken = await run();
      expect(broken.status).toBe('FAIL');
      expect(broken.assets).toEqual([
        { assetId: 'BTC', observed: '-1', expected: 'unset', difference: 'unset', tolerance: '1', reconcilingItems: '0' },
        // The ledger side of USDC is 0, judged, not unset.
        { assetId: 'USDC', observed: '0', expected: '-4', difference: '4', tolerance: '1', reconcilingItems: '4', residual: '0' },
        { assetId: 'USDT', observed: '-7', expected: '-10', difference: '3', tolerance: '1', reconcilingItems: '2', residual: '1' },
      ]);

      // With USDT explained too, only the unset BTC is left: UNSET, not PASS.
      listed = [...listed, { kind: 'held', id: 'dep-b-usdt-2', assetId: 'USDT', amount: '1' }];
      const unset = await run();
      expect(unset.status).toBe('UNSET');
      expect(unset.assets.find((a) => a.assetId === 'USDT')).toMatchObject({ residual: '0' });

      // svc-pay lists what is open now: a run at a past instant cannot take items out. UNSET with its code, nothing asked.
      const before = asked.length;
      const past = await run({ asOf: new Date(Date.now() - 60_000).toISOString(), margin: '0' });
      expect(past).toMatchObject({
        status: 'UNSET',
        phase: { status: 'set', value: 'items' },
        errorCode: { status: 'set', value: LEDGER_RECONCILE_ITEMS_NOW_ONLY },
      });
      expect(past.reconcilingItems).toBeUndefined();
      expect(asked).toHaveLength(before);

      // Each run reads the items twice: before the ledger snapshot and after the statement.
      const reads = asked.length;
      await run();
      expect(asked.length - reads).toBe(2);

      // An item svc-pay saw after the statement's as-of is in neither side: left out, the run still judged and PASS-able.
      listed = [...listed, { kind: 'held', id: 'dep-b-late', assetId: 'USDT', amount: '9', seen: '2026-01-01T00:00:00.001Z' }];
      const late = await run();
      expect(late.status).toBe('UNSET');
      expect(late.reconcilingItems?.map((i) => i.id)).toEqual(['dep-b-usdt', 'dep-b-usdc', 'dep-b-usdt-2']);
      expect(late.assets.find((a) => a.assetId === 'USDT')).toMatchObject({ reconcilingItems: '3', residual: '0' });
      listed = listed.filter((i) => i.id !== 'dep-b-late');

      // An item that closes between the two reads (released and credited while the ledger was read): ERROR, run it again.
      const closing = listed;
      onRead = (n) => {
        if (n % 2 === 0) listed = closing.filter((i) => i.id !== 'dep-b-usdc');
      };
      const moved = await run();
      expect(moved).toMatchObject({
        status: 'ERROR',
        phase: { status: 'set', value: 'items' },
        errorCode: { status: 'set', value: LEDGER_RECONCILE_ITEMS_MOVED },
      });
      expect(moved.reconcilingItems).toBeUndefined();
      onRead = () => {};
      listed = closing;

      // A scheduled run on this rail reads the tick's instant, not a past one, so it is judged (UNSET here by BTC alone).
      await runDueReconciliationControls(db.sql, sources());
      const scheduled = await db.sql<Array<{ status: string; error_code: string; read_at: Date; as_of: Date }>>`
        SELECT status, error_code, read_at, as_of FROM reconciliation_control_runs
         WHERE control_id = ${defined.id} AND operation_id LIKE 'schedule:%' ORDER BY period_start DESC LIMIT 1
      `;
      expect(scheduled[0]).toMatchObject({ status: 'UNSET', error_code: '' });
      expect(scheduled[0]!.read_at.getTime()).toBeGreaterThanOrEqual(scheduled[0]!.as_of.getTime());

      // A residual still FAILs when an asset only the items name has no tolerance: the tolerance plays no part with items.
      await db.sql`UPDATE reconciliation_controls SET tolerance = '{"byAsset":{"USDT":"0","BTC":"0"}}'::jsonb WHERE id = ${defined.id}`;
      listed = closing.filter((i) => i.id !== 'dep-b-usdt-2');
      const noTolerance = await run();
      expect(noTolerance.status).toBe('FAIL');
      // USDC has no tolerance, so its evidence keeps no difference (as on every path), and the USDT break still FAILs.
      expect(noTolerance.assets.find((a) => a.assetId === 'USDC')).toMatchObject({ tolerance: 'unset', difference: 'unset' });
      expect(noTolerance.assets.find((a) => a.assetId === 'USDT')).toMatchObject({ residual: '1' });
    } finally {
      await server.close();
    }
  });

  it('leaves a past run on a rail with no open-items URL as it was: the statement is judged, never UNSET for items', async () => {
    const engine = new PostgresLedger(db.sql);
    await engine.post(
      recipes.deposit({
        userId: 'abcdeaaa-8888-4888-8888-000000000005',
        assetId: 'USDT',
        amount: amt('7'),
        rail: 'recon-noitems',
        railRef: 'recon-noitems-1',
      }),
    );
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', rail: 'recon-noitems', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'critical',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    const server = Fastify();
    server.get('/statement', async (req) => ({
      source: 'rail',
      rail: 'recon-noitems',
      asOf: (req.query as { asOf: string }).asOf,
      balances: [{ assetId: 'USDT', amount: '-9' }],
    }));
    const base = await server.listen({ port: 0, host: '127.0.0.1' });
    // The past instant must come after the deposit, so the ledger side is 7.
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      // Items are wired for another rail only.
      const sources = reconciliationSourcesFrom(undefined, new Map([['recon-noitems', `${base}/statement`]]), fetch, undefined, {
        urls: new Map([['recon-items-b', `${base}/items`]]),
        sign: (payload) => ({ 'x-test-signed': payload }),
      });
      const past = await runReconciliationControl(
        db.sql,
        approvals,
        actor,
        {
          controlId: defined.id,
          reason: REASON,
          approvalId: 'appr-noitems',
          operationId: nextOp(),
          asOf: new Date(Date.now() - 200).toISOString(),
          margin: '0',
        },
        sources,
      );
      expect(past.status).toBe('FAIL');
      expect(past.errorCode).not.toMatchObject({ value: LEDGER_RECONCILE_ITEMS_NOW_ONLY });
      expect(past.reconcilingItems).toBeUndefined();
    } finally {
      await server.close();
    }
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

  it('reads the outside snapshot over HTTP: matching is PASS, an unreadable source is ERROR, and every evaluation stays listed after retire', async () => {
    const owner = 'abcdefab-7777-4777-8777-';
    await insertAccount(`${owner}000000000001`);
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', assetId: 'USDT', ownerIdPrefix: owner },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'warning',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    const asked: string[] = [];
    const server = Fastify();
    server.get('/snapshot', async (req) => {
      asked.push(String((req.query as { asOf?: string }).asOf));
      return { source: 'rail', asOf: '2026-01-01T00:00:00.000Z', balances: [{ assetId: 'USDT', amount: '0' }] };
    });
    server.get('/broken', async () => ({ source: 'rail', balances: 'no' }));
    server.get('/future', async () => ({ source: 'rail', asOf: '2999-01-01T00:00:00.000Z', balances: [{ assetId: 'USDT', amount: '0' }] }));
    server.get('/moved', async (_req, reply) => reply.redirect('/snapshot'));
    const base = await server.listen({ port: 0, host: '127.0.0.1' });
    const run = (sources: ReconciliationSources) =>
      runReconciliationControl(
        db.sql,
        approvals,
        actor,
        { controlId: defined.id, reason: REASON, approvalId: 'appr-outside', operationId: nextOp() },
        sources,
      );
    try {
      const pass = await run(reconciliationSourcesFrom(`${base}/snapshot`));
      expect(pass).toMatchObject({ status: 'PASS', outsideSide: 'snapshot', sources: { outside: { asOf: '2026-01-01T00:00:00.000Z' } } });
      expect(asked).toEqual([pass.readAt]);

      // Not a snapshot, dated after the instant asked for, a redirect, a 404, and a closed port: each is ERROR with the
      // typed code, never PASS.
      const unreadable = [`${base}/broken`, `${base}/future`, `${base}/moved`, `${base}/missing`, 'http://127.0.0.1:9/closed'];
      const errors = [];
      for (const url of unreadable) errors.push(await run(reconciliationSourcesFrom(url)));
      for (const error of errors) {
        expect(error).toMatchObject({
          status: 'ERROR',
          phase: { status: 'set', value: 'outside' },
          errorCode: { status: 'set', value: LEDGER_RECONCILE_SOURCE_UNAVAILABLE },
          outsideSide: 'unavailable',
          assets: [],
        });
      }
      // No URL: the outside side is unset, as before.
      expect((await run(reconciliationSourcesFrom(undefined))).status).toBe('UNSET');

      await updateReconciliationControl(
        db.sql,
        actor,
        { controlId: defined.id, reason: REASON, lifecycle: 'retire', approvalId: 'appr-retire', operationId: nextOp() },
        approvals,
      );
      const listed = await listReconciliationControlRuns(db.sql, { controlId: defined.id });
      expect(listed.total).toBe(7);
      // Newest first by when each run started: the unset run was the last one.
      expect(listed.runs.map((r) => r.status)).toEqual(['UNSET', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'PASS']);
      expect(new Set(listed.runs.map((r) => r.id)).size).toBe(7);
      expect(listed.runs.map((r) => r.id)).toEqual(expect.arrayContaining([pass.id, ...errors.map((e) => e.id)]));
      const two = await listReconciliationControlRuns(db.sql, { controlId: defined.id, limit: 2 });
      expect(two).toMatchObject({ total: 7 });
      expect(two.runs).toEqual(listed.runs.slice(0, 2));
      await expect(listReconciliationControlRuns(db.sql, { controlId: '00000000-0000-4000-8000-00000000abcd' })).rejects.toMatchObject({
        code: LEDGER_RECONCILE_CONTROL_NOT_FOUND,
      });
    } finally {
      await server.close();
    }
  });

  it('feeds settled evaluations oldest first to svc-ops: a cursor never hands a row back, started and unsettled runs wait', async () => {
    const owner = 'abcdefab-8888-4888-8888-';
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', assetId: 'USDT', ownerIdPrefix: owner },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'critical',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(
        await runReconciliationControl(
          db.sql,
          approvals,
          actor,
          { controlId: defined.id, reason: REASON, approvalId: `appr-feed-${i}`, operationId: nextOp() },
          reconciliationSourcesFrom(undefined),
        ),
      );
    }
    const [first, second, started, open, fresh] = runs.map((r) => r!.id);
    // A microsecond apart, older than every other run in this database: the cursor must keep the microseconds.
    await db.sql`UPDATE reconciliation_control_runs SET finished_at = '2020-01-01T00:00:00.000001Z' WHERE id = ${first!}`;
    await db.sql`UPDATE reconciliation_control_runs SET finished_at = '2020-01-01T00:00:00.000002Z' WHERE id = ${second!}`;
    await db.sql`UPDATE reconciliation_control_runs SET status = 'started', finished_at = '2020-01-01T00:00:00.000003Z' WHERE id = ${started!}`;
    await db.sql`UPDATE reconciliation_control_runs SET finished_at = NULL WHERE id = ${open!}`;
    // Inside the settle window however slow the runner: stamped an hour ahead.
    await db.sql`UPDATE reconciliation_control_runs SET finished_at = clock_timestamp() + interval '1 hour' WHERE id = ${fresh!}`;

    const page1 = await listReconciliationEvaluations(db.sql, { after: null, limit: 1 });
    expect(page1.evaluations).toHaveLength(1);
    expect(page1.evaluations[0]).toMatchObject({
      run: { id: first, controlId: defined.id, status: 'UNSET' },
      finishedAt: '2020-01-01T00:00:00.000001Z',
      severity: { status: 'set', value: 'critical' },
    });
    expect(page1.evaluations[0]!.run).not.toHaveProperty('accounts');
    expect(page1.next).toEqual({ finishedAt: '2020-01-01T00:00:00.000001Z', id: first });

    const page2 = await listReconciliationEvaluations(db.sql, { after: page1.next, limit: 1 });
    expect(page2.evaluations.map((e) => e.run.id)).toEqual([second]);
    expect(page2.next).toEqual({ finishedAt: '2020-01-01T00:00:00.000002Z', id: second });

    // Everything after the second: the started row, the unfinished row and the run finished just now are not there.
    const rest = await listReconciliationEvaluations(db.sql, { after: page2.next, limit: 500 });
    const restIds = rest.evaluations.map((e) => e.run.id);
    expect(restIds).not.toContain(first);
    expect(restIds).not.toContain(second);
    expect(restIds).not.toContain(started);
    expect(restIds).not.toContain(open);
    expect(restIds).not.toContain(fresh);
    expect(rest.evaluations.every((e) => e.run.status !== 'started')).toBe(true);
    const order = rest.evaluations.map((e) => `${e.finishedAt}|${e.run.id}`);
    expect(order).toEqual([...order].sort());

    // Past the settle window, the fresh run is fed exactly once; an empty page keeps the cursor where it was.
    await db.sql`UPDATE reconciliation_control_runs SET finished_at = clock_timestamp() - make_interval(secs => ${RECONCILIATION_EVALUATION_SETTLE_SECONDS + 1}) WHERE id = ${fresh!}`;
    const settled = await listReconciliationEvaluations(db.sql, { after: page2.next, limit: 500 });
    expect(settled.evaluations.filter((e) => e.run.id === fresh)).toHaveLength(1);
    const drained = await listReconciliationEvaluations(db.sql, { after: settled.next, limit: 500 });
    expect(drained.evaluations.map((e) => e.run.id)).not.toContain(fresh);
    const empty = await listReconciliationEvaluations(db.sql, {
      after: { finishedAt: '2999-01-01T00:00:00.000000Z', id: first! },
      limit: 5,
    });
    expect(empty).toEqual({ evaluations: [], next: { finishedAt: '2999-01-01T00:00:00.000000Z', id: first } });

    await expect(listReconciliationEvaluations(db.sql, { after: null, limit: 501 })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(listReconciliationEvaluations(db.sql, { after: { finishedAt: 'yesterday', id: first! }, limit: 5 })).rejects.toMatchObject(
      {
        name: 'ZodError',
      },
    );
    await expect(listReconciliationEvaluations(db.sql, { limit: 5, extra: 1 })).rejects.toMatchObject({ name: 'ZodError' });

    // A stored run the contract cannot read is the ledger's fault: a plain error (a 500 on the door), never a ZodError (a 400).
    await db.sql`UPDATE reconciliation_control_runs SET sources = '{}'::jsonb WHERE id = ${first!}`;
    try {
      const broken = await listReconciliationEvaluations(db.sql, { after: null, limit: 1 }).catch((err: unknown) => err);
      expect(broken).toBeInstanceOf(Error);
      expect((broken as Error).name).toBe('Error');
      expect((broken as Error).message).toBe('reconciliation evaluation feed: a stored run does not fit the contract');
    } finally {
      await db.sql`UPDATE reconciliation_control_runs SET sources = ${db.sql.json(runs[0]!.sources)} WHERE id = ${first!}`;
    }
    expect((await listReconciliationEvaluations(db.sql, { after: null, limit: 1 })).evaluations[0]!.run.id).toBe(first);
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
      railStatement: async () => ({ kind: 'unset' }),
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
    const runs = await app.inject({ method: 'POST', url: '/operator/reconciliation/controls/runs', headers, payload: { controlId } });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toMatchObject({ controlId, total: 1, runs: [{ id: (run.json() as { id: string }).id, status: 'PASS' }] });
    const compliance = await issueAccessToken(
      { userId: ACTOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes: ['admin:compliance'], tier: 'basic', mfa: false },
      authConfig,
    );
    const read = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls/runs',
      headers: { authorization: `Bearer ${compliance.token}` },
      payload: { controlId },
    });
    expect(read.statusCode).toBe(200);
    const badRuns = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls/runs',
      headers,
      payload: { controlId: 'x' },
    });
    expect(badRuns.statusCode).toBe(400);
    const anonymous = await app.inject({ method: 'GET', url: '/operator/reconciliation/controls' });
    expect(anonymous.statusCode).toBe(401);
    const anonymousRuns = await app.inject({ method: 'POST', url: '/operator/reconciliation/controls/runs', payload: { controlId } });
    expect(anonymousRuns.statusCode).toBe(401);
    await app.close();
  });

  it('runs on the operator port with the outside source it was given: unreadable is ERROR', async () => {
    const app = Fastify({ logger: false });
    registerOperatorHttp(
      app,
      { sql: db.sql } as unknown as LedgerService,
      authConfig,
      approvals,
      reconciliationSourcesFrom('http://127.0.0.1:9/closed'),
    );
    await app.ready();
    const treasury = await issueAccessToken(
      { userId: ACTOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes: ['admin:treasury'], tier: 'basic', mfa: true },
      authConfig,
    );
    const defined = await defineReconciliationControl(db.sql, actor, {
      template: 'outside_balance',
      accountSet: { mode: 'query', assetId: 'USDT' },
      schedule: { cadence: 'daily', hour: 0, minute: 0 },
      severity: 'info',
      tolerance: { default: '0' },
      reason: REASON,
      activate: true,
    });
    const run = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls/run',
      headers: { authorization: `Bearer ${treasury.token}` },
      payload: { controlId: defined.id, reason: REASON, approvalId: 'appr-http-outside', operationId: nextOp() },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ status: 'ERROR', errorCode: { status: 'set', value: LEDGER_RECONCILE_SOURCE_UNAVAILABLE } });
    await app.close();
  });

  it('answers which asked transaction ids are booked: ids only, in the order asked, each once (OPS-reconciliation-04)', async () => {
    const engine = new PostgresLedger(db.sql);
    const posted = await engine.post(
      recipes.deposit({
        userId: 'abcdeaaa-6666-4666-8666-000000000001',
        assetId: 'BTC',
        amount: amt('1'),
        rail: 'test',
        railRef: 'recon-exist-1',
      }),
    );
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    const answer = await transactionsExist(db.sql, { txIds: [unknown, posted.id.toUpperCase(), posted.id] });
    expect(answer).toEqual({ found: [posted.id] });
    expect(await transactionsExist(db.sql, { txIds: [unknown] })).toEqual({ found: [] });
    await expect(transactionsExist(db.sql, { txIds: ['not-a-tx'] })).rejects.toMatchObject({ name: 'ZodError' });
  });
}
