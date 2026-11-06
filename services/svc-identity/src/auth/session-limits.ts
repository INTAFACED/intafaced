/**
 * Idle sign-out and the limit on signed-in devices (I-signin-sessions-06; J-identity-06 #4).
 *
 * Two owner settings, each blank until the owner publishes it, and never given a default here:
 *   - `SESSION_IDLE_SECONDS`: a sign-in not refreshed for longer than this is ended at its next refresh
 *     (`auth.session_idle`). Blank: no idle limit beyond the refresh token's own expiry, and a customer cannot choose one
 *     (`identity.session_idle_unset`), because "shorter than the owner's" has nothing to be shorter than.
 *   - `SESSION_MAX_CONCURRENT`: how many devices (sign-in families) may be signed in at once. A new sign-in beyond it
 *     ends the oldest families, inside the sign-in's own transaction under the users row lock, so two sign-ins racing
 *     for the last place cannot both keep one. Blank: no limit, and Security says so.
 *
 * A customer may choose a shorter idle time than the owner's, never a longer one (`identity.session_setting_out_of_range`).
 * The choice is kept in `session_settings`, one row per account; clearing it goes back to the owner's limit.
 * Idle time is measured from the session row's `last_used_at`, which every refresh renews by rotating into a new row,
 * with the database's clock, not the app's.
 */
import type { Sql, TransactionSql } from 'postgres';

export interface SessionLimitsPolicy {
  /** Owner idle limit in seconds; undefined while the owner has not published one. */
  readonly idleSeconds?: number | undefined;
  /** Owner limit on signed-in devices; undefined while the owner has not published one. */
  readonly maxConcurrent?: number | undefined;
}

/** The shortest idle time a customer may choose: a minute. */
export const MIN_CHOSEN_IDLE_SECONDS = 60;
export const SESSION_IDLE_UNSET = 'identity.session_idle_unset' as const;
export const SESSION_SETTING_OUT_OF_RANGE = 'identity.session_setting_out_of_range' as const;

export class SessionLimitError extends Error {
  constructor(
    message: string,
    readonly code: typeof SESSION_IDLE_UNSET | typeof SESSION_SETTING_OUT_OF_RANGE,
  ) {
    super(message);
    this.name = 'SessionLimitError';
  }
}

type Q = Sql | TransactionSql;

/** The customer's own idle choice in seconds, or null when they have not chosen one. */
export async function chosenIdleSeconds(q: Q, userId: string): Promise<number | null> {
  const [row] = await q<Array<{ idle_seconds: number }>>`SELECT idle_seconds FROM session_settings WHERE user_id = ${userId}`;
  return row?.idle_seconds ?? null;
}

/** The idle limit that applies: the shorter of the owner's and the customer's, or null when the owner set none. */
export function effectiveIdleSeconds(policy: SessionLimitsPolicy, chosen: number | null): number | null {
  if (policy.idleSeconds === undefined) return null;
  return chosen === null ? policy.idleSeconds : Math.min(chosen, policy.idleSeconds);
}

/**
 * True when a session last used at `lastUsedAt` has been idle past the limit that applies, by the database's clock.
 * The caller holds the session row lock.
 */
export async function idleExpired(tx: Q, policy: SessionLimitsPolicy, userId: string, lastUsedAt: Date): Promise<boolean> {
  const idle = effectiveIdleSeconds(policy, await chosenIdleSeconds(tx, userId));
  if (idle === null) return false;
  const [row] = await tx<Array<{ idle: boolean }>>`SELECT (now() - ${lastUsedAt}::timestamptz) > make_interval(secs => ${idle}) AS idle`;
  return row?.idle === true;
}

/**
 * Before a new sign-in family is written: with the owner's limit set, end the oldest live families so the new one fits.
 * The caller holds the users row FOR UPDATE, so racing sign-ins are serialised. Returns the session ids ended.
 */
export async function endFamiliesOverLimit(tx: Q, policy: SessionLimitsPolicy, userId: string): Promise<string[]> {
  const cap = policy.maxConcurrent;
  if (cap === undefined) return [];
  const live = await tx<Array<{ family_id: string }>>`
    SELECT family_id FROM sessions
    WHERE user_id = ${userId} AND revoked = false AND expires_at > now()
    GROUP BY family_id ORDER BY min(created_at), family_id
  `;
  const over = live.length - cap + 1;
  if (over <= 0) return [];
  const families = live.slice(0, over).map((row) => row.family_id);
  const ended = await tx<Array<{ id: string }>>`
    UPDATE sessions SET revoked = true
    WHERE user_id = ${userId} AND revoked = false AND family_id IN ${tx(families)}
    RETURNING id
  `;
  return ended.map((row) => row.id);
}

/** What Security shows: the owner's two settings and the customer's own idle choice. */
export async function sessionLimitsView(
  q: Q,
  policy: SessionLimitsPolicy,
  userId: string,
): Promise<{ ownerIdleSeconds: number | null; chosenIdleSeconds: number | null; maxConcurrent: number | null }> {
  return {
    ownerIdleSeconds: policy.idleSeconds ?? null,
    chosenIdleSeconds: await chosenIdleSeconds(q, userId),
    maxConcurrent: policy.maxConcurrent ?? null,
  };
}

/** Sets (or, with null, clears) the customer's idle choice. Refuses with the owner's limit unset or a longer value. */
export async function setChosenIdleSeconds(q: Q, policy: SessionLimitsPolicy, userId: string, seconds: number | null): Promise<void> {
  if (seconds === null) {
    await q`DELETE FROM session_settings WHERE user_id = ${userId}`;
    return;
  }
  if (policy.idleSeconds === undefined) {
    throw new SessionLimitError('The idle sign-out limit is not set, so a shorter one cannot be chosen.', SESSION_IDLE_UNSET);
  }
  if (!Number.isInteger(seconds) || seconds < MIN_CHOSEN_IDLE_SECONDS || seconds > policy.idleSeconds) {
    throw new SessionLimitError(
      `Choose between ${MIN_CHOSEN_IDLE_SECONDS} and ${policy.idleSeconds} seconds: never longer than the limit that is set.`,
      SESSION_SETTING_OUT_OF_RANGE,
    );
  }
  await q`
    INSERT INTO session_settings (user_id, idle_seconds, updated_at) VALUES (${userId}, ${seconds}, now())
    ON CONFLICT (user_id) DO UPDATE SET idle_seconds = EXCLUDED.idle_seconds, updated_at = EXCLUDED.updated_at
  `;
}

/** An owner setting read from env: a whole number in [min, max], or undefined when blank. Anything else refuses boot. */
export function ownerSessionNumber(raw: string | undefined, name: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, or blank`);
  return n;
}
