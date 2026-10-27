import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase } from '@intafaced/db';
import {
  consoleModeApprovalFields,
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { approvalPayloadHash } from '../operator-desks.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { MemoryConsoleModeStore, SqlConsoleModeStore, type ConsoleModeStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-24T08:00:00.000Z';
const REASON = 'database upgrade window for the ops schema';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

async function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

/** A stand-in for identity: an approval names one action, target and payload, is approved by a second founder, and is spent once. */
function identity() {
  const rows = new Map<string, { approval: ActionApproval; approved: boolean; spent: boolean }>();
  let n = 0;
  const reject = (code: string): never => {
    throw new Error(code);
  };
  return {
    spent: () => [...rows.values()].filter((r) => r.spent).length,
    propose(actionType: string, fields: Record<string, string>, approved = true) {
      n += 1;
      const approval: ActionApproval = {
        approvalId: `ap_${n}`,
        operationId: `op_${n}`,
        payloadHash: approvalPayloadHash(actionType, fields),
        targetService: 'svc-ops',
        targetId: 'console',
        expectedVersion: '1',
        actionType,
        requesterId: USER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'p1',
        createdAt: NOW,
        expiresAt: '2026-10-24T08:10:00.000Z',
        status: 'CONSUMED',
      };
      rows.set(approval.approvalId, { approval, approved, spent: false });
      return { approvalId: approval.approvalId, operationId: approval.operationId };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId) ?? reject('action_approval.not_found');
      // Only a second founder's approval makes it spendable: the asker alone cannot.
      if (!row!.approved) reject('action_approval.not_approved');
      if (row!.spent) reject('action_approval.consumed');
      if (input.payloadHash !== row!.approval.payloadHash) reject('action_approval.payload_mismatch');
      if (input.targetId !== row!.approval.targetId || input.operationId !== row!.approval.operationId)
        reject('action_approval.target_mismatch');
      row!.spent = true;
      return row!.approval;
    },
  };
}

function build(store: ConsoleModeStore | null = new MemoryConsoleModeStore()) {
  const ids = identity();
  const router = createOpsRouter(new OpsService(), undefined, {
    approvals: ids,
    now: () => NOW,
    ...(store ? { consoleMode: store } : {}),
  });
  return { ids, store, caller: (scopes = ['admin:read', 'admin:write']) => signed(scopes).then((ctx) => router.createCaller(ctx)) };
}

const on = (ids: ReturnType<typeof identity>, approved = true) => ({
  action: 'ops.console_mode.on' as const,
  reason: REASON,
  ...ids.propose('ops.console_mode.on', consoleModeApprovalFields('ops.console_mode.on', REASON), approved),
});
const off = (ids: ReturnType<typeof identity>, approved = true) => ({
  action: 'ops.console_mode.off' as const,
  ...ids.propose('ops.console_mode.off', consoleModeApprovalFields('ops.console_mode.off', null), approved),
});

