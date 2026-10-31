import { describe, expect, it } from 'vitest';
import type { ActionApproval, RestoreService, RestoreWatermarkRead } from '@intafaced/contracts';
import {
  OPS_APPROVAL_NOT_FOUNDERS,
  OPS_IDEMPOTENCY_CONFLICT,
  OPS_RESTORE_ARCHIVE_UNCONFIGURED,
  OPS_RESTORE_HALT_UNREADABLE,
  OPS_RESTORE_PLATFORM_NOT_HALTED,
  OPS_RESTORE_RUN_NOT_FOUND,
  OPS_RESTORE_STEP_OUT_OF_ORDER,
  OPS_RESTORE_TARGET_UNSET,
  OPS_RESTORE_WATERMARKS_DISAGREE,
} from '../codes.js';
import { createMemoryRestoreStore } from '../restore-store.js';
import { createRestoreDesk } from './desk.js';
import { createMemoryRestoreRunStore } from './run-store.js';
import type { PlatformHalt, PlatformHaltReader } from './platform-halt.js';
import type { WatermarkReader, WatermarkReadResult } from './watermark-reader.js';

const CUT_OFF = '2026-10-20T12:00:00.000Z';
const REQUESTER = 'founder-a';
const APPROVER = 'founder-b';
const POSITIONS: Record<RestoreService, string> = { ledger: '10', identity: '7', bank: '3', pay: '99' };
const HALTED: PlatformHaltReader = { read: async () => ({ halted: true }) };
const NOT_HALTED: PlatformHalt = { halted: false, code: OPS_RESTORE_PLATFORM_NOT_HALTED, message: 'The posting freeze is off' };

function reads(over: Partial<Record<RestoreService, string | null>> = {}): WatermarkReader {
  return {
    async read(service): Promise<WatermarkReadResult> {
      const position = service in over ? over[service] : POSITIONS[service];
      if (position === null || position === undefined)
        return { ok: false, code: 'ops.restore_watermark_unavailable', message: `${service} is down` };
      const value: RestoreWatermarkRead = {
        service,
        kind: 'seq',
        position,
        integrity: null,
        lastWriteAt: '2026-10-20T11:00:00.000Z',
        readAt: '2026-10-20T12:01:00.000Z',
      };
      return { ok: true, value };
    },
  };
}

async function stamped(services: RestoreService[] = ['ledger', 'identity', 'bank', 'pay']) {
  const stamps = createMemoryRestoreStore();
  for (const service of services) {
    await stamps.append(`stamp-${service}`, `fp-${service}`, {
      service: service === 'ledger' ? 'svc-ledger' : service,
      kind: 'joint',
      watermark: POSITIONS[service],
      recordedAt: '2026-10-20T11:30:00.000Z',
      recordedBy: REQUESTER,
      approverId: APPROVER,
    });
  }
  return stamps;
}

function approvals(founders = true) {
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
    }) {
      calls += 1;
      return {
        ...input,
        actionType: 'ops.restore.finalize',
        requesterId: REQUESTER,
        approverId: founders ? APPROVER : REQUESTER,
        approverIsFounder: founders,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: '2026-10-20T11:00:00.000Z',
        expiresAt: '2026-10-20T11:10:00.000Z',
        status: 'CONSUMED',
      } as ActionApproval;
    },
  };
}

async function desk(
  over: {
    reader?: WatermarkReader;
    halt?: PlatformHaltReader;
    stamps?: Awaited<ReturnType<typeof stamped>>;
    target?: string | null;
    archive?: string | null;
    founders?: boolean;
  } = {},
) {
  const store = createMemoryRestoreRunStore();
  const approver = approvals(over.founders ?? true);
  return {
    store,
    approver,
    desk: createRestoreDesk({
      store,
      stamps: over.stamps ?? (await stamped()),
      reader: over.reader ?? reads(),
      halt: over.halt ?? HALTED,
      approvals: approver,
      archiveUrl: () => (over.archive === undefined ? 'https://archive.example/restore' : over.archive),
      target: () => (over.target === undefined ? 'owner-target' : over.target),
      now: () => '2026-10-20T12:05:00.000Z',
    }),
  };
}

const start = (d: Awaited<ReturnType<typeof desk>>['desk'], key = 'start-key-1') =>
  d.start({ restoreNo: 'R-1', cutOff: CUT_OFF, idempotencyKey: key, actor: REQUESTER });
const step = (d: Awaited<ReturnType<typeof desk>>['desk'], s: 'restore_clean' | 'validate' | 'preview') =>
  d.step({ restoreNo: 'R-1', step: s, idempotencyKey: `step-${s}-key`, actor: REQUESTER });
const finalize = (d: Awaited<ReturnType<typeof desk>>['desk']) =>
  d.finalize({ restoreNo: 'R-1', idempotencyKey: 'finalize-key-1', approvalId: 'ap-1', operationId: 'op-1', actor: REQUESTER });

