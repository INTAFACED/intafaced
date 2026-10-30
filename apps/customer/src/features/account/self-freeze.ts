// hand-declared-ok: the auth.selfFreeze answers are declared in svc-identity, not in packages/contracts yet
import { z } from 'zod';

export const FREEZE_REASONS = ['compromise', 'temporary', 'personal'] as const;
export type FreezeReason = (typeof FREEZE_REASONS)[number];

export const freezeDone = z.object({
  frozen: z.literal(true),
  reason: z.enum(FREEZE_REASONS),
  since: z.string(),
  changed: z.boolean(),
});
export const freezeStatus = z.object({
  frozen: z.boolean(),
  reason: z.enum(FREEZE_REASONS).nullable(),
  since: z.string().nullable(),
});
export type FreezeStatus = z.infer<typeof freezeStatus>;
export const liftDone = z.object({ frozen: z.literal(false), changed: z.boolean(), liftedAt: z.string().nullable() });

/** The lift's own typed refusals; `identity.step_up_required` opens the confirmation instead. */
export const LIFT_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  'identity.self_freeze_lift_wait_unset': 'liftWaitUnset',
  'identity.second_factor_required': 'liftNeedsFactor',
};

/**
 * The wait left, in the unit a person reads: seconds under two minutes, minutes under two hours, else hours (the owner's
 * wait is capped at 30 days). Always rounded up, so the person never comes back too early.
 */
export function liftWaitWords(seconds: number): {
  key: 'liftTooSoonOneSecond' | 'liftTooSoonSeconds' | 'liftTooSoonMinutes' | 'liftTooSoonHours';
  n: number;
} {
  if (seconds <= 1) return { key: 'liftTooSoonOneSecond', n: 1 };
  if (seconds < 120) return { key: 'liftTooSoonSeconds', n: seconds };
  if (seconds < 7200) return { key: 'liftTooSoonMinutes', n: Math.ceil(seconds / 60) };
  return { key: 'liftTooSoonHours', n: Math.ceil(seconds / 3600) };
}

/**
 * The step-up for a lift binds this id, so it names the person and the freeze it ends. The service keeps no reply by it:
 * a retry after a lost answer needs a fresh confirmation, and a lift that already happened answers "not frozen".
 */
export function liftRequestId(userId: string, since: string): string {
  return `self-freeze-lift:${userId}:${since}`;
}

/** Sentence key for each reason the person can pick. */
export const REASON_KEYS: Readonly<Record<FreezeReason, string>> = {
  compromise: 'reasonCompromise',
  temporary: 'reasonTemporary',
  personal: 'reasonPersonal',
};

/** Typed refusals the card words itself; any other code falls through to the shared failure view. */
export const FREEZE_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  'auth.invalid_credentials': 'refusedPassword',
  'auth.mfa_required': 'refusedDelegated',
  'auth.account_frozen': 'refusedClosed',
};
