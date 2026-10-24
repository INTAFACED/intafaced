/**
 * Trusted devices and new-device sign-in authorisation (I-signin-sessions-07; J-identity-02 #5).
 *
 * A device is a random key in a long-lived HttpOnly cookie (`ifc_dk`); only its SHA-256 is stored. A sign-in whose
 * factors all passed, from a browser whose key has no live row for that account (or with no key at all), is a new
 * device. The answer is `auth.device_authorisation_required` with a flow id and a secret only that browser holds, and
 * it comes only after the password and any second factor passed, so it never tells anyone anything about an account
 * they could not sign in to. The person approves it with the code mailed to the account's address, or from a session
 * already signed in on a trusted device (step-up). The waiting browser then completes once with its secret: that writes
 * the trusted row, sets its cookie and opens the session.
 *
 * Owner settings: whether the check is on (`IDENTITY_NEW_DEVICE_CHECK`, blank is off and says so), the flow's lifetime,
 * the wrong codes allowed, and how long a trusted device stays trusted (unset: until removed). With the check on and
 * the flow lifetime unset, a new-device sign-in is refused with `auth.device_check_unwired`; it never skips the check.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { TrustedDeviceState, TrustedDeviceTrustedBy } from '@intafaced/contracts';
import type { PasswordResetMail } from './password-reset.js';

export const DEVICE_COOKIE_NAME = 'ifc_dk';
/**
 * The browser path after svc-edge. The cookie is read only on `/api/identity/trpc/auth.*`, which the edge forwards with
 * its Cookie header; identity sets the public path itself, as no identity-side path is ever seen by the browser.
 */
export const DEVICE_COOKIE_PATH = '/api/identity/trpc';
/** A browser keeps a cookie at most about 400 days, so a device trusted "until removed" is renewed at each sign-in. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 86_400;
const MAX_FLOW_TTL_SECONDS = 86_400;
const MAX_ATTEMPTS_CEILING = 5;

export type TrustedDeviceErrorCode =
  | 'auth.device_authorisation_required'
  | 'auth.device_authorisation_pending'
  | 'auth.device_authorisation_invalid'
  | 'auth.device_authorisation_used'
  | 'auth.device_check_unwired'
  | 'auth.device_approval_unavailable'
  | 'auth.account_frozen'
  | 'auth.device_not_trusted'
  | 'auth.code_invalid'
  | 'auth.code_expired'
  | 'auth.too_many_attempts'
  | 'identity.device_not_found'
  | 'vendor.email';

export interface DeviceAuthorisationDetails {
  readonly flowId: string;
  /** Held only by the browser that is signing in; it completes the sign-in once the device is approved. */
  readonly secret: string;
  readonly expiresAt: string;
  /** Whether a code was mailed to the account's address. Approval from a signed-in session works either way. */
  readonly mailed: boolean;
  /** Set when this sign-in's second step spent a recovery code: how many are left, said once the device is approved. */
  readonly recoveryCodesLeft?: number;
}

