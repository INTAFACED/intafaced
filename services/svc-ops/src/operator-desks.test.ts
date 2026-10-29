import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ActionApproval } from '@intafaced/contracts';
import {
  OPS_ALERT_STORAGE_UNCONFIGURED,
  OPS_APPROVAL_UNWIRED,
  OPS_CUSTODY_CHAIN_UNWIRED,
  OPS_CUSTODY_KEYS_UNPUBLISHED,
  OPS_CUSTODY_LEDGER_UNWIRED,
  OPS_RESTORE_ARCHIVE_UNCONFIGURED,
  OPS_RESTORE_ARCHIVE_UNPROBED,
  OPS_RESTORE_STORAGE_UNCONFIGURED,
} from './codes.js';
import { OpsService } from './ops-service.js';
import { createMemoryRestoreStore } from './restore-store.js';
import { createOpsRouter } from './router.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function founderApprovals() {
  let calls = 0;
  return {
    calls: () => calls,
    async consume(input: {
      approvalId: string;
      operationId: string;
      payloadHash: string;
      targetService: string;
      targetId: string;
      expectedVersion: string;
    }): Promise<ActionApproval> {
      calls += 1;
      return {
        ...input,
        actionType: 'ops.restore.record',
        requesterId: USER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: '2026-10-17T00:00:00.000Z',
        expiresAt: '2026-10-17T00:10:00.000Z',
        status: 'CONSUMED',
      };
    },
  };
}

