import {
  jointWatermark,
  nextRestoreStep,
  RESTORE_SERVICES,
  RESTORE_STEPS,
  type JointWatermark,
  type RestoreStep,
} from '@intafaced/contracts';
import {
  assertIdempotencyKey,
  archivePosture,
  consumeFounderApproval,
  type ApprovalConsumer,
  type WatermarkStamp,
} from '../operator-desks.js';
import {
  OPS_RESTORE_ARCHIVE_UNCONFIGURED,
  OPS_RESTORE_RUN_NOT_FOUND,
  OPS_RESTORE_STEP_OUT_OF_ORDER,
  OPS_RESTORE_TARGET_UNSET,
  OPS_RESTORE_WATERMARKS_DISAGREE,
  OpsError,
  type OpsRefuseCode,
} from '../codes.js';
import type { RestoreStampStore } from '../restore-store.js';
import { runFingerprint, type RestoreOutboxEntry, type RestoreRun, type RestoreRunStore, type RestoreStepRow } from './run-store.js';
import type { PlatformHalt, PlatformHaltReader } from './platform-halt.js';
import type { WatermarkReader, WatermarkReadResult } from './watermark-reader.js';

export interface RestoreDeskDeps {
  readonly store: RestoreRunStore;
  readonly stamps: RestoreStampStore;
  readonly reader: WatermarkReader;
  /** Whether the platform is halted: the joint check runs only while it is (bank, pay and identity answer live counts). */
  readonly halt: PlatformHaltReader;
  readonly approvals: ApprovalConsumer | undefined;
  readonly archiveUrl: () => string | null | undefined;
  /** The owner's storage target for restored data. Blank (null) keeps start and finalize off: `ops.restore_target_unset`. */
  readonly target: () => string | null;
  readonly now: () => string;
}

export interface JointView {
  readonly joint: JointWatermark;
  /** Whether the posting freeze is on now. While it is not, the steps refuse and this view's agreement proves nothing. */
  readonly halt: PlatformHalt;
  /** What each service answered, or why it could not. Never a made-up position. */
  readonly reads: ReadonlyArray<{ service: string; ok: boolean; code: string | null; message: string | null }>;
}

export interface RunView {
  readonly run: RestoreRun;
  readonly steps: readonly RestoreStepRow[];
  /** True only when all four steps exist as rows. The row for `finalize` is written last, after the joint check. */
  readonly restored: boolean;
  /** The next step the saga allows, or null when finished. */
  readonly next: RestoreStep | null;
  /** Whether finalize can be offered now: validate and preview done and the owner's target set. */
  readonly finalizeOffered: boolean;
}

/** The founder approval binds this payload, so a second founder approves a particular run and cut-off, not "a restore". */
const approvalFields = (run: RestoreRun) => ({ restoreNo: run.restoreNo, cutOff: run.cutOff });

/** An operator stamps `svc-ledger` or `ledger`; both mean the ledger. */
const stampService = (service: string) => service.replace(/^svc-/, '');

