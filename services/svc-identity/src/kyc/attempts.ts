/**
 * KYC attempt limits (I-kyc-compliance-10, J-identity-08 #4). The owner sets how many rejected requests a person may
 * have in a window and how long a request is refused after the last of them (`IDENTITY_KYC_MAX_DENIALS`,
 * `IDENTITY_KYC_DENIAL_WINDOW_HOURS`, `IDENTITY_KYC_LOCKOUT_HOURS`, NO DEFAULT). All three unset is no limit, and the
 * page says so. The count comes from the case history (`kyc_case_events`), so it cannot drift from the cases.
 * At the cap a new request is refused `kyc.attempts_exhausted` with the seconds left, never silently dropped.
 */
import type { Sql } from 'postgres';
import type { KycAttempts } from '@intafaced/contracts/identity-kyc-attempts';

export class KycAttemptsError extends Error {
  readonly code = 'kyc.attempts_exhausted' as const;
  constructor(
    message: string,
    readonly details: { readonly retryAfterSeconds: number },
  ) {
    super(message);
    this.name = 'KycAttemptsError';
  }
}

export interface KycAttemptLimit {
  readonly maxDenials: number;
  readonly windowHours: number;
  readonly lockoutHours: number;
}

const MAX_HOURS = 8760;

function whole(raw: string, setting: string, max: number): number {
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`${setting} must be a whole number from 1 to ${max}`);
  return value;
}

/**
 * The three owner settings together. All blank is no limit (null). Only some of them set, or any malformed, stops the
 * service: half a limit would refuse on rules nobody published.
 */
export function parseKycAttemptLimit(env: {
  IDENTITY_KYC_MAX_DENIALS?: string;
  IDENTITY_KYC_DENIAL_WINDOW_HOURS?: string;
  IDENTITY_KYC_LOCKOUT_HOURS?: string;
}): KycAttemptLimit | null {
  const raw = [env.IDENTITY_KYC_MAX_DENIALS, env.IDENTITY_KYC_DENIAL_WINDOW_HOURS, env.IDENTITY_KYC_LOCKOUT_HOURS];
  const set = raw.filter((v) => v !== undefined && v.trim() !== '');
  if (set.length === 0) return null;
  if (set.length !== 3)
    throw new Error(
      'IDENTITY_KYC_MAX_DENIALS, IDENTITY_KYC_DENIAL_WINDOW_HOURS and IDENTITY_KYC_LOCKOUT_HOURS are set together or not at all',
    );
  return {
    maxDenials: whole(raw[0]!, 'IDENTITY_KYC_MAX_DENIALS', 100),
    windowHours: whole(raw[1]!, 'IDENTITY_KYC_DENIAL_WINDOW_HOURS', MAX_HOURS),
    lockoutHours: whole(raw[2]!, 'IDENTITY_KYC_LOCKOUT_HOURS', MAX_HOURS),
  };
}

/**
 * Where the person stands against the limit, on the database's clock (the one the rejections were stamped with).
 * Locked when the last `maxDenials` rejections all fall inside one window, until `lockoutHours` after the newest of
 * them. That holds for the whole lockout even when it is longer than the window. `denialsInWindow` counts back from now.
 */
export async function readKycAttempts(sql: Sql, limit: KycAttemptLimit | null, userId: string): Promise<KycAttempts & { now: Date }> {
  if (!limit) {
    const [{ now }] = await sql<[{ now: Date }]>`SELECT now() AS now`;
    return { limit: null, denialsInWindow: null, lockedUntil: null, now };
  }
  const window = `${limit.windowHours} hours`;
  const [row] = await sql<[{ now: Date; in_window: number; locked_until: Date | null }]>`
    WITH recent AS (
      SELECT e.at FROM kyc_case_events e JOIN kyc_cases c ON c.id = e.case_id
      WHERE c.user_id = ${userId} AND e.state = 'rejected' ORDER BY e.at DESC LIMIT ${limit.maxDenials}
    ), span AS (SELECT count(*)::int AS n, max(at) AS newest, min(at) AS oldest FROM recent)
    SELECT now() AS now,
      (SELECT count(*)::int FROM kyc_case_events e JOIN kyc_cases c ON c.id = e.case_id
        WHERE c.user_id = ${userId} AND e.state = 'rejected' AND e.at > now() - ${window}::interval) AS in_window,
      CASE WHEN span.n >= ${limit.maxDenials} AND span.newest - span.oldest <= ${window}::interval
        AND span.newest + ${`${limit.lockoutHours} hours`}::interval > now()
        THEN span.newest + ${`${limit.lockoutHours} hours`}::interval END AS locked_until
    FROM span`;
  return {
    limit: { ...limit },
    denialsInWindow: row.in_window,
    lockedUntil: row.locked_until ? row.locked_until.toISOString() : null,
    now: row.now,
  };
}

/** Before a request is stored: at the cap, refused with the seconds left. */
export async function assertAttemptsLeft(sql: Sql, limit: KycAttemptLimit | null, userId: string): Promise<void> {
  const { lockedUntil, now } = await readKycAttempts(sql, limit, userId);
  if (!lockedUntil) return;
  const retryAfterSeconds = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - now.getTime()) / 1000));
  throw new KycAttemptsError(`Too many rejected verification requests; a new request is refused for ${retryAfterSeconds} more seconds`, {
    retryAfterSeconds,
  });
}
