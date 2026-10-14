/**
 * Preview stand-in for svc-identity's founder Security procedures (password change and reset, step-up, replace authenticator,
 * recovery codes, passkeys). `fixtureFounderSecurityHandlers(state)` returns `{ 'auth.x': (input) => … }` for `fixture.founderApi`.
 *
 * Everything is TEST data and obviously so: TOTP code 123456, recovery codes FACED-00001…10 (regenerated ones are FACED-10001…10010), a fake
 * authenticator secret under the issuer "INTAFACED TEST". Nothing here is a credential for anything.
 *
 * `state` is a plain object the other founder handlers can share. Missing keys are created on first use:
 *   state.password          current password (default 'TEST-founder-password')
 *   state.totpCode          the code that the "authenticator app" shows (default '123456')
 *   state.recoveryCodes     unused recovery codes (default FACED-00001 … FACED-00010)
 *   state.totpEnrolledAt, state.passwordChangedAt, state.passkeys, state.pendingSecret, state.stepUpAt, state.failures
 *
 * Handlers get only the request body, not the Bearer token, so "needs a step-up token" is modelled as "a successful
 * auth.stepUp happened in the last five minutes, and is used up by the one action it paid for".
 *
 * Passkey registration and passkey proofs refuse in the preview (there is no real credential to check).
 */
import { FixtureError } from './fixture.mjs';

const STEP_UP_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const TEST_SECRET = 'TESTTESTTESTTEST';
// Hex like the real ones (XXXXX-XXXXX, 0-9 A-F), because the console only accepts that form. FACED is hex.
const codes = (prefix, offset = 0) => Array.from({ length: 10 }, (_, index) => `${prefix}-${String(offset + index + 1).padStart(5, '0')}`);

export function fixtureFounderSecurityHandlers(state, clock = () => Date.now()) {
  state.password ??= 'TEST-founder-password';
  state.totpCode ??= '123456';
  state.recoveryCodes ??= codes('FACED');
  state.totpEnrolledAt ??= new Date(clock() - 20 * 86_400_000).toISOString();
  state.passwordChangedAt ??= null;
  state.passkeys ??= [{ credentialId: 'TEST-passkey-1', createdAt: new Date(clock() - 10 * 86_400_000).toISOString() }];
  state.pendingSecret ??= null;
  state.stepUpAt ??= null;
  state.failures ??= 0;

  const refuse = (code, status) => {
    throw new FixtureError(code, status);
  };
  /** A wrong guess counts toward a short lockout, like the real reserve counter. */
  const fail = (code, status) => {
    state.failures += 1;
    if (state.failures > MAX_FAILURES) refuse('auth.too_many_attempts', 429);
    refuse(code, status);
  };
  const succeeded = () => {
    state.failures = 0;
  };
  const policy = (password) => {
    if (typeof password !== 'string' || password.length < 12 || password.length > 200) refuse('auth.password_policy', 400);
  };
  const consumeStepUp = () => {
    if (state.stepUpAt === null || clock() - state.stepUpAt > STEP_UP_MS) refuse('auth.mfa_required', 403);
    state.stepUpAt = null;
  };
  /** A 6-digit code from the app, or an unused recovery code (which is then used up). */
  const checkCode = (code) => {
    if (code === state.totpCode) return true;
    const index = state.recoveryCodes.indexOf(String(code).toUpperCase());
    if (index === -1) return false;
    state.recoveryCodes.splice(index, 1);
    return true;
  };

  return {
    'auth.securityOverview': () => ({
      totpEnrolled: true,
      totpEnrolledAt: state.totpEnrolledAt,
      recoveryCodesRemaining: state.recoveryCodes.length,
      passkeys: state.passkeys.length,
      passwordChangedAt: state.passwordChangedAt,
    }),
    'webauthn.list': ({ limit }) => state.passkeys.slice(0, Math.min(Number(limit) || 50, 200)),
    'webauthn.remove': ({ credentialId }) => {
      consumeStepUp();
      const before = state.passkeys.length;
      state.passkeys = state.passkeys.filter((passkey) => passkey.credentialId !== credentialId);
      return { removed: state.passkeys.length < before };
    },
    // Adding a passkey needs a step-up first; the preview has no real authenticator, so it then refuses.
    'webauthn.registerOptions': () => {
      consumeStepUp();
      refuse('auth.webauthn_invalid', 400);
    },
    'auth.stepUpOptions': () => ({
      challenge: 'VEVTVC1TVEVQLVVQLUNIQUxMRU5HRQ',
      timeout: 60_000,
      rpId: 'localhost',
      userVerification: 'preferred',
      allowCredentials: state.passkeys.map((passkey) => ({ id: passkey.credentialId, type: 'public-key' })),
    }),
    'auth.stepUp': (input) => {
      if (input.webauthn) fail('auth.invalid_credentials', 401); // no real passkey exists in the preview
      if (!checkCode(input.totpCode)) fail('auth.invalid_credentials', 401);
      succeeded();
      state.stepUpAt = clock();
      return { accessToken: 'test-step-up-token', expiresAt: new Date(clock() + STEP_UP_MS).toISOString(), scopes: ['trade:withdraw'] };
    },
    'auth.changePassword': ({ currentPassword, newPassword }) => {
      if (currentPassword !== state.password) fail('auth.invalid_credentials', 401);
      policy(newPassword);
      if (newPassword === currentPassword) refuse('auth.password_unchanged', 400);
      succeeded();
      state.password = newPassword;
      state.passwordChangedAt = new Date(clock()).toISOString();
      return { ok: true };
    },
    'auth.setPassword': ({ newPassword }) => {
      consumeStepUp();
      policy(newPassword);
      state.password = newPassword;
      state.passwordChangedAt = new Date(clock()).toISOString();
      return { ok: true };
    },
    'totp.replaceBegin': () => {
      consumeStepUp();
      state.pendingSecret = TEST_SECRET;
      return {
        secret: TEST_SECRET,
        uri: `otpauth://totp/INTAFACED%20TEST:test-founder?secret=${TEST_SECRET}&issuer=INTAFACED%20TEST`,
      };
    },
    'totp.replaceConfirm': ({ code }) => {
      if (state.pendingSecret === null) refuse('auth.mfa_invalid', 400);
      // The fake "new app" shows the same test code, so the preview can be walked through.
      if (code !== state.totpCode) fail('auth.mfa_invalid', 400);
      succeeded();
      state.pendingSecret = null;
      state.totpEnrolledAt = new Date(clock()).toISOString();
      return { ok: true };
    },
    'totp.regenerateRecoveryCodes': () => {
      consumeStepUp();
      state.recoveryCodes = codes('FACED', 10000);
      return { recoveryCodes: [...state.recoveryCodes] };
    },
    'auth.resetPassword': ({ identifier, totpCode, recoveryCode, newPassword }) => {
      // One refusal for every reason, like the real procedure. Any non-empty identifier is accepted in the preview.
      const index = state.recoveryCodes.indexOf(String(recoveryCode).toUpperCase());
      if (!identifier || totpCode !== state.totpCode || index === -1 || typeof newPassword !== 'string' || newPassword.length < 12)
        fail('auth.reset_refused', 400);
      succeeded();
      state.recoveryCodes.splice(index, 1);
      state.password = newPassword;
      state.passwordChangedAt = new Date(clock()).toISOString();
      return { ok: true };
    },
  };
}
