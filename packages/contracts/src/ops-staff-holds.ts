import { z } from 'zod';

/**
 * Wire types for staff holds on funds (OPS-accounts-desk-01, ops ENGINE LC-8 and LC-9; ADR 2026-10-22
 * service-access-calls 3.7).
 *
 * A staff hold reserves part of one customer's balance in the ledger: available falls, total does not. svc-ops keeps
 * the hold row, its state and the four-eyes rule and posts the three ledger recipes (`staffHoldPlace`,
 * `staffHoldRelease`, `staffHoldConfirm`); it never holds a balance of its own. Placing a hold needs one staff member
 * and a reason. A staff release and a confirm each need a second founder's approval, spent once through identity's
 * action approval; only the expiry worker releases without one. Release and confirm on one hold never run at once:
 * the second waits for the first and then meets the amount that is left.
 *
 * Browser-safe: zod only.
 */

export const STAFF_HOLD_TARGET_SERVICE = 'svc-ops' as const;
export const STAFF_HOLD_ACTIONS = ['ops.hold.release', 'ops.hold.confirm'] as const;
export type StaffHoldAction = (typeof STAFF_HOLD_ACTIONS)[number];

/** svc-ops has no durable storage, so holds cannot be read or placed. */
export const STAFF_HOLD_STORAGE_UNCONFIGURED = 'ops.hold_storage_unconfigured' as const;
/** svc-ops has no ledger URL or credential, so nothing can be held, released or confirmed. */
export const STAFF_HOLD_LEDGER_UNCONFIGURED = 'ops.hold_ledger_unconfigured' as const;
/** The action is not allowed in the hold's state, or another action on the hold is still settling. */
export const STAFF_HOLD_STATE_ILLEGAL = 'ops.hold_state_illegal' as const;
/** A release larger than what is held, or a confirm of anything but exactly what is held. */
export const STAFF_HOLD_AMOUNT_EXCEEDS_REMAINING = 'ops.hold_amount_exceeds_remaining' as const;
/** The owner has set no longest hold expiry, so no expiry is offered (the screen says "not set"). */
export const STAFF_HOLD_EXPIRY_UNSET = 'ops.hold_expiry_unset' as const;
/** The expiry asked for is longer than the owner's longest hold expiry. */
export const STAFF_HOLD_EXPIRY_TOO_LONG = 'ops.hold_expiry_too_long' as const;
/** The owner has not named the account a confirmed hold moves to. Nothing posts. */
export const STAFF_HOLD_CONFIRM_ACCOUNT_UNSET = 'owner.decision' as const;
/** No hold has that number. */
export const STAFF_HOLD_NOT_FOUND = 'ops.hold_not_found' as const;

export const STAFF_HOLD_REASON_MAX = 80;
/** Positive, at most 20 whole digits and 18 decimals, no sign, no leading zeros: the ledger's own amount shape. */
export const STAFF_HOLD_AMOUNT_PATTERN = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
export const STAFF_HOLD_ASSET_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/;

/**
 * The one spelling of an amount both founders sign and svc-ops stores: `15.00` and `15` are the same release, so the
 * fraction's trailing zeros (and a bare point) are dropped. The input must already match STAFF_HOLD_AMOUNT_PATTERN.
 */
