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
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db/testing';
import {
  OPS_CONTROL_MARGIN_UNSET,
  OPS_CONTROL_POLICY_UNSET,
  OPS_CONTROL_STATE_ILLEGAL,
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_BUILTIN_IMMUTABLE,
  LEDGER_RECONCILE_CONTROL_NOT_FOUND,
  LEDGER_RECONCILE_SOURCE_UNAVAILABLE,
  updateReconciliationControlInputSchema,
} from '@intafaced/contracts/ledger-reconciliation';
import { createLedgerRouter } from '../router.js';
import { registerOperatorHttp } from '../operator-http.js';
import { ledgerActionPayloadHash, stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { withJournalGuardsOff } from '../db/journal-guards.testkit.js';
import { ReconciliationControlError } from './reconciliation-control-error.js';
import {
  defineReconciliationControl,
  listReconciliationControlRuns,
  listReconciliationControls,
  runDueReconciliationControls,
  runReconciliationControl,
  updateReconciliationControl,
  type ReconciliationSources,
  type SnapshotRead,
} from './reconciliation-controls.js';
import { reconciliationSourcesFrom } from './reconciliation-sources.js';
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
}
