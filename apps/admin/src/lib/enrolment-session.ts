import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AdminSessionError,
  adminSessionConfig,
  adminSessionErrorResponse,
  assertAdminOrigin,
  founderEdgeCall,
  type AdminSessionConfig,
} from './founder-session';

/**
 * The one-time founder enrolment session.
 *
 * A person who has just registered with an invite holds an ordinary, non-MFA identity session. That session may enrol a
 * second factor and must never become a console session, so it lives in its own sealed cookie, under its own key, with its
 * own additional authenticated data. A founder cookie does not open as an enrolment session, and an enrolment cookie does not
 * open as a founder session (see the tests): console routes read only `__Host-intafaced-admin`.
 */

export const ENROL_COOKIE = '__Host-intafaced-enrol';
export const ENROL_MAX_AGE_MS = 30 * 60 * 1000;
export const STEP_UP_MAX_MS = 5 * 60 * 1000;
/** Refresh the access token when it has less than this left. */
export const REFRESH_WITHIN_MS = 60 * 1000;
const KEY_INFO = 'intafaced-admin-enrol-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EnrolmentSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token expires. Refreshed before it lapses; the enrolment itself ends at `expiresAt`. */
  accessExpiresAt: string;
  /** End of the enrolment: 30 minutes after register, whatever the access token does. */
  expiresAt: string;
  issuedAt: string;
  csrf: string;
  totpConfirmed: boolean;
  /** Step-up token for adding a passkey (5 minutes). Held here and never sent to the browser; cleared after the passkey is verified. */
  stepUpToken: string | null;
  stepUpExpiresAt: string | null;
}

/**
 * The identity refusal codes the enrolment page has copy for, and so the only ones its routes pass on. Anything else is reported
 * as this server's own code alone. (The invite codes are an oracle on purpose: the real founder must see "already used".)
 */
export const ENROLMENT_UPSTREAM = [
  'auth.invite_invalid',
  'auth.invite_used',
  'auth.invite_expired',
  'auth.founder_enrolment_closed',
  'auth.handle_taken',
  'auth.email_taken',
  'auth.mfa_invalid',
  'auth.mfa_required',
  'auth.mfa_already_enrolled',
  'auth.too_many_attempts',
  'auth.password_policy',
  'auth.webauthn_invalid',
  'auth.passkey_preview_unavailable',
] as const;

/** Everything is off unless this is exactly `open`. */
export function enrolmentIsOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env.ADMIN_FOUNDER_ENROLMENT === 'open';
}

/** The refusal every `/api/enroll/*` route gives while the switch is off. */
export function enrolmentOffResponse(): Response {
  return Response.json({ code: 'admin.enrolment_off' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

/** A key of its own, derived from ADMIN_SESSION_SECRET, so the founder key never seals or opens an enrolment cookie. */
function enrolmentKey(config: AdminSessionConfig): Buffer {
  return Buffer.from(hkdfSync('sha256', config.key, Buffer.alloc(0), KEY_INFO, 32));
}

function aad(config: AdminSessionConfig): Buffer {
  return Buffer.from(`${ENROL_COOKIE}\n${config.origin}\nenrol-v1`);
}

function validEnrolmentSession(value: unknown, now: Date): value is EnrolmentSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
    'accessExpiresAt,accessToken,csrf,expiresAt,issuedAt,refreshToken,stepUpExpiresAt,stepUpToken,totpConfirmed,userId'
  )
    return false;
  if (typeof row.userId !== 'string' || !UUID.test(row.userId)) return false;
  if (typeof row.accessToken !== 'string' || row.accessToken.length < 1 || row.accessToken.length > 2600) return false;
  if (typeof row.refreshToken !== 'string' || row.refreshToken.length < 1 || row.refreshToken.length > 256) return false;
  if (typeof row.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.csrf)) return false;
  if (typeof row.totpConfirmed !== 'boolean') return false;
  if (typeof row.expiresAt !== 'string' || typeof row.issuedAt !== 'string' || typeof row.accessExpiresAt !== 'string') return false;
  if (!Number.isFinite(Date.parse(row.accessExpiresAt))) return false;
  const issued = Date.parse(row.issuedAt);
  const expires = Date.parse(row.expiresAt);
  if ((row.stepUpToken === null) !== (row.stepUpExpiresAt === null)) return false;
  if (row.stepUpToken !== null) {
    if (typeof row.stepUpToken !== 'string' || row.stepUpToken.length < 1 || row.stepUpToken.length > 2600) return false;
    if (typeof row.stepUpExpiresAt !== 'string') return false;
    const stepUp = Date.parse(row.stepUpExpiresAt);
    if (!Number.isFinite(stepUp) || stepUp > expires) return false;
  }
  return (
    Number.isFinite(issued) &&
    Number.isFinite(expires) &&
    issued <= now.getTime() &&
    expires > now.getTime() &&
    expires > issued &&
    expires - issued <= ENROL_MAX_AGE_MS
  );
}

