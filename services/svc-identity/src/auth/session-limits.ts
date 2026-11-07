import { z } from 'zod';
import type { Sql } from 'postgres';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';

/**
 * Idle sign-out and the signed-in device limit (I-signin-sessions-06, J-identity-06 #4).
 *
 * Two owner settings, each with NO DEFAULT and a typed unset state:
 * - `SESSION_IDLE_SECONDS`: the longest a sign-in may go without a refresh before its next refresh is refused
 *   (`auth.session_idle`). Unset: no idle sign-out; the sign-in still ends at its absolute lifetime (the refresh TTL
 *   from the family's first login, #5767).
 * - `SESSION_MAX_CONCURRENT`: the most devices (sign-in families) one account may be signed in on. A sign-in beyond it
 *   ends the oldest device. Unset: no limit, and Security says so.
 *
 * A person may choose a shorter idle sign-out for their own account (`users.idle_signout_seconds`), never a longer one
 * than the owner's, and never one shorter than an access token lives: a sign-in refreshes once per access token, so a
 * shorter idle time would sign out a person who is using the app. With the owner's idle setting unset, the longest a
 * person may choose is the sign-in's absolute lifetime.
 */
export type SessionLimits = { idleSeconds: number | null; maxConcurrent: number | null };

export const SESSION_IDLE = 'auth.session_idle' as const;
export const SESSION_SETTING_OUT_OF_RANGE = 'identity.session_setting_out_of_range' as const;

function wholeAboveZero(name: string, raw: string | undefined, max: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > max) throw new Error(`${name} must be a whole number above zero, at most ${max}`);
  return Number(value);
}

/**
 * The two owner settings from the environment; a value that is not a whole number above zero stops the service, and so
 * does an idle sign-out shorter than one access token's life (a sign-in refreshes once per access token, so it would
 * sign out a person while they use the app, and leave the person no time they may choose).
 */
export function parseSessionLimits(
  env: { SESSION_IDLE_SECONDS?: string | undefined; SESSION_MAX_CONCURRENT?: string | undefined },
  tokens: { accessTtlSeconds: number },
): SessionLimits {
  const idleSeconds = wholeAboveZero('SESSION_IDLE_SECONDS', env.SESSION_IDLE_SECONDS, 31_536_000);
  if (idleSeconds !== null && idleSeconds < tokens.accessTtlSeconds) {
    throw new Error(`SESSION_IDLE_SECONDS must be at least one access token's life (JWT_ACCESS_TTL_SECONDS, ${tokens.accessTtlSeconds})`);
  }
  return { idleSeconds, maxConcurrent: wholeAboveZero('SESSION_MAX_CONCURRENT', env.SESSION_MAX_CONCURRENT, 10_000) };
}

/** The idle time that applies to one account: the shorter of the owner's and the person's own, or null when neither is set. */
export function effectiveIdleSeconds(ownerSeconds: number | null, ownSeconds: number | null): number | null {
  if (ownerSeconds === null) return ownSeconds;
  if (ownSeconds === null) return ownerSeconds;
  return Math.min(ownerSeconds, ownSeconds);
}

/** The range a person's own idle sign-out may take: from one access token's life up to the owner's (or the absolute lifetime). */
export function ownIdleRange(limits: SessionLimits, tokens: { accessTtlSeconds: number; refreshTtlSeconds: number }) {
  return { min: tokens.accessTtlSeconds, max: limits.idleSeconds ?? tokens.refreshTtlSeconds };
}

/**
 * Before a new sign-in family is written: with the owner's device limit set, end the oldest live families so that the new
 * one makes the account exactly the limit. Runs inside the sign-in transaction, after the users row is locked FOR UPDATE,
 * so two racing sign-ins take turns and each ends its own oldest device. Returns the ended session ids.
 */