export function normaliseStaffHoldAmount(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Approval target for one hold: `hold:<holdNo>`. */
export function staffHoldTargetId(holdNo: string): string {
  return `hold:${holdNo}`;
}

/** What a release approval signs. */
export function staffHoldReleaseFields(holdNo: string, amount: string): Record<string, string> {
  return { targetId: staffHoldTargetId(holdNo), amount };
}

/** What a confirm approval signs: the hold only; the amount is whatever is still held when it runs. */
export function staffHoldConfirmFields(holdNo: string): Record<string, string> {
  return { targetId: staffHoldTargetId(holdNo) };
}

const iso = z.string().datetime({ offset: true });
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a lowercase account id');
const holdNo = z.string().regex(/^[1-9][0-9]{0,18}$/, 'a hold number');
const amount = z
  .string()
  .regex(STAFF_HOLD_AMOUNT_PATTERN, 'a decimal amount')
  .refine((v) => /[1-9]/.test(v), 'an amount above zero');
/** What is still held may be zero. */
const remaining = z.string().regex(STAFF_HOLD_AMOUNT_PATTERN, 'a decimal amount');
const key = z.string().trim().min(8).max(160);
const approval = { approvalId: z.string().trim().min(1).max(128), operationId: z.string().trim().min(1).max(128) };

export const STAFF_HOLD_STATES = ['placing', 'active', 'partially_released', 'released', 'confirmed', 'expired', 'refused'] as const;
export type StaffHoldState = (typeof STAFF_HOLD_STATES)[number];

/**
 * One ledger post svc-ops made or is making for a hold. `settling` means the post's outcome is not known yet: the hold
 * takes no other action until it is resolved by reading the ledger by key.
 */
export const staffHoldMovementSchema = z.object({
  kind: z.enum(['place', 'release', 'confirm']),
  /** The release number or confirm attempt (place is 1). */
  no: z.string(),
  amount,
  status: z.enum(['settling', 'posted', 'refused', 'pending_retry']),
  /** `approval`, `expiry` (release by the expiry worker) or `staff` (place). */
  cause: z.enum(['staff', 'approval', 'expiry']),
  idempotencyKey: z.string(),
  requesterId: z.string().nullable(),
  approverId: z.string().nullable(),
  txId: z.string().nullable(),
  /** The ledger's typed refusal, when it refused. */
  code: z.string().nullable(),
  at: iso,
});
export type StaffHoldMovement = z.infer<typeof staffHoldMovementSchema>;

export const staffHoldSchema = z.object({
  holdNo,
  userId: z.string(),
  assetId: z.string(),
  amount,
  /** What is still held. */
  remaining,
  state: z.enum(STAFF_HOLD_STATES),
  reason: z.string(),
  /** When the expiry worker releases what is left; null when the hold has no expiry. */
  expiresAt: iso.nullable(),
  placedBy: z.string(),
  placedAt: iso,
  movements: z.array(staffHoldMovementSchema),
});
export type StaffHold = z.infer<typeof staffHoldSchema>;

export const staffHoldListInputSchema = z.object({ userId: uuid });
export const staffHoldListSchema = z.object({
  holds: z.array(staffHoldSchema),
  /** The owner's settings that change what the desk offers, as configured. */
  settings: z.object({
    /** Longest expiry in hours, or null: no expiry is offered (`ops.hold_expiry_unset`). */
    expiryMaxHours: z.number().int().positive().nullable(),
    /** Whether the owner has named the account confirmed holds move to; false refuses confirm `owner.decision`. */
    confirmAccountSet: z.boolean(),
  }),
  asOf: iso,
});
export type StaffHoldList = z.infer<typeof staffHoldListSchema>;

export const staffHoldPlaceInputSchema = z.object({
  userId: uuid,
  assetId: z.string().regex(STAFF_HOLD_ASSET_PATTERN, 'an asset code'),
  amount,
  reason: z.string().trim().min(1).max(STAFF_HOLD_REASON_MAX),
  /** Hours until the hold releases itself; omit or null for no expiry. Measured from the server's clock. */
  expiresInHours: z.number().int().positive().max(8760).nullable().optional(),
  /** Business key from the console: a retry returns the stored hold. */
  idempotencyKey: key,
});
export type StaffHoldPlaceInput = z.infer<typeof staffHoldPlaceInputSchema>;

export const staffHoldReleaseInputSchema = z.object({ holdNo, amount, ...approval });
export type StaffHoldReleaseInput = z.infer<typeof staffHoldReleaseInputSchema>;

export const staffHoldConfirmInputSchema = z.object({ holdNo, ...approval });
export type StaffHoldConfirmInput = z.infer<typeof staffHoldConfirmInputSchema>;

export const staffHoldResultSchema = z.object({
  hold: staffHoldSchema,
  /** `done` posted; `replayed` is a retry of a stored action; `settling` means the ledger's answer was lost and is being read back. */
  outcome: z.enum(['done', 'replayed', 'settling']),
});
export type StaffHoldResult = z.infer<typeof staffHoldResultSchema>;