describe('founder custody / restore / alerts desks', () => {
  it('refuses a session without admin:read', async () => {
    const api = createOpsRouter(new OpsService()).createCaller(await signed(principal({ scopes: ['ops:read'], mfa: false })));
    await expect(api.custody.ops.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.restore.watermarks()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.alerts.list({ after: null, limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads unconfigured custody, restore, and alerts without inventing numbers', async () => {
    const api = createOpsRouter(new OpsService(), undefined, { now: () => '2026-10-17T00:00:00.000Z' }).createCaller(await signed());
    const custody = await api.custody.ops.status();
    expect(custody.balances).toEqual({ status: 'unconfigured', code: OPS_CUSTODY_LEDGER_UNWIRED });
    expect(custody.tiers.every((tier) => tier.keyCount === null && tier.code === OPS_CUSTODY_KEYS_UNPUBLISHED)).toBe(true);
    expect(JSON.stringify(custody)).not.toMatch(/"keyCount":0|"balances":\{"status":"ok"/);

    const restore = await api.restore.watermarks();
    expect(restore).toEqual({
      asOf: '2026-10-17T00:00:00.000Z',
      archive: { configured: false, probed: false, code: OPS_RESTORE_ARCHIVE_UNCONFIGURED },
      watermarks: null,
      storage: { configured: false, code: OPS_RESTORE_STORAGE_UNCONFIGURED },
      restored: false,
    });

    // No alert store: the list refuses rather than answering an empty list or a zero count.
    await expect(api.alerts.list({ after: null, limit: 10 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
    await expect(api.alerts.periods({ limit: 10 })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
  });

  it('replays a custody approval and conflicts a different body on the same key', async () => {
    let n = 0;
    const api = createOpsRouter(new OpsService({ custodyFreezePolicy: 'open', id: () => `appr-${++n}` })).createCaller(
      await signed(principal({ scopes: ['admin:treasury'], mfa: true })),
    );
    const first = await api.custody.ops.createApproval({
      fromTier: 'cold',
      toTier: 'warm',
      amount: '1.5',
      idempotencyKey: 'custody-key-1',
    });
    const replay = await api.custody.ops.createApproval({
      fromTier: 'cold',
      toTier: 'warm',
      amount: '1.5',
      idempotencyKey: 'custody-key-1',
    });
    expect(replay).toEqual(first);
    expect(first.id).toBe('appr-1');
    await expect(
      api.custody.ops.createApproval({
        fromTier: 'warm',
        toTier: 'hot',
        amount: '2',
        idempotencyKey: 'custody-key-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('ops.idempotency_conflict') });
  });

  it('refuses execute without treasury, and with treasury does not move value', async () => {
    const ops = new OpsService({ custodyFreezePolicy: 'open', custodyWrap: 'present' });
    const denied = createOpsRouter(ops).createCaller(await signed(principal({ scopes: ['ops:write'], mfa: true })));
    await expect(denied.custody.ops.execute({ id: 'appr-1', idempotencyKey: 'execute-key-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const allowed = createOpsRouter(ops).createCaller(await signed(principal({ scopes: ['admin:treasury'], mfa: true })));
    await expect(allowed.custody.ops.execute({ id: 'appr-1', idempotencyKey: 'execute-key-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_CHAIN_UNWIRED),
    });
  });

  it('refuses a restore stamp when the archive URL is blank, before any approval', async () => {
    const approvals = founderApprovals();
    const api = createOpsRouter(new OpsService(), undefined, { approvals }).createCaller(
      await signed(principal({ scopes: ['admin:treasury'], mfa: true })),
    );
    await expect(
      api.restore.record({
        service: 'svc-ledger',
        kind: 'joint',
        watermark: 'ledger-seq-9',
        idempotencyKey: 'restore-key-1',
        approvalId: '',
        operationId: '',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_RESTORE_ARCHIVE_UNCONFIGURED),
    });
    expect(approvals.calls()).toBe(0);
  });

  it('stores an operator watermark when the archive URL is set and does not mark the platform restored', async () => {
    const approvals = founderApprovals();
    const api = createOpsRouter(new OpsService(), undefined, {
      now: () => '2026-10-17T01:00:00.000Z',
      restoreArchiveUrl: 'https://archive.example/restore',
      restoreStamps: createMemoryRestoreStore(),
      approvals,
    }).createCaller(await signed(principal({ scopes: ['admin:read', 'admin:treasury'], mfa: true })));
    const body = {
      service: 'svc-ledger',
      kind: 'joint',
      watermark: 'ledger-seq-9',
      idempotencyKey: 'restore-key-1',
      approvalId: 'appr-9',
      operationId: 'op-9',
    };
    const stamped = await api.restore.record(body);
    expect(stamped).toMatchObject({
      service: 'svc-ledger',
      kind: 'joint',
      watermark: 'ledger-seq-9',
      restored: false,
      approverId: APPROVER,
      archive: { configured: true, probed: false, code: OPS_RESTORE_ARCHIVE_UNPROBED },
    });
    const replay = await api.restore.record(body);
    expect(replay).toEqual(stamped);
    expect(approvals.calls()).toBe(1);
    await expect(api.restore.record({ ...body, watermark: 'ledger-seq-10' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const read = await api.restore.watermarks();
    expect(read.restored).toBe(false);
    expect(read.watermarks).toMatchObject({ stamped: true, rows: [{ watermark: 'ledger-seq-9' }] });
  });

  it('refuses a restore stamp with no durable storage, before any approval, and says so on the read', async () => {
    const approvals = founderApprovals();
    const api = createOpsRouter(new OpsService(), undefined, {
      restoreArchiveUrl: 'https://archive.example/restore',
      approvals,
    }).createCaller(await signed(principal({ scopes: ['admin:read', 'admin:treasury'], mfa: true })));
    await expect(
      api.restore.record({
        service: 'svc-ledger',
        kind: 'joint',
        watermark: 'ledger-seq-9',
        idempotencyKey: 'restore-key-3',
        approvalId: 'appr-9',
        operationId: 'op-9',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining(OPS_RESTORE_STORAGE_UNCONFIGURED) });
    expect(approvals.calls()).toBe(0);
    const read = await api.restore.watermarks();
    expect(read.watermarks).toBeNull();
    expect(read.storage).toEqual({ configured: false, code: OPS_RESTORE_STORAGE_UNCONFIGURED });
  });

  it('refuses restore when identity is unwired and stores nothing', async () => {
    const api = createOpsRouter(new OpsService(), undefined, {
      restoreArchiveUrl: 'https://archive.example/restore',
      restoreStamps: createMemoryRestoreStore(),
    }).createCaller(await signed(principal({ scopes: ['admin:read', 'admin:treasury'], mfa: true })));
    await expect(
      api.restore.record({
        service: 'svc-ledger',
        kind: 'joint',
        watermark: 'ledger-seq-9',
        idempotencyKey: 'restore-key-2',
        approvalId: 'appr-9',
        operationId: 'op-9',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining(OPS_APPROVAL_UNWIRED) });
    const read = await api.restore.watermarks();
    expect(read.watermarks).toEqual({ stamped: false, rows: [] });
  });

  it('refuses alert acknowledgement without a second factor, and without storage stores nothing', async () => {
    const alertId = '00000000-0000-4000-8000-000000000001';
    const denied = createOpsRouter(new OpsService()).createCaller(await signed(principal({ scopes: ['admin:read'] })));
    await expect(denied.alerts.acknowledge({ alertId, note: 'seen', idempotencyKey: 'alert-key-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const writer = createOpsRouter(new OpsService()).createCaller(await signed(principal({ scopes: ['admin:write'], mfa: true })));
    await expect(writer.alerts.acknowledge({ alertId, note: 'seen', idempotencyKey: 'alert-key-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    await expect(writer.alerts.snooze({ alertId, endsAt, idempotencyKey: 'alert-key-2' })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
    await expect(writer.alerts.unsnooze({ alertId, idempotencyKey: 'alert-key-3' })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
  });
});