describe('console maintenance mode', () => {
  it('reads off before any change, with nothing seeded', async () => {
    const { caller } = build();
    expect(await (await caller()).consoleMode.get()).toEqual({
      readOnly: false,
      reason: null,
      revision: 0,
      changedAt: null,
      requesterId: null,
      approverId: null,
      asOf: NOW,
    });
  });

  it('turns on with a reason under a second founder’s approval, and a retry spends nothing', async () => {
    const { caller, ids } = build();
    const c = await caller();
    const input = on(ids);
    const first = await c.consoleMode.set(input);
    expect(first).toMatchObject({ outcome: 'changed', mode: { readOnly: true, reason: REASON, revision: 1, approverId: APPROVER } });
    expect(await c.consoleMode.set(input)).toMatchObject({ outcome: 'replayed', mode: { readOnly: true, revision: 1 } });
    expect(ids.spent()).toBe(1);
  });

  it('a replay with another reason is refused, and nothing changes', async () => {
    const { caller, ids } = build();
    const c = await caller();
    const input = on(ids);
    await c.consoleMode.set(input);
    await expect(c.consoleMode.set({ ...input, reason: 'another reason for the same approval' })).rejects.toThrow(
      /ops\.idempotency_conflict/,
    );
    expect(await c.consoleMode.get()).toMatchObject({ readOnly: true, reason: REASON, revision: 1 });
    expect(ids.spent()).toBe(1);
  });

  it('two runs of one approval at once: one changes the mode, the other answers replayed', async () => {
    const { caller, ids } = build();
    const c = await caller();
    const input = on(ids);
    const both = await Promise.all([c.consoleMode.set(input), c.consoleMode.set(input)]);
    expect(both.map((r) => r.outcome).sort()).toEqual(['changed', 'replayed']);
    expect(await c.consoleMode.get()).toMatchObject({ readOnly: true, revision: 1 });
    expect(ids.spent()).toBe(1);
  });

  it('refuses a change one founder approved alone, either way, and leaves the mode as it was', async () => {
    const { caller, ids } = build();
    const c = await caller();
    await expect(c.consoleMode.set(on(ids, false))).rejects.toThrow(/action_approval/);
    expect((await c.consoleMode.get()).readOnly).toBe(false);
    await c.consoleMode.set(on(ids));
    await expect(c.consoleMode.set(off(ids, false))).rejects.toThrow(/action_approval/);
    expect((await c.consoleMode.get()).readOnly).toBe(true);
    expect(await c.consoleMode.set(off(ids))).toMatchObject({ outcome: 'changed', mode: { readOnly: false, reason: null, revision: 2 } });
  });

  it('an approval for "off" cannot turn it on, and a second "off" is a logged no-op', async () => {
    const { caller, ids, store } = build();
    const c = await caller();
    const wrong = { ...off(ids), action: 'ops.console_mode.on' as const, reason: REASON };
    await expect(c.consoleMode.set(wrong)).rejects.toThrow(/payload_mismatch/);
    expect(await c.consoleMode.set(off(ids))).toMatchObject({ outcome: 'noop', mode: { readOnly: false, revision: 0 } });
    expect((store as MemoryConsoleModeStore).log.map((r) => r.outcome)).toEqual(['noop']);
  });

  it('a short reason is refused before any approval is spent; reads need admin:read and writes admin:write', async () => {
    const { caller, ids } = build();
    await expect((await caller()).consoleMode.set({ ...on(ids), reason: 'too short' })).rejects.toThrow();
    expect(ids.spent()).toBe(0);
    await expect((await caller(['admin:read'])).consoleMode.set(on(ids))).rejects.toThrow();
    await expect((await caller(['ops:read'])).consoleMode.get()).rejects.toThrow();
  });

  it('with no storage the mode cannot be read or changed, and says so', async () => {
    const { caller, ids } = build(null);
    const c = await caller();
    await expect(c.consoleMode.get()).rejects.toThrow(/ops\.console_mode_storage_unconfigured/);
    await expect(c.consoleMode.set(on(ids))).rejects.toThrow(/ops\.console_mode_storage_unconfigured/);
    expect(ids.spent()).toBe(0);
  });
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('console maintenance mode on real PostgreSQL', () => {
  it('stores each change once, keeps an append-only log, and survives a new store', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const { caller, ids } = build(new SqlConsoleModeStore(sql));
      const c = await caller();
      const input = on(ids);
      await c.consoleMode.set(input);
      expect(await c.consoleMode.set(input)).toMatchObject({ outcome: 'replayed' });
      expect(await new SqlConsoleModeStore(sql).get()).toMatchObject({ readOnly: true, reason: REASON, revision: 1 });
      await c.consoleMode.set(off(ids));
      await c.consoleMode.set(off(ids));
      const log = await sql<{ outcome: string }[]>`SELECT outcome FROM ops.console_mode_log ORDER BY logged_at, revision_after, outcome`;
      expect(log.map((r) => r.outcome).sort()).toEqual(['changed', 'changed', 'noop']);
      await expect(sql`DELETE FROM ops.console_mode_log`).rejects.toThrow(/append-only/);
      await migrateOutreach(sql, 'down');
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