export async function endOldestBeyondLimit(tx: Sql, userId: string, maxConcurrent: number | null): Promise<string[]> {
  if (maxConcurrent === null) return [];
  // A device is a sign-in family; its age is its first sign-in (the family's first row, live or rotated), not its
  // latest refresh, so the device signed in on longest ago ends, as Security says.
  const live = await tx<Array<{ family_id: string }>>`
    SELECT family_id FROM sessions
    WHERE user_id = ${userId}
    GROUP BY family_id
    HAVING bool_or(revoked = false AND expires_at > now())
    ORDER BY min(created_at) ASC, family_id ASC`;
  const over = live.length - maxConcurrent + 1;
  if (over <= 0) return [];
  const families = live.slice(0, over).map((row) => row.family_id);
  const ended = await tx<Array<{ id: string }>>`
    UPDATE sessions SET revoked = true
    WHERE user_id = ${userId} AND revoked = false AND family_id IN ${tx(families)}
    RETURNING id`;
  // An ended device is signed out, not attacked: its rotated tokens lose their rotation stamp, so presenting one later
  // (a lost reply, a second tab) is a dead token (auth.session_invalid), never reuse that would end every other device.
  await tx`
    UPDATE sessions SET rotated_at = NULL, successor_id = NULL, successor_refresh = NULL
    WHERE user_id = ${userId} AND family_id IN ${tx(families)} AND (rotated_at IS NOT NULL OR successor_id IS NOT NULL)`;
  return ended.map((row) => row.id);
}

const settingsOut = z
  .object({
    owner: z.object({ idleSeconds: z.number().int().nullable(), maxDevices: z.number().int().nullable() }).strict(),
    own: z.object({ idleSeconds: z.number().int().nullable() }).strict(),
    range: z.object({ minSeconds: z.number().int(), maxSeconds: z.number().int() }).strict(),
    appliedIdleSeconds: z.number().int().nullable(),
    absoluteSeconds: z.number().int(),
  })
  .strict();

/** Security's session settings: what the owner set, what the person chose, and the range they may choose in. */
export function createSessionSettingsRouter(
  sql: Sql,
  limits: SessionLimits,
  tokens: { accessTtlSeconds: number; refreshTtlSeconds: number },
) {
  const range = ownIdleRange(limits, tokens);
  async function view(userId: string) {
    const [row] = await sql<Array<{ idle_signout_seconds: number | null }>>`SELECT idle_signout_seconds FROM users WHERE id = ${userId}`;
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.not_found' });
    const own = row.idle_signout_seconds;
    return {
      owner: { idleSeconds: limits.idleSeconds, maxDevices: limits.maxConcurrent },
      own: { idleSeconds: own },
      range: { minSeconds: range.min, maxSeconds: range.max },
      appliedIdleSeconds: effectiveIdleSeconds(limits.idleSeconds, own),
      absoluteSeconds: tokens.refreshTtlSeconds,
    };
  }
  return router({
    sessionSettings: scopedProcedure('identity:read')
      .input(z.object({}).strict().optional())
      .output(settingsOut)
      .query(({ ctx }) => view(ctx.principal.userId)),

    /**
     * Sets this account's own idle sign-out, or clears it (null) back to the owner's. Never longer than the owner's and never
     * shorter than one access token's life: either refuses with `identity.session_setting_out_of_range` and changes nothing.
     * No step-up: the owner's setting still bounds every value, so no choice here can keep a sign-in longer than the owner allows.
     */
    setIdleSignout: scopedProcedure('identity:write')
      .input(z.object({ seconds: z.number().int().nullable() }).strict())
      .output(settingsOut)
      .mutation(async ({ ctx, input }) => {
        if (input.seconds !== null && (input.seconds < range.min || input.seconds > range.max)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Choose an idle sign-out from ${range.min} to ${range.max} seconds. [${SESSION_SETTING_OUT_OF_RANGE}]`,
            // The named code rides as the cause, so the client reads it as `intafacedCode`-style data, never from prose.
            cause: { code: SESSION_SETTING_OUT_OF_RANGE },
          });
        }
        await sql`UPDATE users SET idle_signout_seconds = ${input.seconds} WHERE id = ${ctx.principal.userId}`;
        return view(ctx.principal.userId);
      }),
  });
}