export function sealEnrolmentSession(session: EnrolmentSession, config: AdminSessionConfig, now: Date = new Date()): string {
  if (!validEnrolmentSession(session, now)) throw new AdminSessionError('admin.enrolment_invalid', 401);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', enrolmentKey(config), iv);
  cipher.setAAD(aad(config));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  const encoded = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  if (encoded.length > 3800) throw new AdminSessionError('admin.session_too_large', 502);
  return encoded;
}

export function openEnrolmentSession(cookieHeader: string | null, config: AdminSessionConfig, now: Date = new Date()): EnrolmentSession {
  try {
    const values = (cookieHeader ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${ENROL_COOKIE}=`));
    if (values.length !== 1) throw new Error();
    const encoded = values[0]!.slice(ENROL_COOKIE.length + 1);
    if (encoded.length > 3800 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== encoded) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', enrolmentKey(config), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(aad(config));
    const payload: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (!validEnrolmentSession(payload, now)) throw new Error();
    return payload;
  } catch {
    throw new AdminSessionError('admin.enrolment_required', 401);
  }
}

/**
 * Builds the session from the identity `registerFounder` reply. The enrolment ends 30 minutes after register, whatever the access
 * token does: the access token is refreshed as needed (see `handleEnrolment`).
 */
export function newEnrolmentSession(value: unknown, now: Date = new Date()): EnrolmentSession {
  if (!value || typeof value !== 'object') throw new AdminSessionError('admin.upstream_invalid', 502);
  const row = value as Record<string, unknown>;
  const session = {
    userId: row.userId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessExpiresAt: row.expiresAt,
    expiresAt: new Date(now.getTime() + ENROL_MAX_AGE_MS).toISOString(),
    issuedAt: now.toISOString(),
    csrf: randomBytes(32).toString('base64url'),
    totpConfirmed: false,
    stepUpToken: null,
    stepUpExpiresAt: null,
  };
  if (!validEnrolmentSession(session, now)) throw new AdminSessionError('admin.upstream_invalid', 502);
  return session;
}

export function enrolmentCookie(value: string, maxAgeSeconds: number): string {
  return `${ENROL_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** Seconds the cookie should live: until the enrolment's own end. */
export function enrolmentCookieAge(session: EnrolmentSession, now: Date = new Date()): number {
  return (Date.parse(session.expiresAt) - now.getTime()) / 1000;
}

/** The cookie header that stores `session`. */
export function enrolmentSetCookie(session: EnrolmentSession, config: AdminSessionConfig, now: Date = new Date()): string {
  return enrolmentCookie(sealEnrolmentSession(session, config, now), enrolmentCookieAge(session, now));
}

/** The step-up token if it is still live, else null. */
export function liveStepUpToken(session: EnrolmentSession, now: Date = new Date()): string | null {
  return session.stepUpToken !== null && session.stepUpExpiresAt !== null && Date.parse(session.stepUpExpiresAt) > now.getTime()
    ? session.stepUpToken
    : null;
}

/** Records a step-up token, kept for at most five minutes (and never past the end of the enrolment). */
export function withStepUp(session: EnrolmentSession, token: string, upstreamExpiresAt: unknown, now: Date = new Date()): EnrolmentSession {
  const upstream = typeof upstreamExpiresAt === 'string' ? Date.parse(upstreamExpiresAt) : NaN;
  if (typeof token !== 'string' || !token || !Number.isFinite(upstream)) throw new AdminSessionError('admin.upstream_invalid', 502);
  const end = Math.min(upstream, now.getTime() + STEP_UP_MAX_MS, Date.parse(session.expiresAt));
  return { ...session, stepUpToken: token, stepUpExpiresAt: new Date(end).toISOString() };
}

export function withoutStepUp(session: EnrolmentSession): EnrolmentSession {
  return { ...session, stepUpToken: null, stepUpExpiresAt: null };
}

export function assertEnrolmentCsrf(request: Request, session: EnrolmentSession): void {
  const actual = Buffer.from(request.headers.get('x-intafaced-csrf') ?? '');
  const expected = Buffer.from(session.csrf);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdminSessionError('admin.session_csrf', 403);
}

/**
 * Swaps the refresh token for new tokens when the access token has under 60 seconds left. Identity may rotate the refresh token,
 * so the caller must store what comes back (`handleEnrolment` does). Any failure means the enrolment cannot continue.
 */
export async function refreshEnrolmentSession(
  session: EnrolmentSession,
  config: AdminSessionConfig,
  now: Date = new Date(),
): Promise<EnrolmentSession> {
  try {
    const raw = (await founderEdgeCall(config, 'identity', 'auth.refresh', 'POST', { refreshToken: session.refreshToken })) as Record<
      string,
      unknown
    > | null;
    if (
      !raw ||
      typeof raw.accessToken !== 'string' ||
      !raw.accessToken ||
      raw.accessToken.length > 2600 ||
      typeof raw.refreshToken !== 'string' ||
      !raw.refreshToken ||
      raw.refreshToken.length > 256 ||
      typeof raw.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.expiresAt)) ||
      (raw.userId !== undefined && raw.userId !== session.userId)
    )
      throw new Error();
    const next = { ...session, accessToken: raw.accessToken, refreshToken: raw.refreshToken, accessExpiresAt: raw.expiresAt };
    if (!validEnrolmentSession(next, now)) throw new Error();
    return next;
  } catch {
    throw new AdminSessionError('admin.enrolment_expired', 401);
  }
}

export interface EnrolmentContext {
  session: EnrolmentSession;
  config: AdminSessionConfig;
}
export interface EnrolmentResult {
  /** The JSON body. Never put a token in it. */
  body: unknown;
  /** The session to store if it changed (otherwise a refreshed session is stored, and an unchanged one is left alone). */
  session?: EnrolmentSession;
  /** End the enrolment: clear the cookie. */
  clear?: boolean;
}

/**
 * What every enrolment route after `register` does: the off switch, a same-origin mutation, a valid enrolment cookie with the
 * matching CSRF header, the authenticator step when asked, and a refresh of the access token if it is about to lapse. The new
 * cookie is set on the reply whenever the tokens changed, including on a refusal, because identity may have retired the old
 * refresh token.
 *
 * `fresh: false` skips the refresh, for routes that make no call needing the access token (logout takes the refresh token).
 */
export async function handleEnrolment(
  request: Request,
  options: { confirmed?: boolean; fresh?: boolean },
  run: (context: EnrolmentContext) => Promise<EnrolmentResult>,
): Promise<Response> {
  if (!enrolmentIsOpen()) return enrolmentOffResponse();
  let stored: EnrolmentSession | null = null;
  let config: AdminSessionConfig | null = null;
  try {
    const authorised = authorizeEnrolment(request, { confirmed: options.confirmed === true });
    config = authorised.config;
    let session = authorised.session;
    if (options.fresh !== false && Date.parse(session.accessExpiresAt) - Date.now() < REFRESH_WITHIN_MS) {
      session = await refreshEnrolmentSession(session, config);
      stored = session;
    }
    const result = await run({ session, config });
    if (result.session) stored = result.session;
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (result.clear) headers['set-cookie'] = enrolmentCookie('', 0);
    else if (stored) headers['set-cookie'] = enrolmentSetCookie(stored, config);
    return Response.json(result.body, { headers });
  } catch (error) {
    const response = adminSessionErrorResponse(error, ENROLMENT_UPSTREAM);
    if (stored && config) response.headers.set('set-cookie', enrolmentSetCookie(stored, config));
    return response;
  }
}

/**
 * First checks of an enrolment route: same-origin mutation, a valid enrolment cookie, the matching CSRF header, and, with
 * `confirmed`, the completed authenticator step.
 */
export function authorizeEnrolment(request: Request, options: { confirmed?: boolean } = {}): EnrolmentContext {
  const config = adminSessionConfig();
  assertAdminOrigin(request, config, true);
  const session = openEnrolmentSession(request.headers.get('cookie'), config);
  assertEnrolmentCsrf(request, session);
  if (options.confirmed && !session.totpConfirmed) throw new AdminSessionError('admin.enrolment_totp_required', 409);
  return { session, config };
}