export class TrustedDeviceError extends Error {
  constructor(
    message: string,
    readonly code: TrustedDeviceErrorCode,
    readonly details?: { readonly deviceAuthorisation?: DeviceAuthorisationDetails; readonly retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'TrustedDeviceError';
  }
}

export interface NewDevicePolicy {
  /** True only when the owner turned the check on. */
  readonly check: boolean;
  /** How long a waiting new-device sign-in can be approved and completed. */
  readonly flowTtlSeconds?: number | undefined;
  /** Wrong mailed codes allowed per flow (ceiling 5). Unset: no code is mailed; approval from a session still works. */
  readonly maxAttempts?: number | undefined;
  /** How long an approved device stays trusted. Unset: until it is removed. */
  readonly trustedTtlSeconds?: number | undefined;
}

export interface TrustedDeviceDeps {
  readonly sql: Sql;
  readonly policy: NewDevicePolicy;
  readonly mail: PasswordResetMail | undefined;
  /** HMAC key for the mailed code. Same key as the recovery flows. */
  readonly subjectKey: string | undefined;
  readonly now: () => Date;
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

export interface TrustedDeviceRow {
  readonly id: string;
  readonly label: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly trustedUntil: Date | null;
  readonly current: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function deviceKeyHash(key: string): string {
  return sha256(key);
}

function codeHash(subjectKey: string, flowId: string, code: string): string {
  return createHmac('sha256', subjectKey).update(`new-device:${flowId}:${code}`).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function intIn(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/** A browser's user agent cut to a label that fits the row. */
export function deviceLabel(userAgent: string | undefined | null): string {
  const label = (userAgent ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 120);
  return label.length > 0 ? label : 'Unknown browser';
}

function trustedUntil(policy: NewDevicePolicy, now: Date): Date | null {
  const ttl = intIn(policy.trustedTtlSeconds, 1, 10 * 365 * 86_400);
  return ttl === undefined ? null : new Date(now.getTime() + ttl * 1000);
}

/** The live trusted row this key names for the account, touched as seen now; null when there is none. */
export async function liveDevice(sql: Sql, userId: string, key: string | null | undefined, now: Date): Promise<string | null> {
  if (!key) return null;
  const rows = await sql<Array<{ id: string }>>`
    UPDATE trusted_devices SET last_seen_at = ${now}
    WHERE user_id = ${userId} AND device_key_hash = ${deviceKeyHash(key)} AND removed_at IS NULL
      AND (trusted_until IS NULL OR trusted_until > ${now})
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

const DEVICE_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Trust this browser for the account. A browser that already holds a device key (it signed in to another account, or
 * was trusted before) keeps it, so one browser is one device; otherwise it gets a fresh key. Only the hash is stored.
 */
export async function trustDevice(
  q: Sql | TransactionSql,
  policy: NewDevicePolicy,
  input: { userId: string; label: string; now: Date; trustedBy: TrustedDeviceTrustedBy; presentedKey?: string | null | undefined },
): Promise<{ id: string; key: string }> {
  const key = input.presentedKey && DEVICE_KEY.test(input.presentedKey) ? input.presentedKey : randomBytes(32).toString('base64url');
  // A row that comes back to life keeps how it was proved only while it was still live: an approval always wins, and a
  // device trusted again after its trusted time ran out is as proved as this sign-in.
  const [row] = await q<Array<{ id: string }>>`
    INSERT INTO trusted_devices (user_id, device_key_hash, label, first_seen_at, last_seen_at, trusted_until, trusted_by)
    VALUES (
      ${input.userId}, ${deviceKeyHash(key)}, ${input.label}, ${input.now}, ${input.now}, ${trustedUntil(policy, input.now)},
      ${input.trustedBy}
    )
    ON CONFLICT (user_id, device_key_hash) WHERE removed_at IS NULL
    DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, trusted_until = EXCLUDED.trusted_until,
      trusted_by = CASE
        WHEN EXCLUDED.trusted_by = 'approval' THEN 'approval'
        WHEN trusted_devices.trusted_until IS NOT NULL AND trusted_devices.trusted_until <= EXCLUDED.last_seen_at
          THEN EXCLUDED.trusted_by
        ELSE trusted_devices.trusted_by
      END
    RETURNING id
  `;
  return { id: row!.id, key };
}

/**
 * Called once every factor of a sign-in has passed. A live device answers its id. With the check off, the browser is
 * trusted as it signs in (so the browsers people already use are trusted on the day the owner turns the check on) and
 * gets its key back for the cookie. With the check on, an unknown browser opens an authorisation and is refused with it.
 */
export async function gateDevice(
  deps: TrustedDeviceDeps,
  input: { userId: string; mfa: boolean; deviceKey: string | null | undefined; label: string },
): Promise<{ trustedDeviceId: string; deviceKey?: string }> {
  const now = deps.now();
  const live = await liveDevice(deps.sql, input.userId, input.deviceKey, now);
  if (live) return { trustedDeviceId: live };
  if (!deps.policy.check) {
    const device = await trustDevice(deps.sql, deps.policy, {
      userId: input.userId,
      label: input.label,
      now,
      trustedBy: 'sign-in',
      presentedKey: input.deviceKey,
    });
    return { trustedDeviceId: device.id, deviceKey: device.key };
  }
  throw new TrustedDeviceError(
    'This device has not been used to sign in to this account before. Approve it to continue.',
    'auth.device_authorisation_required',
    { deviceAuthorisation: await openAuthorisation(deps, input, now) },
  );
}

async function openAuthorisation(
  deps: TrustedDeviceDeps,
  input: { userId: string; mfa: boolean; label: string },
  now: Date,
): Promise<DeviceAuthorisationDetails> {
  const ttl = intIn(deps.policy.flowTtlSeconds, 1, MAX_FLOW_TTL_SECONDS);
  const subjectKey = deps.subjectKey && deps.subjectKey.length >= 32 ? deps.subjectKey : undefined;
  if (ttl === undefined || subjectKey === undefined) {
    throw new TrustedDeviceError('New-device approval is not available: its settings are not published.', 'auth.device_check_unwired');
  }
  const max = intIn(deps.policy.maxAttempts, 1, MAX_ATTEMPTS_CEILING);
  const codes = max !== undefined && deps.mail !== undefined;
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  const secret = randomBytes(32).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  let mailed = false;
  const flowId = await deps.sql.begin(async (tx) => {
    // One account's waiting sign-ins inside one lifetime window share one budget: at most the owner's count of
    // requests (each mails one code) and of wrong codes across them, so a stolen password cannot keep drawing fresh
    // codes to guess, or flood the inbox. The window is the flow lifetime.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`new-device:${input.userId}`}))`;
    const since = new Date(now.getTime() - ttl * 1000);
    const [recent] = await tx<Array<{ flows: number; wrong: number; oldest: Date | null }>>`
      SELECT count(*)::int AS flows, coalesce(sum(attempts), 0)::int AS wrong, min(created_at) AS oldest
      FROM auth_flows WHERE kind = 'new_device' AND user_id = ${input.userId} AND created_at > ${since}
    `;
    const budget = max ?? MAX_ATTEMPTS_CEILING;
    if (recent && recent.oldest && (recent.flows >= budget || recent.wrong >= budget)) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(recent.oldest).getTime() + ttl * 1000 - now.getTime()) / 1000));
      throw new TrustedDeviceError('Too many new-device sign-ins. Try again later.', 'auth.too_many_attempts', { retryAfterSeconds });
    }
    const [user] = await tx<Array<{ email: string | null; email_verified_at: Date | null }>>`
      SELECT email, email_verified_at FROM users WHERE id = ${input.userId}
    `;
    const proved = Boolean(user?.email && user.email_verified_at);
    mailed = codes && proved;
    if (!mailed) {
      // Without a mailed code the only way is a session on a trusted device; with none, nothing could approve it.
      const [trusted] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trusted_devices
        WHERE user_id = ${input.userId} AND removed_at IS NULL AND (trusted_until IS NULL OR trusted_until > ${now})
      `;
      if (!trusted || trusted.n === 0) {
        // Name the real blocker: no transport, no published code setting, or no proved address on the account.
        if (!deps.mail) {
          throw new TrustedDeviceError(
            'Email delivery is switched off in this build and no other device is trusted, so this device cannot be approved.',
            'vendor.email',
          );
        }
        if (max === undefined) {
          throw new TrustedDeviceError(
            'Device codes by email are not available: their settings are not published, and no other device is trusted.',
            'auth.device_check_unwired',
          );
        }
        throw new TrustedDeviceError(
          'This account has no proved email address and no other trusted device, so this device cannot be approved. Contact support.',
          'auth.device_approval_unavailable',
        );
      }
    }
    const subjectHash = createHmac('sha256', subjectKey).update(`new-device:${input.userId}`).digest('hex');
    const [flow] = await tx<Array<{ id: string }>>`
      INSERT INTO auth_flows (kind, subject_hash, user_id, code_hash, status, expires_at, created_at)
      VALUES ('new_device', ${subjectHash}, ${input.userId}, NULL, ${mailed ? 'code_sent' : 'suppressed'}, ${expiresAt}, ${now})
      RETURNING id
    `;
    const id = flow!.id;
    if (mailed) {
      await tx`UPDATE auth_flows SET code_hash = ${codeHash(subjectKey, id, code)} WHERE id = ${id}`;
      await tx`
        INSERT INTO mail_outbox (flow_id, purpose, recipient, code, handle, expires_at, status, created_at)
        VALUES (${id}, 'new-device-code', ${user!.email}, ${code}, NULL, ${expiresAt}, 'pending', ${now})
      `;
    }
    await tx`
      INSERT INTO device_authorisations (flow_id, user_id, secret_hash, mfa, label, created_at)
      VALUES (${id}, ${input.userId}, ${sha256(secret)}, ${input.mfa}, ${input.label}, ${now})
    `;
    return id;
  });
  if (mailed) await deps.afterCommit?.();
  return { flowId, secret, expiresAt: expiresAt.toISOString(), mailed };
}

type Waiting = {
  user_id: string;
  secret_hash: string;
  mfa: boolean;
  label: string;
  approved_at: Date | null;
  completed_at: Date | null;
  status: string;
  attempts: number;
  code_hash: string | null;
  expires_at: Date;
  approved_by_session: string | null;
};

async function waiting(tx: TransactionSql, flowId: string): Promise<Waiting | undefined> {
  const [row] = await tx<Waiting[]>`
    SELECT d.user_id, d.secret_hash, d.mfa, d.label, d.approved_at, d.completed_at, d.approved_by_session, f.status, f.attempts,
           f.code_hash, f.expires_at
    FROM device_authorisations d JOIN auth_flows f ON f.id = d.flow_id
    WHERE d.flow_id = ${flowId} AND f.kind = 'new_device'
    FOR UPDATE OF d, f
  `;
  return row;
}

/** The waiting browser's own secret, or one refusal that says nothing more. */
function holdsSecret(row: Waiting | undefined, secret: string): row is Waiting {
  return row !== undefined && sameHex(row.secret_hash, sha256(secret));
}

function invalid(): never {
  throw new TrustedDeviceError('That sign-in request is not valid. Sign in again.', 'auth.device_authorisation_invalid');
}

/**
 * Approve with the mailed code, from the waiting browser (which proves it with its secret). A wrong code counts; the
 * owner's count locks the flow. The right code approves; a second approval answers as the first did.
 */
export async function approveWithCode(deps: TrustedDeviceDeps, input: { flowId: string; secret: string; code: string }): Promise<void> {
  const now = deps.now();
  const max = intIn(deps.policy.maxAttempts, 1, MAX_ATTEMPTS_CEILING);
  const subjectKey = deps.subjectKey;
  const ttl = intIn(deps.policy.flowTtlSeconds, 1, MAX_FLOW_TTL_SECONDS);
  const outcome = await deps.sql.begin(async (tx) => {
    // The account's lock first (the same one openAuthorisation takes), then the flow: the wrong codes counted below
    // cannot move under this guess.
    const [owner] = await tx<Array<{ user_id: string }>>`
      SELECT user_id FROM device_authorisations WHERE flow_id = ${input.flowId}
    `;
    if (owner) await tx`SELECT pg_advisory_xact_lock(hashtext(${`new-device:${owner.user_id}`}))`;
    const row = await waiting(tx, input.flowId);
    if (!holdsSecret(row, input.secret)) return invalid();
    if (row.completed_at) throw new TrustedDeviceError('This sign-in request was already used.', 'auth.device_authorisation_used');
    if (row.approved_at) return 'approved' as const;
    if (row.expires_at.getTime() <= now.getTime()) {
      throw new TrustedDeviceError('That code has expired. Sign in again for a new one.', 'auth.code_expired');
    }
    if (!row.code_hash || max === undefined || !subjectKey) return 'wrong' as const;
    if (row.status === 'locked' || row.attempts >= max) return 'locked' as const;
    // Wrong codes count against the account across all its waiting requests in the window, not per request: requests
    // opened side by side before any guess cannot each spend a fresh allowance.
    const since = new Date(now.getTime() - (ttl ?? MAX_FLOW_TTL_SECONDS) * 1000);
    const [spent] = await tx<Array<{ wrong: number }>>`
      SELECT coalesce(sum(attempts), 0)::int AS wrong
      FROM auth_flows WHERE kind = 'new_device' AND user_id = ${row.user_id} AND created_at > ${since}
    `;
    if ((spent?.wrong ?? 0) >= max) {
      await tx`UPDATE auth_flows SET status = 'locked' WHERE id = ${input.flowId}`;
      return 'locked' as const;
    }
    if (sameHex(row.code_hash, codeHash(subjectKey, input.flowId, input.code.trim()))) {
      await tx`UPDATE device_authorisations SET approved_at = ${now} WHERE flow_id = ${input.flowId}`;
      return 'approved' as const;
    }
    const attempts = row.attempts + 1;
    const lock = attempts >= max || (spent?.wrong ?? 0) + 1 >= max;
    await tx`
      UPDATE auth_flows SET attempts = ${attempts}, status = ${lock ? 'locked' : row.status} WHERE id = ${input.flowId}
    `;
    return lock ? ('locked' as const) : ('wrong' as const);
  });
  if (outcome === 'locked') {
    throw new TrustedDeviceError('Too many wrong codes. Sign in again for a new one.', 'auth.too_many_attempts');
  }
  if (outcome === 'wrong') throw new TrustedDeviceError('That code is not valid.', 'auth.code_invalid');
}

/**
 * Approve from a session already signed in on a trusted device of the same account (the caller has spent its step-up).
 * The flow id is bound to the approving session's own account; a user id is never taken from input.
 */
export async function approveFromSession(
  deps: TrustedDeviceDeps,
  input: { flowId: string; userId: string; sessionId: string },
): Promise<void> {
  const now = deps.now();
  await deps.sql.begin(async (tx) => {
    const [session] = await tx<Array<{ ok: boolean }>>`
      SELECT true AS ok FROM sessions s JOIN trusted_devices t ON t.id = s.trusted_device_id
      WHERE s.id = ${input.sessionId} AND s.user_id = ${input.userId} AND s.revoked = false AND s.expires_at > ${now}
        AND t.removed_at IS NULL AND (t.trusted_until IS NULL OR t.trusted_until > ${now})
    `;
    if (!session) {
      throw new TrustedDeviceError('Approve new devices from a device that is already trusted.', 'auth.device_not_trusted');
    }
    const [row] = await tx<Array<{ approved_at: Date | null; completed_at: Date | null; expires_at: Date; status: string }>>`
      SELECT d.approved_at, d.completed_at, f.expires_at, f.status
      FROM device_authorisations d JOIN auth_flows f ON f.id = d.flow_id
      WHERE d.flow_id = ${input.flowId} AND d.user_id = ${input.userId}
      FOR UPDATE OF d
    `;
    if (!row) throw new TrustedDeviceError('That sign-in request was not found.', 'identity.device_not_found');
    if (row.approved_at || row.completed_at) return;
    // Locked by wrong codes: whoever is waiting failed the mailed check; that request is over.
    if (row.status === 'locked') throw new TrustedDeviceError('Too many wrong codes were tried on that sign-in.', 'auth.too_many_attempts');
    if (row.expires_at.getTime() <= now.getTime()) {
      throw new TrustedDeviceError('That sign-in request has expired.', 'auth.code_expired');
    }
    await tx`UPDATE device_authorisations SET approved_at = ${now}, approved_by_session = ${input.sessionId} WHERE flow_id = ${input.flowId}`;
  });
}

/**
 * The waiting browser completes an approved sign-in, once: the trusted row and its key, and what the sign-in proved.
 * The caller opens the session. Not approved yet answers `auth.device_authorisation_pending`.
 */
export async function completeAuthorisation(
  deps: TrustedDeviceDeps,
  input: { flowId: string; secret: string; presentedKey?: string | null | undefined },
): Promise<{ userId: string; mfa: boolean; trustedDeviceId: string; deviceKey: string }> {
  const now = deps.now();
  return deps.sql.begin(async (tx) => {
    const row = await waiting(tx, input.flowId);
    if (!holdsSecret(row, input.secret)) return invalid();
    if (row.completed_at) throw new TrustedDeviceError('This sign-in request was already used.', 'auth.device_authorisation_used');
    if (row.expires_at.getTime() <= now.getTime()) {
      throw new TrustedDeviceError('That sign-in request has expired. Sign in again.', 'auth.code_expired');
    }
    if (!row.approved_at) {
      throw new TrustedDeviceError('This device has not been approved yet.', 'auth.device_authorisation_pending');
    }
    // A freeze between approval and completion: nothing is spent or trusted, and the state is named.
    const [user] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${row.user_id} FOR UPDATE`;
    if (!user || user.status !== 'active') throw new TrustedDeviceError('This account is not active.', 'auth.account_frozen');
    await tx`UPDATE device_authorisations SET completed_at = ${now} WHERE flow_id = ${input.flowId}`;
    await tx`UPDATE auth_flows SET status = 'consumed', consumed_at = ${now} WHERE id = ${input.flowId}`;
    // Approved from a session: the new device is only as proved as the device that approved it, so a device trusted
    // by a sign-in while the check was off cannot vouch a proved one into being.
    let trustedBy: TrustedDeviceTrustedBy = 'approval';
    if (row.approved_by_session) {
      const [approver] = await tx<Array<{ trusted_by: TrustedDeviceTrustedBy }>>`
        SELECT t.trusted_by FROM sessions s JOIN trusted_devices t ON t.id = s.trusted_device_id
        WHERE s.id = ${row.approved_by_session}
      `;
      if (approver?.trusted_by !== 'sign-up' && approver?.trusted_by !== 'approval') trustedBy = 'sign-in';
    }
    const device = await trustDevice(tx, deps.policy, {
      userId: row.user_id,
      label: row.label,
      now,
      trustedBy,
      presentedKey: input.presentedKey,
    });
    return { userId: row.user_id, mfa: row.mfa, trustedDeviceId: device.id, deviceKey: device.key };
  });
}

