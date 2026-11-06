// hand-declared-ok: svc-identity's sessionLimits answers are declared in its own router, not in packages/contracts yet
import { z } from 'zod';

/** `sessionLimits` and `setIdleSignOut`: the owner's idle limit and device limit (null while unset), and the customer's choice. */
export const sessionLimitsSchema = z.object({
  ownerIdleSeconds: z.number().int().nullable(),
  chosenIdleSeconds: z.number().int().nullable(),
  maxConcurrent: z.number().int().nullable(),
});
export type SessionLimits = z.infer<typeof sessionLimitsSchema>;

/** The refusals this card words itself. */
export const SESSION_LIMIT_CODES = ['identity.session_setting_out_of_range', 'identity.session_idle_unset'] as const;
export type SessionLimitCode = (typeof SESSION_LIMIT_CODES)[number];
export const sessionLimitCode = (code: string | undefined): SessionLimitCode | undefined =>
  (SESSION_LIMIT_CODES as readonly string[]).includes(code ?? '') ? (code as SessionLimitCode) : undefined;

export const minutesOf = (seconds: number) => Math.floor(seconds / 60);
