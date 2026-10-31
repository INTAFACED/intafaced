/**
 * RESTORE WATERMARKS — what each service reports as its position, and the joint check (OPS-ledger-desk-05, ENGINE RS-3).
 *
 * The four services keep independent sequences, so their watermarks are never
 * compared with each other. Each is compared with the stamp an operator
 * recorded for that service, and every service must have been quiet since the
 * one cut-off instant chosen for the joint restore. Any gap names the service
 * and the reason; none of this moves money.
 *
 * Browser-safe: zod only.
 */

import { z } from 'zod';

export const OPS_RESTORE_WATERMARKS_DISAGREE = 'ops.restore_watermarks_disagree' as const;
export const OPS_RESTORE_TARGET_UNSET = 'ops.restore_target_unset' as const;
export const OPS_RESTORE_STEP_OUT_OF_ORDER = 'ops.restore_step_out_of_order' as const;

export const RESTORE_SERVICES = ['ledger', 'identity', 'bank', 'pay'] as const;
export type RestoreService = (typeof RESTORE_SERVICES)[number];

/** `restore.watermark.read`: served by each of the four services, read only. */
export const restoreWatermarkReadSchema = z.object({
  service: z.enum(RESTORE_SERVICES),
  /** What the position counts, for example `ledger_tx.seq`. */
  kind: z.string().min(1),
  /** Monotonic durable position as a decimal string. */
  position: z.string().regex(/^\d+$/),
  /** Hash at that position when the service keeps a chain, otherwise null. */
  integrity: z.string().min(1).nullable(),
  /** When the service last wrote at all; null when it never has. */
  lastWriteAt: z.string().datetime({ offset: true }).nullable(),
  readAt: z.string().datetime({ offset: true }),
  /**
   * The instant `position` was read as of, echoed from the request. Absent on a live read. A service that cannot say
   * what its position was at that instant refuses by name (`<service>.restore_asof_unanswerable`), never a live number.
   */
  asOf: z.string().datetime({ offset: true }).optional(),
});
export type RestoreWatermarkRead = z.infer<typeof restoreWatermarkReadSchema>;

/**
 * `restore.watermark.read` as of an instant: the joint restore's cut-off. On a live stack other writes land after the
 * cut-off, so a live position can never equal the stamp; the position as of the cut-off can.
 */
export const restoreWatermarkReadInputSchema = z.object({ asOf: z.string().datetime({ offset: true }) }).strict();
// A door served as a GET carries it as the `asOf` query parameter; a POST door as the JSON body.
export type RestoreWatermarkReadInput = z.infer<typeof restoreWatermarkReadInputSchema>;

export interface RestoreStampView {
  readonly service: string;
  readonly watermark: string;
}

export type RestoreDisagreeReason =
  | 'stamp_missing'
  | 'position_differs'
  | 'written_after_cutoff'
  | 'read_missing'
  | 'cutoff_invalid'
  /** The service answered a live position, or one as of another instant, so it says nothing about the cut-off. */
  | 'read_not_as_of'
  /** The read was taken before the cut-off, so its position cannot be the one at the cut-off. */
  | 'read_before_cutoff';

export interface RestoreServiceVerdict {
  readonly service: RestoreService;
  readonly ok: boolean;
  readonly reason: RestoreDisagreeReason | null;
  readonly stamp: string | null;
  readonly position: string | null;
}

export interface JointWatermark {
  readonly agree: boolean;
  readonly cutOff: string;
  readonly services: readonly RestoreServiceVerdict[];
}

type JointInput = {
  readonly cutOff: string;
  readonly stamps: readonly RestoreStampView[];
  readonly reads: readonly RestoreWatermarkRead[];
};

/**
 * The shared walk: for each service the newest (last) stamp and the newest (last) read, then `judge` for the rest. A
 * missing stamp or read is named before anything is judged.
 */
function joint(
  input: JointInput,
  cutValid: boolean,
  judge: (read: RestoreWatermarkRead, stamp: string) => RestoreDisagreeReason | null,
): JointWatermark {
  const services = RESTORE_SERVICES.map((service): RestoreServiceVerdict => {
    const stamp = input.stamps.findLast((s) => s.service === service)?.watermark ?? null;
    const read = input.reads.findLast((r) => r.service === service) ?? null;
    const position = read?.position ?? null;
    const fail = (reason: RestoreDisagreeReason): RestoreServiceVerdict => ({ service, ok: false, reason, stamp, position });
    if (!cutValid) return fail('cutoff_invalid');
    if (stamp === null) return fail('stamp_missing');
    if (read === null) return fail('read_missing');
    const reason = judge(read, stamp);
    return reason === null ? { service, ok: true, reason: null, stamp, position } : fail(reason);
  });
  return { agree: services.every((s) => s.ok), cutOff: input.cutOff, services };
}

/**
 * The joint check on live reads. Agree only when every service has a stamp, a read, a read position equal to its stamp,
 * and no write after the cut-off.
 */
export function jointWatermark(input: JointInput): JointWatermark {
  const cut = Date.parse(input.cutOff);
  return joint(input, !Number.isNaN(cut), (read, stamp) => {
    if (read.position !== stamp) return 'position_differs';
    if (read.lastWriteAt !== null && !(Date.parse(read.lastWriteAt) <= cut)) return 'written_after_cutoff';
    return null;
  });
}

/** An instant at millisecond precision or coarser, so two readings of it compare exactly. */
const MILLIS_INSTANT = /^[^.]*(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The joint check as of the cut-off (OPS-ledger-desk-05, RS-3). Each service is read as of `cutOff`; agree only when every
 * service has a stamp and a read made as of exactly that instant, at or after it, whose position equals its stamp. Writes
 * after the cut-off do not count against it: they are what a restore to the cut-off leaves out. `integrity` and
 * `lastWriteAt` on an as-of read stay the live values and are shown, never judged.
 */
export function jointWatermarkAsOf(input: JointInput): JointWatermark {
  const cutValid = restoreWatermarkReadInputSchema.safeParse({ asOf: input.cutOff }).success && MILLIS_INSTANT.test(input.cutOff);
  const cut = Date.parse(input.cutOff);
  return joint(input, cutValid, (read, stamp) => {
    if (read.asOf === undefined || !MILLIS_INSTANT.test(read.asOf) || Date.parse(read.asOf) !== cut) return 'read_not_as_of';
    // A read taken before the cut-off can only know its live position, not the one at the cut-off.
    if (!(Date.parse(read.readAt) >= cut)) return 'read_before_cutoff';
    if (read.position !== stamp) return 'position_differs';
    return null;
  });
}

/** Restore steps in the only order they may run (RS-2). Each is its own stored row. */
export const RESTORE_STEPS = ['restore_clean', 'validate', 'preview', 'finalize'] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

/** The next step allowed after the steps already recorded; null when finished or the record is out of order. */
export function nextRestoreStep(done: readonly RestoreStep[]): RestoreStep | null {
  for (let i = 0; i < done.length; i += 1) if (done[i] !== RESTORE_STEPS[i]) return null;
  return RESTORE_STEPS[done.length] ?? null;
}