describe('restore desk', () => {
  it('walks the steps in order, and restored is true only once all four rows exist', async () => {
    const { desk: d, store } = await desk();
    const started = await start(d);
    expect(started.restored).toBe(false);
    expect(started.next).toBe('restore_clean');
    await step(d, 'restore_clean');
    await step(d, 'validate');
    const previewed = await step(d, 'preview');
    expect(previewed.restored).toBe(false);
    expect(previewed.finalizeOffered).toBe(true);
    const done = await finalize(d);
    expect(done.restored).toBe(true);
    expect(done.steps.map((s) => s.step)).toEqual(['restore_clean', 'validate', 'preview', 'finalize']);
    expect(done.steps[3]).toMatchObject({ actor: REQUESTER, approverId: APPROVER });
    expect(store.outbox().map((e) => e.event)).toEqual(['coreOpsRestoreStarted', 'coreOpsRestoreCompleted']);
  });

  it('returns the first run for the same key and body, and conflicts a different body', async () => {
    const { desk: d } = await desk();
    const first = await start(d);
    expect((await start(d)).run).toEqual(first.run);
    await expect(
      d.start({ restoreNo: 'R-1', cutOff: '2026-10-20T13:00:00.000Z', idempotencyKey: 'start-key-1', actor: REQUESTER }),
    ).rejects.toMatchObject({
      code: OPS_IDEMPOTENCY_CONFLICT,
    });
  });

  it('refuses a step out of order and writes no row', async () => {
    const { desk: d, store } = await desk();
    await start(d);
    await expect(step(d, 'validate')).rejects.toMatchObject({ code: OPS_RESTORE_STEP_OUT_OF_ORDER });
    await expect(finalize(d)).rejects.toMatchObject({ code: OPS_RESTORE_STEP_OUT_OF_ORDER });
    expect(await store.steps('R-1')).toEqual([]);
  });

  it('returns the stored row when a step is repeated, and never writes a second one', async () => {
    const { desk: d, store } = await desk();
    await start(d);
    await step(d, 'restore_clean');
    await step(d, 'restore_clean');
    expect(await store.steps('R-1')).toHaveLength(1);
  });

  it('refuses validate and finalize when a service stamp is missing, and restores nothing', async () => {
    const { desk: d, store } = await desk({ stamps: await stamped(['ledger', 'identity', 'bank']) });
    await start(d);
    await step(d, 'restore_clean');
    await expect(step(d, 'validate')).rejects.toMatchObject({ code: OPS_RESTORE_WATERMARKS_DISAGREE });
    const run = await d.get('R-1');
    expect(run.finalizeOffered).toBe(false);
    expect(run.restored).toBe(false);
    expect((await store.steps('R-1')).map((s) => s.step)).toEqual(['restore_clean']);
    expect(store.outbox().some((e) => e.event === 'coreOpsRestoreFailed')).toBe(true);
  });

  it('refuses a differing position and an unreachable service the same way', async () => {
    const differ = await desk({ reader: reads({ bank: '4' }) });
    await start(differ.desk);
    await step(differ.desk, 'restore_clean');
    await expect(step(differ.desk, 'validate')).rejects.toMatchObject({ code: OPS_RESTORE_WATERMARKS_DISAGREE });
    const down = await desk({ reader: reads({ pay: null }) });
    await start(down.desk);
    await step(down.desk, 'restore_clean');
    await expect(step(down.desk, 'validate')).rejects.toMatchObject({ code: OPS_RESTORE_WATERMARKS_DISAGREE });
    const view = await down.desk.get('R-1');
    expect(view.live.reads.find((r) => r.service === 'pay')).toMatchObject({ ok: false, code: 'ops.restore_watermark_unavailable' });
  });

  it('refuses finalize when the services drifted after validate, consuming no approval', async () => {
    const stamps = await stamped();
    const store = createMemoryRestoreRunStore();
    let reader = reads();
    const approver = approvals();
    const d = createRestoreDesk({
      store,
      stamps,
      reader: { read: (s) => reader.read(s) },
      halt: HALTED,
      approvals: approver,
      archiveUrl: () => 'https://archive.example/restore',
      target: () => 'owner-target',
      now: () => '2026-10-20T12:05:00.000Z',
    });
    await start(d);
    await step(d, 'restore_clean');
    await step(d, 'validate');
    await step(d, 'preview');
    reader = reads({ ledger: '11' });
    await expect(finalize(d)).rejects.toMatchObject({ code: OPS_RESTORE_WATERMARKS_DISAGREE });
    expect(approver.calls()).toBe(0);
    expect((await d.get('R-1')).restored).toBe(false);
  });

  it('refuses validate while the posting freeze is off or unreadable, though the counts agree, and writes no row', async () => {
    for (const answer of [
      NOT_HALTED,
      { halted: false, code: OPS_RESTORE_HALT_UNREADABLE, message: 'svc-ledger did not answer' },
    ] as const) {
      const { desk: d, store } = await desk({ halt: { read: async () => answer } });
      await start(d);
      await step(d, 'restore_clean');
      await expect(step(d, 'validate')).rejects.toMatchObject({ code: answer.code });
      expect((await store.steps('R-1')).map((s) => s.step)).toEqual(['restore_clean']);
      expect(
        store
          .outbox()
          .filter((e) => e.event === 'coreOpsRestoreFailed')
          .map((e) => e.payload.code),
      ).toEqual([answer.code]);
      const view = await d.get('R-1');
      expect(view.live.halt).toEqual(answer);
      expect(view.live.joint.agree).toBe(true);
      expect(view.finalizeOffered).toBe(false);
    }
  });

  it('refuses finalize once the freeze is lifted after preview, consuming no approval', async () => {
    let halt: PlatformHalt = { halted: true };
    const { desk: d, approver, store } = await desk({ halt: { read: async () => halt } });
    await start(d);
    for (const s of ['restore_clean', 'validate', 'preview'] as const) await step(d, s);
    halt = NOT_HALTED;
    await expect(finalize(d)).rejects.toMatchObject({ code: OPS_RESTORE_PLATFORM_NOT_HALTED });
    expect(approver.calls()).toBe(0);
    expect((await store.steps('R-1')).map((s) => s.step)).toEqual(['restore_clean', 'validate', 'preview']);
    halt = { halted: true };
    expect((await finalize(d)).restored).toBe(true);
  });

  it('does not offer finalize while the freeze is off', async () => {
    let halt: PlatformHalt = { halted: true };
    const { desk: d } = await desk({ halt: { read: async () => halt } });
    await start(d);
    for (const s of ['restore_clean', 'validate', 'preview'] as const) await step(d, s);
    expect((await d.get('R-1')).finalizeOffered).toBe(true);
    halt = NOT_HALTED;
    expect((await d.get('R-1')).finalizeOffered).toBe(false);
  });

  it('writes no finalize row when the freeze is lifted while the approval is spent', async () => {
    // Every read answers halted until `afterApproval` is set, which the approval stand-in does as it is spent.
    let afterApproval = false;
    const {
      desk: d,
      approver,
      store,
    } = await desk({
      halt: { read: async () => (afterApproval ? NOT_HALTED : { halted: true }) },
    });
    const consume = approver.consume.bind(approver);
    approver.consume = async (input) => {
      afterApproval = true;
      return consume(input);
    };
    await start(d);
    for (const s of ['restore_clean', 'validate', 'preview'] as const) await step(d, s);
    await expect(finalize(d)).rejects.toMatchObject({ code: OPS_RESTORE_PLATFORM_NOT_HALTED });
    expect(approver.calls()).toBe(1);
    expect((await store.steps('R-1')).map((s) => s.step)).toEqual(['restore_clean', 'validate', 'preview']);
    expect(store.outbox().some((e) => e.event === 'coreOpsRestoreCompleted')).toBe(false);
  });

  it('refuses finalize without a second founder, and records nothing', async () => {
    const { desk: d, store } = await desk({ founders: false });
    await start(d);
    await step(d, 'restore_clean');
    await step(d, 'validate');
    await step(d, 'preview');
    await expect(finalize(d)).rejects.toMatchObject({ code: OPS_APPROVAL_NOT_FOUNDERS });
    expect((await store.steps('R-1')).map((s) => s.step)).toEqual(['restore_clean', 'validate', 'preview']);
    expect((await d.get('R-1')).restored).toBe(false);
  });

  it('keeps start and finalize off while the owner target is blank, and refuses with no archive', async () => {
    const off = await desk({ target: null });
    await expect(start(off.desk)).rejects.toMatchObject({ code: OPS_RESTORE_TARGET_UNSET });
    const noArchive = await desk({ archive: null });
    await expect(start(noArchive.desk)).rejects.toMatchObject({ code: OPS_RESTORE_ARCHIVE_UNCONFIGURED });
  });

  it('finalize is a no-op replay once the row exists', async () => {
    const { desk: d, approver } = await desk();
    await start(d);
    for (const s of ['restore_clean', 'validate', 'preview'] as const) await step(d, s);
    const first = await finalize(d);
    const again = await finalize(d);
    expect(again.steps).toEqual(first.steps);
    expect(approver.calls()).toBe(1);
  });

  it('names a run that does not exist', async () => {
    const { desk: d } = await desk();
    await expect(d.get('nope')).rejects.toMatchObject({ code: OPS_RESTORE_RUN_NOT_FOUND });
  });
});
