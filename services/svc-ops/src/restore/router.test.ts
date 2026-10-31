import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ActionApproval } from '@intafaced/contracts';
import {
  OPS_CUSTODY_CHAIN_UNWIRED,
  OPS_CUSTODY_KEYS_UNPUBLISHED,
  OPS_CUSTODY_LEDGER_UNWIRED,
  OPS_RESTORE_ARCHIVE_UNCONFIGURED,
  OPS_RESTORE_ARCHIVE_UNPROBED,
  OPS_RESTORE_STORAGE_UNCONFIGURED,
} from '../codes.js';
import { OpsService } from '../ops-service.js';
import { createMemoryRestoreStore } from '../restore-store.js';
import { createRestoreDesk } from './desk.js';
import { createMemoryRestoreRunStore } from './run-store.js';
import { createOpsRouter } from '../router.js';

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

function desk(over: { target?: string | null } = {}) {
  return createRestoreDesk({
    store: createMemoryRestoreRunStore(),
    stamps: createMemoryRestoreStore(),
    reader: { read: async () => ({ ok: false, code: 'ops.restore_watermark_unavailable', message: 'down' }) },
    halt: { read: async () => ({ halted: true }) },
    approvals: undefined,
    archiveUrl: () => 'https://archive.example/restore',
    target: () => (over.target === undefined ? 'owner-target' : over.target),
    now: () => '2026-10-20T12:05:00.000Z',
  });
}

describe('restore saga procedures', () => {
  it('lists no backups when the archive URL is blank or no probe is wired', async () => {
    const api = createOpsRouter(new OpsService(), undefined, { now: () => '2026-10-20T12:00:00.000Z' }).createCaller(await signed());
    expect(await api.restore.backups()).toEqual({
      asOf: '2026-10-20T12:00:00.000Z',
      archive: { configured: false, probed: false, code: OPS_RESTORE_ARCHIVE_UNCONFIGURED },
      backups: [],
      reason: OPS_RESTORE_ARCHIVE_UNCONFIGURED,
    });
    const set = createOpsRouter(new OpsService(), undefined, { restoreArchiveUrl: 'https://archive.example/restore' }).createCaller(
      await signed(),
    );
    expect((await set.restore.backups()).reason).toBe(OPS_RESTORE_ARCHIVE_UNPROBED);
  });

  it('lists a probed manifest and keeps a failed probe empty', async () => {
    const row = { id: 'full-9', kind: 'full' as const, sequence: '9', takenAt: '2026-10-20T12:00:00.000Z' };
    const listed = createOpsRouter(new OpsService(), undefined, {
      now: () => '2026-10-20T12:00:00.000Z',
      restoreArchiveUrl: 'https://archive.example/restore',
      restoreArchiveProbe: async () => ({ probed: true, backups: [row] }),
    }).createCaller(await signed());
    expect(await listed.restore.backups()).toEqual({
      asOf: '2026-10-20T12:00:00.000Z',
      archive: { configured: true, probed: true, code: null },
      backups: [row],
      reason: 'The archive listed these backups.',
    });
    const empty = createOpsRouter(new OpsService(), undefined, {
      restoreArchiveUrl: 'https://archive.example/restore',
      restoreArchiveProbe: async () => ({ probed: true, backups: [] }),
    }).createCaller(await signed());
    expect(await empty.restore.backups()).toMatchObject({
      archive: { probed: true, code: null },
      backups: [],
      reason: 'The archive listed no backups.',
    });
    const failed = createOpsRouter(new OpsService(), undefined, {
      restoreArchiveUrl: 'https://archive.example/restore',
      restoreArchiveProbe: async () => {
        throw new Error('down');
      },
    }).createCaller(await signed());
    expect(await failed.restore.backups()).toMatchObject({
      archive: { configured: true, probed: false, code: OPS_RESTORE_ARCHIVE_UNPROBED },
      backups: [],
      reason: OPS_RESTORE_ARCHIVE_UNPROBED,
    });
  });

  it('refuses the writes without admin:treasury and the reads without admin:read', async () => {
    const api = createOpsRouter(new OpsService(), undefined, { restoreDesk: desk() }).createCaller(
      await signed(principal({ scopes: ['ops:read'], mfa: false })),
    );
    await expect(api.restore.runs()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.restore.start({ restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', idempotencyKey: 'start-key-1' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const reader = createOpsRouter(new OpsService(), undefined, { restoreDesk: desk() }).createCaller(await signed());
    await expect(
      reader.restore.finalize({ restoreNo: 'R-1', idempotencyKey: 'finalize-key', approvalId: 'a', operationId: 'o' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses every run call with the storage code when no desk is wired', async () => {
    const api = createOpsRouter(new OpsService()).createCaller(
      await signed(principal({ scopes: ['admin:read', 'admin:treasury'], mfa: true })),
    );
    await expect(api.restore.runs()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_RESTORE_STORAGE_UNCONFIGURED),
    });
    await expect(
      api.restore.start({ restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', idempotencyKey: 'start-key-1' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(OPS_RESTORE_STORAGE_UNCONFIGURED),
    });
  });

  it('starts a run, shows it with the live read failing honestly, and keeps start off while the target is blank', async () => {
    const scopes = principal({ scopes: ['admin:read', 'admin:treasury'], mfa: true });
    const api = createOpsRouter(new OpsService(), undefined, { restoreDesk: desk() }).createCaller(await signed(scopes));
    const started = await api.restore.start({ restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', idempotencyKey: 'start-key-1' });
    expect(started).toMatchObject({ restored: false, next: 'restore_clean', finalizeOffered: false });
    const run = await api.restore.run({ restoreNo: 'R-1' });
    expect(run.live.joint.agree).toBe(false);
    expect(run.live.reads.every((r) => !r.ok && r.code === 'ops.restore_watermark_unavailable')).toBe(true);
    const off = createOpsRouter(new OpsService(), undefined, { restoreDesk: desk({ target: null }) }).createCaller(await signed(scopes));
    await expect(
      off.restore.start({ restoreNo: 'R-2', cutOff: '2026-10-20T12:00:00.000Z', idempotencyKey: 'start-key-2' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('ops.restore_target_unset'),
    });
  });
});
