import { z } from 'zod';

/**
 * Wire types for the founder console's maintenance mode (OPS-admin-access-08, ops-console-admin-access-034).
 *
 * While maintenance mode is on, the console is read-only: every console write refuses `ops.console_read_only` and a banner
 * says so; reads still work. It is the console's own switch. It is neither the platform posting freeze (svc-ledger) nor an
 * account freeze (svc-identity), and turning it on or off never reads or writes either.
 *
 * Turning it on and turning it off are both four-eyes approvals consumed by svc-ops through identity's action approval:
 * one founder asks, a different founder approves, svc-ops spends the approval once. This file names the two actions and
 * binds the target id and the idempotency key so both founders sign the same thing.
 *
 * Browser-safe: zod only.
 */

export const CONSOLE_MODE_TARGET_SERVICE = 'svc-ops' as const;
export const CONSOLE_MODE_TARGET_ID = 'console' as const;
export const CONSOLE_MODE_ACTIONS = ['ops.console_mode.on', 'ops.console_mode.off'] as const;
export type ConsoleModeAction = (typeof CONSOLE_MODE_ACTIONS)[number];

/** Every console write refuses this while maintenance mode is on. */
export const CONSOLE_READ_ONLY = 'ops.console_read_only' as const;
/** svc-ops has no durable storage, so the mode cannot be read or set (and so is never on). */
export const CONSOLE_MODE_STORAGE_UNCONFIGURED = 'ops.console_mode_storage_unconfigured' as const;

export const CONSOLE_MODE_REASON_MIN = 12;
export const CONSOLE_MODE_REASON_MAX = 500;

/** `ops.console_mode.on:<approvalId>`: a retry with the same approval returns the stored change and spends nothing. */
export function consoleModeIdempotencyKey(action: ConsoleModeAction, approvalId: string): string {
  return `${action}:${approvalId}`;
}

/** What the approval signs: the reason when turning on, nothing beyond the target when turning off. */
export function consoleModeApprovalFields(action: ConsoleModeAction, reason: string | null): Record<string, string> {
  return action === 'ops.console_mode.on'
    ? { targetId: CONSOLE_MODE_TARGET_ID, reason: reason ?? '' }
    : { targetId: CONSOLE_MODE_TARGET_ID };
}

const iso = z.string().datetime({ offset: true });

/** The mode in force. `revision` 0 with `changedAt` null means it was never changed: off, by construction. */
export const consoleModeSchema = z.object({
  readOnly: z.boolean(),
  /** Why it was turned on; null while off. */
  reason: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  changedAt: iso.nullable(),
  requesterId: z.string().nullable(),
  approverId: z.string().nullable(),
  asOf: iso,
});
export type ConsoleMode = z.infer<typeof consoleModeSchema>;

const approval = { approvalId: z.string().min(1).max(128), operationId: z.string().min(1).max(128) };

export const consoleModeSetInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ops.console_mode.on'),
    reason: z.string().trim().min(CONSOLE_MODE_REASON_MIN).max(CONSOLE_MODE_REASON_MAX),
    ...approval,
  }),
  z.object({ action: z.literal('ops.console_mode.off'), ...approval }),
]);
export type ConsoleModeSetInput = z.infer<typeof consoleModeSetInputSchema>;

export const consoleModeSetOutputSchema = z.object({
  mode: consoleModeSchema,
  /** `changed` moved the mode; `noop` found it already in that state (still logged); `replayed` is a retry of a stored change. */
  outcome: z.enum(['changed', 'noop', 'replayed']),
  idempotencyKey: z.string(),
});
export type ConsoleModeSetOutput = z.infer<typeof consoleModeSetOutputSchema>;
