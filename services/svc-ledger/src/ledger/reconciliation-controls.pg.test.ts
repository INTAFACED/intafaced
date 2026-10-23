/**
 * OPS-reconciliation-01. Operator controls beside the three built-in proofs.
 * TEST amounts only. The result row is committed before a source is read.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db/testing';
import {
  OPS_CONTROL_MARGIN_UNSET,
  OPS_CONTROL_POLICY_UNSET,
  LEDGER_RECONCILE_ASOF_INVALID,
  LEDGER_RECONCILE_BUILTIN_IMMUTABLE,
} from '@intafaced/contracts/ledger-reconciliation';
import { createLedgerRouter } from '../router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { withJournalGuardsOff } from '../db/journal-guards.testkit.js';
import { ReconciliationControlError } from './reconciliation-control-error.js';
import {
  defineReconciliationControl,
  listReconciliationControls,
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
    await expect(
      defineReconciliationControl(db.sql, actor, {
        template: 'threshold',
        accountSet: { mode: 'query', assetId: 'USDT' },
        reason: REASON,
        activate: true,
      }),
    ).rejects.toMatchObject({ code: OPS_CONTROL_POLICY_UNSET });
    const listed = await listReconciliationControls(db.sql);
    const draft = listed.find((control) => !control.builtin && control.state === 'draft');
    expect(draft?.tolerance).toEqual({ status: 'unset' });
    const audit = await db.sql<Array<{ actor_id: string; reason: string; action: string }>>`
      SELECT actor_id, reason, action FROM reconciliation_control_audit WHERE control_id = ${draft!.id}
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
}
