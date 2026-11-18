import { z } from 'zod';

// hand-declared-ok: sessionSettings and setIdleSignout are declared in svc-identity (auth/session-limits.ts), not in packages/contracts yet
export const sessionSettings = z.object({
  owner: z.object({ idleSeconds: z.number().int().nullable(), maxDevices: z.number().int().nullable() }),
  own: z.object({ idleSeconds: z.number().int().nullable() }),
  range: z.object({ minSeconds: z.number().int(), maxSeconds: z.number().int() }),
  appliedIdleSeconds: z.number().int().nullable(),
  absoluteSeconds: z.number().int(),
});
export type SessionSettings = z.infer<typeof sessionSettings>;

export const OUT_OF_RANGE = 'identity.session_setting_out_of_range';

/** Whole minutes from a form value, or null when it is not a whole number of minutes above zero. */
export function minutesFrom(raw: string): number | null {
  const value = raw.trim();
  return /^[1-9]\d{0,6}$/.test(value) ? Number(value) : null;
}

/** A length of time in the largest whole unit that fits it exactly: "1 hour", "90 minutes", "30 days". */
export function spoken(seconds: number): { unit: 'days' | 'hours' | 'minutes' | 'seconds'; count: number } {
  if (seconds % 86_400 === 0) return { unit: 'days', count: seconds / 86_400 };
  if (seconds % 3_600 === 0) return { unit: 'hours', count: seconds / 3_600 };
  if (seconds % 60 === 0) return { unit: 'minutes', count: seconds / 60 };
  return { unit: 'seconds', count: seconds };
}
