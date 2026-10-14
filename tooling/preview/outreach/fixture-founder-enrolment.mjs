/**
 * In-memory stand-in for svc-identity's founder enrolment, for the local click-through preview only.
 *
 * Every value is an obvious test value: invites TEST-INVITE-NITRO and TEST-INVITE-PHANTOM (each works once), authenticator code
 * 123456, recovery codes FACED-00001 to FACED-00010. Nothing is stored beyond this process, and nothing is a real credential.
 *
 * Usage: `const handlers = fixtureFounderEnrolmentHandlers(state)`, then merge into `founderApi`. Pass the same `state` object
 * to keep one enrolment across calls. Set `state.pinned = true` to see the closed path.
 *
 * Refusals are thrown as an Error with `.code` (an `auth.*` code) and `.status` (the HTTP status), which run.mjs must pass on as
 * `data.intafacedCode`.
 */
import { randomUUID } from 'node:crypto';

export const TEST_INVITES = ['TEST-INVITE-NITRO', 'TEST-INVITE-PHANTOM'];
export const TEST_TOTP_CODE = '123456';
export const TEST_RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `FACED-${String(index + 1).padStart(5, '0')}`);
const TEST_SECRET = 'JBSWY3DPEHPK3PXP';
const MAX_WRONG_CODES = 5;
const ACCESS_TTL_MS = 15 * 60_000; // identity's default access TTL is 900 s
const STEP_UP_TTL_MS = 5 * 60_000;

export class FixtureAuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function prepare(state) {
  state.invitesUsed ??= new Set();
  state.users ??= []; // { userId, handle, email, totpEnrolled, wrongCodes }
  state.sessions ??= new Map(); // refreshToken -> userId
  state.stepUpUntil ??= 0; // a granted step-up, until this time (ms)
  state.current ??= null; // the most recent registered user: the preview has one browser
  state.pinned ??= false;
  return state;
}

export function fixtureFounderEnrolmentHandlers(rawState = {}) {
  const state = prepare(rawState);
  const normalise = (value) =>
    String(value ?? '')
      .trim()
      .toUpperCase();
  const signedIn = () => {
    const user = state.users.find((row) => row.userId === state.current);
    const live = user && [...state.sessions.values()].includes(user.userId);
    if (!user || !live) throw new FixtureAuthError('auth.session_denied', 401);
    return user;
  };

  const passkeyGate = () => {
    signedIn();
    if (Date.now() >= state.stepUpUntil) throw new FixtureAuthError('auth.mfa_required', 403);
    throw new FixtureAuthError('auth.passkey_preview_unavailable', 501);
  };

  return {
    'auth.founderEnrolmentStatus': () => ({
      open: !state.pinned && TEST_INVITES.some((invite) => !state.invitesUsed.has(invite)),
    }),

    'auth.registerFounder': (input) => {
      if (state.pinned) throw new FixtureAuthError('auth.founder_enrolment_closed', 403);
      const invite = normalise(input?.invite);
      if (!TEST_INVITES.includes(invite)) throw new FixtureAuthError('auth.invite_invalid', 400);
      if (state.invitesUsed.has(invite)) throw new FixtureAuthError('auth.invite_used', 409);
      if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 200)
        throw new FixtureAuthError('auth.password_policy', 400);
      const handle = String(input.handle ?? '')
        .trim()
        .toLowerCase();
      const email = String(input.email ?? '')
        .trim()
        .toLowerCase();
      if (state.users.some((row) => row.handle === handle)) throw new FixtureAuthError('auth.handle_taken', 409);
      if (state.users.some((row) => row.email === email)) throw new FixtureAuthError('auth.email_taken', 409);
      state.invitesUsed.add(invite);
      const userId = randomUUID();
      state.users.push({ userId, handle, email, totpEnrolled: false, wrongCodes: 0 });
      const refreshToken = `test-enrol-refresh-${userId}`;
      state.sessions.set(refreshToken, userId);
      state.current = userId;
      return {
        userId,
        accessToken: `test-enrol-access-${userId}`,
        refreshToken,
        expiresAt: new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
      };
    },

    'totp.enrol': () => {
      const user = signedIn();
      if (user.totpEnrolled) throw new FixtureAuthError('auth.mfa_already_enrolled', 409);
      return {
        secret: TEST_SECRET,
        uri: `otpauth://totp/INTAFACED:${encodeURIComponent(user.email)}?secret=${TEST_SECRET}&issuer=INTAFACED`,
        recoveryCodes: TEST_RECOVERY_CODES,
      };
    },

    'totp.confirm': (input) => {
      const user = signedIn();
      if (user.wrongCodes >= MAX_WRONG_CODES) throw new FixtureAuthError('auth.too_many_attempts', 429);
      if (input?.secret !== TEST_SECRET || input?.code !== TEST_TOTP_CODE) {
        user.wrongCodes += 1;
        throw new FixtureAuthError('auth.mfa_invalid', 400);
      }
      user.totpEnrolled = true;
      return { ok: true };
    },

    'auth.refresh': (input) => {
      const userId = state.sessions.get(input?.refreshToken);
      if (!userId) throw new FixtureAuthError('auth.session_revoked', 403);
      // Like identity, the refresh token is replaced each time.
      state.sessions.delete(input.refreshToken);
      const refreshToken = `test-enrol-refresh-${userId}-${state.sessions.size + 1}-${Date.now()}`;
      state.sessions.set(refreshToken, userId);
      return {
        userId,
        accessToken: `test-enrol-access-${userId}-${Date.now()}`,
        refreshToken,
        expiresAt: new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
      };
    },

    // Step-up for the passkey step: a fresh authenticator code buys a five-minute token. The fixture sees no headers, so it
    // remembers the grant instead.
    'auth.stepUp': (input) => {
      const user = signedIn();
      if (!user.totpEnrolled || input?.totpCode !== TEST_TOTP_CODE) throw new FixtureAuthError('auth.mfa_invalid', 400);
      state.stepUpUntil = Date.now() + STEP_UP_TTL_MS;
      return {
        accessToken: `test-stepup-${user.userId}`,
        expiresAt: new Date(state.stepUpUntil).toISOString(),
        scopes: [],
      };
    },

    // Like the real gate: no step-up, no passkey (`auth.mfa_required`). With one, the preview cannot do real WebAuthn.
    'webauthn.registerOptions': () => passkeyGate(),
    'webauthn.registerVerify': () => passkeyGate(),

    'auth.logout': (input) => {
      state.sessions.delete(input?.refreshToken);
      return { signedOut: true };
    },
  };
}