/** Sign-ins waiting for approval on this account, newest first. */
export async function pendingAuthorisations(
  deps: TrustedDeviceDeps,
  userId: string,
): Promise<Array<{ flowId: string; label: string; createdAt: Date; expiresAt: Date }>> {
  const rows = await deps.sql<Array<{ flow_id: string; label: string; created_at: Date; expires_at: Date }>>`
    SELECT d.flow_id, d.label, d.created_at, f.expires_at
    FROM device_authorisations d JOIN auth_flows f ON f.id = d.flow_id
    WHERE d.user_id = ${userId} AND d.approved_at IS NULL AND d.completed_at IS NULL AND f.status <> 'locked'
      AND f.expires_at > ${deps.now()}
    ORDER BY d.created_at DESC
    LIMIT 20
  `;
  return rows.map((r) => ({ flowId: r.flow_id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at }));
}

/** The account's trusted devices; `current` marks the one this session signed in on. */
export async function listDevices(
  deps: TrustedDeviceDeps,
  input: { userId: string; sessionId: string | null },
): Promise<TrustedDeviceRow[]> {
  const now = deps.now();
  const rows = await deps.sql<
    Array<{ id: string; label: string; first_seen_at: Date; last_seen_at: Date; trusted_until: Date | null; current: boolean }>
  >`
    SELECT t.id, t.label, t.first_seen_at, t.last_seen_at, t.trusted_until,
           EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${input.sessionId} AND s.trusted_device_id = t.id) AS current
    FROM trusted_devices t
    WHERE t.user_id = ${input.userId} AND t.removed_at IS NULL AND (t.trusted_until IS NULL OR t.trusted_until > ${now})
    ORDER BY t.last_seen_at DESC
    LIMIT 100
  `;
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    trustedUntil: r.trusted_until,
    current: r.current,
  }));
}

