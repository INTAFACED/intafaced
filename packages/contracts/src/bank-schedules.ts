import { z } from 'zod';
import { payAmountStringSchema } from './merchant-control.js';

/**
 * BK-xfer-10 (contracts first): one-off scheduled payments, standing-order edits and failed runs.
 *
 * Each occurrence posts one bankTransfer keyed `schedule:<scheduleId>:<occurrence>` (unchanged). A `once` schedule has
 * exactly one occurrence, 0. Owner value, never defaulted: the edit cutoff. Blank means no edit inside the unknown
 * window (refuses `bank.schedule_cutoff`), and the page says so.
 */
const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const positiveAmountString = payAmountStringSchema.refine((v) => /[1-9]/.test(v), 'amount must be greater than zero');

export const BANK_SCHEDULE_CADENCES = ['once', 'daily', 'weekly', 'monthly'] as const;
export const bankScheduleCadenceSchema = z.enum(BANK_SCHEDULE_CADENCES);
export type BankScheduleCadence = z.infer<typeof bankScheduleCadenceSchema>;

/**
 * Edit a schedule. Idempotent by (scheduleId, revision): `revision` is the revision the caller last read, so the same
 * edit sent twice applies once and a stale edit refuses `bank.schedule_revision_conflict`. The recipient and the
 * source space are not editable (strict: those fields are refused). A `once` schedule has no end date.
 */
export const bankScheduleUpdateInputSchema = z
  .object({
    scheduleId: id,
    revision: z.number().int().min(0),
    amount: positiveAmountString.optional(),
    cadence: bankScheduleCadenceSchema.optional(),
    reference: z.string().max(140).optional(),
    endsAt: timestamp.nullable().optional(),
  })
  .strict()
  .refine((v) => v.amount !== undefined || v.cadence !== undefined || v.reference !== undefined || v.endsAt !== undefined, {
    message: 'an edit must change something',
  })
  .refine((v) => !(v.cadence === 'once' && v.endsAt !== undefined && v.endsAt !== null), {
    path: ['endsAt'],
    message: 'a once schedule has no end date',
  });
export type BankScheduleUpdateInput = z.infer<typeof bankScheduleUpdateInputSchema>;

export const bankScheduleUpdateResultSchema = z
  .object({ scheduleId: id, revision: z.number().int().min(1), nextRunAt: timestamp.nullable() })
  .strict();

/** Operator retry of one failed run: the retry adopts the existing post (same key), never a new one. */
export const bankScheduleRetryRunInputSchema = z
  .object({ scheduleId: id, occurrence: z.number().int().min(0), reason: z.string().min(3).max(500) })
  .strict();

/** Run outcomes a schedule history shows. A frozen account records `skipped` with its code; a posting freeze `failed`. */
export const BANK_SCHEDULE_RUN_STATUSES = ['settled', 'rejected', 'skipped', 'failed'] as const;
export const bankScheduleRunSchema = z
  .object({
    occurrence: z.number().int().min(0),
    status: z.enum(BANK_SCHEDULE_RUN_STATUSES),
    code: z.string().nullable(),
    ranAt: timestamp,
  })
  .strict();

export const BANK_SCHEDULE_CODES = ['bank.schedule_cutoff', 'bank.schedule_revision_conflict', 'bank.schedule_cutoff_unset'] as const;
export type BankScheduleCode = (typeof BANK_SCHEDULE_CODES)[number];
