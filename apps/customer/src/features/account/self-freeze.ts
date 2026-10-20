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