/** Stop trusting a device and end the sessions signed in on it. The next sign-in there asks again. */
export async function removeDevice(
  deps: TrustedDeviceDeps,
  input: { userId: string; deviceId: string },
): Promise<{ removed: boolean; sessionsEnded: number }> {
  const now = deps.now();
  return deps.sql.begin(async (tx) => {
    const [row] = await tx<Array<{ id: string }>>`
      UPDATE trusted_devices SET removed_at = ${now}
      WHERE id = ${input.deviceId} AND user_id = ${input.userId} AND removed_at IS NULL
      RETURNING id
    `;
    if (!row) return { removed: false, sessionsEnded: 0 };
    const ended = await tx<Array<{ id: string }>>`
      UPDATE sessions SET revoked = true
      WHERE user_id = ${input.userId} AND revoked = false
        AND family_id IN (SELECT family_id FROM sessions WHERE user_id = ${input.userId} AND trusted_device_id = ${input.deviceId})
      RETURNING id
    `;
    return { removed: true, sessionsEnded: ended.length };
  });
}

/**
 * What another service may rely on about one device of one account now (`GET /internal/trusted-devices/:userId/:deviceId`).
 * Read-only: it never touches `last_seen_at`. A device of another account reads exactly like one that does not exist, and
 * no device of an account that is not active (frozen, closed) is live.
 */
export async function trustedDeviceState(
  q: Sql,
  policy: NewDevicePolicy,
  input: { userId: string; deviceId: string; now: Date },
): Promise<TrustedDeviceState> {
  const [row] = await q<Array<{ trusted_by: TrustedDeviceTrustedBy; live: boolean }>>`
    SELECT t.trusted_by,
           (t.removed_at IS NULL AND (t.trusted_until IS NULL OR t.trusted_until > ${input.now}) AND u.status = 'active') AS live
    FROM trusted_devices t JOIN users u ON u.id = t.user_id
    WHERE t.id = ${input.deviceId} AND t.user_id = ${input.userId}
  `;
  return {
    live: row?.live === true,
    trustedBy: row ? row.trusted_by : null,
    newDeviceCheck: policy.check ? 'on' : 'off',
  };
}