export function createRestoreDesk(deps: RestoreDeskDeps) {
  const { store } = deps;

  const requireArchive = () => {
    if (!archivePosture(deps.archiveUrl()).configured) {
      throw new OpsError(OPS_RESTORE_ARCHIVE_UNCONFIGURED, 'No joint-restore archive is configured. Nothing was started or recorded.');
    }
  };
  const requireTarget = () => {
    const target = deps.target();
    if (!target) {
      throw new OpsError(OPS_RESTORE_TARGET_UNSET, 'The owner has not set a restore storage target. Nothing is restored.');
    }
    return target;
  };
  const requireRun = async (restoreNo: string): Promise<RestoreRun> => {
    const run = await store.get(restoreNo);
    if (!run) throw new OpsError(OPS_RESTORE_RUN_NOT_FOUND, `No restore run ${restoreNo}.`);
    return run;
  };
  const doneSteps = (rows: readonly RestoreStepRow[]) => RESTORE_STEPS.filter((s) => rows.some((r) => r.step === s));

  /**
   * The joint check, refused unless the platform is halted (lead ruling 2026-10-31): bank, pay and identity answer live
   * counts, which equal their positions at the stamp only while nothing writes. A write that slips past the freeze moves a
   * count, so the check then disagrees; it never agrees on a halt it did not read.
   */
  async function refuse(run: RestoreRun, step: RestoreStep, actor: string, code: OpsRefuseCode, message: string): Promise<never> {
    await store.recordFailure(
      // One failure row per run, step and code: a later refusal for another reason is its own row, not a dropped duplicate.
      event('coreOpsRestoreFailed', `ops:restore:failed:${run.restoreNo}:${step}:${code}`, {
        restoreNo: run.restoreNo,
        actor,
        step,
        code,
        failedAt: deps.now(),
      }),
    );
    throw new OpsError(code, message);
  }

  /** Refuses unless the posting freeze is on now. Read first, so nothing else is asked while it is off. */
  async function requireHalted(run: RestoreRun, step: RestoreStep, actor: string): Promise<void> {
    const halt = await deps.halt.read();
    if (!halt.halted) {
      await refuse(run, step, actor, halt.code, `The stamps were not checked against the services because ${halt.message}`);
    }
  }

  /**
   * The joint check, refused unless the platform is halted (lead ruling 2026-10-31): bank, pay and identity answer live
   * counts, which equal their positions at the stamp only while nothing writes. A write that gets past the freeze moves a
   * count, so the check then disagrees; it never agrees on a halt it did not read. The caller checks the halt again just
   * before it writes its row.
   */
  async function haltedJoint(run: RestoreRun, step: RestoreStep, actor: string): Promise<JointView> {
    await requireHalted(run, step, actor);
    const live = await jointFor(run);
    if (!live.halt.halted) {
      await refuse(run, step, actor, live.halt.code, `The stamps were not checked against the services because ${live.halt.message}`);
    }
    if (!live.joint.agree) {
      const reasons = live.joint.services
        .filter((s) => !s.ok)
        .map((s) => `${s.service}: ${s.reason}`)
        .join(', ');
      await refuse(
        run,
        step,
        actor,
        OPS_RESTORE_WATERMARKS_DISAGREE,
        step === 'finalize' ? `Nothing was restored: ${reasons}.` : `The stamps and the services do not agree (${reasons}).`,
      );
    }
    return live;
  }

  async function jointFor(run: RestoreRun): Promise<JointView> {
    const [halt, stamps, results] = await Promise.all([
      deps.halt.read(),
      deps.stamps.list(),
      Promise.all(
        RESTORE_SERVICES.map(async (service): Promise<[string, WatermarkReadResult]> => [service, await deps.reader.read(service)]),
      ),
    ]);
    // The stamp list is newest first; the joint check takes the newest per service from the end.
    const oldestFirst: WatermarkStamp[] = [...stamps].reverse();
    const joint = jointWatermark({
      cutOff: run.cutOff,
      stamps: oldestFirst.map((s) => ({ service: stampService(s.service), watermark: s.watermark })),
      reads: results.flatMap(([, r]) => (r.ok ? [r.value] : [])),
    });
    return {
      joint,
      halt,
      reads: results.map(([service, r]) => ({ service, ok: r.ok, code: r.ok ? null : r.code, message: r.ok ? null : r.message })),
    };
  }

  const event = (name: RestoreOutboxEntry['event'], key: string, payload: Record<string, unknown>): RestoreOutboxEntry => ({
    event: name,
    idempotencyKey: key,
    payload,
    createdAt: deps.now(),
  });

  async function view(run: RestoreRun): Promise<RunView> {
    const steps = await store.steps(run.restoreNo);
    const done = doneSteps(steps);
    const next = nextRestoreStep(done);
    return {
      run,
      steps,
      restored: RESTORE_STEPS.every((s) => steps.some((r) => r.step === s)),
      next,
      finalizeOffered: next === 'finalize' && deps.target() !== null,
    };
  }

  return {
    async start(input: { restoreNo: string; cutOff: string; idempotencyKey: string; actor: string }): Promise<RunView> {
      requireArchive();
      requireTarget();
      const key = assertIdempotencyKey(input.idempotencyKey);
      const cut = new Date(input.cutOff);
      if (Number.isNaN(cut.getTime()))
        throw new OpsError(OPS_RESTORE_WATERMARKS_DISAGREE, 'The cut-off is not a date. Nothing was started.');
      const run: RestoreRun = { restoreNo: input.restoreNo, cutOff: cut.toISOString(), startedBy: input.actor, startedAt: deps.now() };
      const kept = await store.start(
        key,
        runFingerprint({ restoreNo: run.restoreNo, cutOff: run.cutOff }),
        run,
        event('coreOpsRestoreStarted', `ops:restore:started:${run.restoreNo}`, {
          restoreNo: run.restoreNo,
          actor: run.startedBy,
          cutOff: run.cutOff,
          startedAt: run.startedAt,
        }),
      );
      return view(kept);
    },

    async list(): Promise<readonly RestoreRun[]> {
      return store.list();
    },

    async get(restoreNo: string): Promise<RunView & { live: JointView }> {
      const run = await requireRun(restoreNo);
      const [base, live] = await Promise.all([view(run), jointFor(run)]);
      // Finalize is offered only while the platform is halted, since it refuses otherwise.
      return { ...base, finalizeOffered: base.finalizeOffered && live.halt.halted, live };
    },

    /**
     * Records `restore_clean`, `validate` or `preview`. Each is its own row and only the next step is accepted. Validate
     * and preview also need the four services to agree now, so a failed validation leaves finalize unoffered.
     */
    async step(input: {
      restoreNo: string;
      step: Exclude<RestoreStep, 'finalize'>;
      idempotencyKey: string;
      actor: string;
    }): Promise<RunView> {
      requireArchive();
      const key = assertIdempotencyKey(input.idempotencyKey);
      const run = await requireRun(input.restoreNo);
      const body = { restoreNo: run.restoreNo, step: input.step };
      const fingerprint = runFingerprint(body);
      const before = await store.steps(run.restoreNo);
      const existing = before.find((r) => r.step === input.step);
      const expected = nextRestoreStep(doneSteps(before));
      if (!existing && expected !== input.step) {
        await store.recordFailure(
          event('coreOpsRestoreFailed', `ops:restore:failed:${run.restoreNo}:${input.step}`, {
            restoreNo: run.restoreNo,
            actor: input.actor,
            step: input.step,
            code: OPS_RESTORE_STEP_OUT_OF_ORDER,
            failedAt: deps.now(),
          }),
        );
        throw new OpsError(OPS_RESTORE_STEP_OUT_OF_ORDER, `The next step is ${expected ?? 'none (finished)'}, not ${input.step}.`);
      }
      let detail: Record<string, unknown> = { attested: true };
      if (!existing && input.step !== 'restore_clean') {
        const live = await haltedJoint(run, input.step, input.actor);
        detail = { attested: true, joint: live.joint };
        await requireHalted(run, input.step, input.actor);
      }
      await store.appendStep(
        key,
        fingerprint,
        { restoreNo: run.restoreNo, step: input.step, actor: input.actor, approverId: null, detail, at: deps.now() },
        null,
      );
      return view(run);
    },

    /**
     * The irreversible step. Needs the owner's target, validate and preview already recorded, a fresh agreeing joint
     * check, and a founder approval from a second person bound to this run and cut-off. The finalize row is written
     * last; `restored` becomes true only once it exists next to the other three.
     */
    async finalize(input: {
      restoreNo: string;
      idempotencyKey: string;
      approvalId: string;
      operationId: string;
      actor: string;
    }): Promise<RunView> {
      requireArchive();
      requireTarget();
      const key = assertIdempotencyKey(input.idempotencyKey);
      const run = await requireRun(input.restoreNo);
      const before = await store.steps(run.restoreNo);
      const stored = before.find((r) => r.step === 'finalize');
      if (stored) {
        await store.appendStep(
          key,
          runFingerprint({ restoreNo: run.restoreNo, step: 'finalize', approvalId: input.approvalId, operationId: input.operationId }),
          stored,
          null,
        );
        return view(run);
      }
      const expected = nextRestoreStep(doneSteps(before));
      if (expected !== 'finalize') {
        throw new OpsError(OPS_RESTORE_STEP_OUT_OF_ORDER, `The next step is ${expected ?? 'none (finished)'}, not finalize.`);
      }
      const live = await haltedJoint(run, 'finalize', input.actor);
      const consumed = await consumeFounderApproval(deps.approvals, {
        approvalId: input.approvalId,
        operationId: input.operationId,
        actionType: 'ops.restore.finalize',
        targetService: 'svc-ops',
        targetId: `restore:${run.restoreNo}`,
        fields: approvalFields(run),
        requesterId: input.actor,
        requestId: key.slice(0, 128),
      });
      // The freeze may have been lifted while the approval was spent; the row is written only while it still holds.
      await requireHalted(run, 'finalize', input.actor);
      const at = deps.now();
      await store.appendStep(
        key,
        runFingerprint({ restoreNo: run.restoreNo, step: 'finalize', approvalId: input.approvalId, operationId: input.operationId }),
        {
          restoreNo: run.restoreNo,
          step: 'finalize',
          actor: input.actor,
          approverId: consumed.approverId ?? null,
          detail: { attested: true, joint: live.joint },
          at,
        },
        event('coreOpsRestoreCompleted', `ops:restore:completed:${run.restoreNo}`, {
          restoreNo: run.restoreNo,
          actor: input.actor,
          approverId: consumed.approverId ?? '',
          completedAt: at,
        }),
      );
      return view(run);
    },
  };
}

export type RestoreDesk = ReturnType<typeof createRestoreDesk>;
