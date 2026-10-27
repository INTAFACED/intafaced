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

/** Where the person stands against the limit at `now`. */
export async function readKycAttempts(sql: Sql, limit: KycAttemptLimit | null, userId: string, now: Date): Promise<KycAttempts> {
  if (!limit) return { limit: null, denialsInWindow: null, lockedUntil: null };
  const since = new Date(now.getTime() - limit.windowHours * 3_600_000);
  const rows = await sql<Array<{ at: Date }>>`
    SELECT e.at FROM kyc_case_events e JOIN kyc_cases c ON c.id = e.case_id
    WHERE c.user_id = ${userId} AND e.state = 'rejected' AND e.at > ${since} ORDER BY e.at DESC`;
  const latest = rows[0]?.at;
  const until = rows.length >= limit.maxDenials && latest ? new Date(latest.getTime() + limit.lockoutHours * 3_600_000) : null;
  return {
    limit: { ...limit },
    denialsInWindow: rows.length,
    lockedUntil: until && until > now ? until.toISOString() : null,
  };
}

/** Before a request is stored: at the cap, refused with the seconds left. */
export async function assertAttemptsLeft(sql: Sql, limit: KycAttemptLimit | null, userId: string, now: Date): Promise<void> {
  const { lockedUntil } = await readKycAttempts(sql, limit, userId, now);
  if (!lockedUntil) return;
  const retryAfterSeconds = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - now.getTime()) / 1000));
  throw new KycAttemptsError(`Too many rejected verification requests; a new request is refused for ${retryAfterSeconds} more seconds`, {
    retryAfterSeconds,
  });
}
