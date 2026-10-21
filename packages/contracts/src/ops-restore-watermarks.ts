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
});
export type RestoreWatermarkRead = z.infer<typeof restoreWatermarkReadSchema>;

export interface RestoreStampView {
  readonly service: string;
  readonly watermark: string;
}

export type RestoreDisagreeReason = 'stamp_missing' | 'position_differs' | 'written_after_cutoff' | 'read_missing' | 'cutoff_invalid';

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

/**
 * The joint check. `stamps` may hold several per service; the newest (last) wins.
 * Agree only when every service has a stamp, a read, a read position equal to
 * its stamp, and no write after the cut-off.
 */
export function jointWatermark(input: {
  readonly cutOff: string;
  readonly stamps: readonly RestoreStampView[];
  readonly reads: readonly RestoreWatermarkRead[];
}): JointWatermark {
  const cut = Date.parse(input.cutOff);
  const services = RESTORE_SERVICES.map((service): RestoreServiceVerdict => {
    const stamp = [...input.stamps].reverse().find((s) => s.service === service)?.watermark ?? null;
    const read = input.reads.find((r) => r.service === service) ?? null;
    const position = read?.position ?? null;
    const fail = (reason: RestoreDisagreeReason): RestoreServiceVerdict => ({ service, ok: false, reason, stamp, position });
    if (Number.isNaN(cut)) return fail('cutoff_invalid');
    if (stamp === null) return fail('stamp_missing');
    if (read === null) return fail('read_missing');
    if (read.position !== stamp) return fail('position_differs');
    if (read.lastWriteAt !== null && !(Date.parse(read.lastWriteAt) <= cut)) return fail('written_after_cutoff');
    return { service, ok: true, reason: null, stamp, position };
  });
  return { agree: services.every((s) => s.ok), cutOff: input.cutOff, services };
}

/** Restore steps in the only order they may run (RS-2). Each is its own stored row. */
export const RESTORE_STEPS = ['restore_clean', 'validate', 'preview', 'finalize'] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

/** The next step allowed after the steps already recorded; null when finished or the record is out of order. */
export function nextRestoreStep(done: readonly RestoreStep[]): RestoreStep | null {
  for (let i = 0; i < done.length; i += 1) if (done[i] !== RESTORE_STEPS[i]) return null;
  return RESTORE_STEPS[done.length] ?? null;
}
