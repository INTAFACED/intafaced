/** Run: node --test tooling/preview/outreach/fixture-founder-enrolment.test.mjs */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureFounderEnrolmentHandlers, TEST_RECOVERY_CODES } from './fixture-founder-enrolment.mjs';

const join = (invite, extra = {}) => ({ invite, handle: 'test-one', email: 'one@example.test', password: 'a-test-password-1', ...extra });
const refusal = (run) => {
  try {
    run();
  } catch (error) {
    return { code: error.code, status: error.status };
  }
  assert.fail('expected a refusal');
};

describe('founder enrolment fixture', () => {
  it('registers with each test invite once, and says so on reuse', () => {
    const api = fixtureFounderEnrolmentHandlers({});
    assert.deepEqual(api['auth.founderEnrolmentStatus'](), { open: true });
    assert.match(api['auth.registerFounder'](join('TEST-INVITE-NITRO')).userId, /^[0-9a-f-]{36}$/);
    assert.equal(
      refusal(() => api['auth.registerFounder'](join('TEST-INVITE-NITRO', { handle: 'x', email: 'x@example.test' }))).code,
      'auth.invite_used',
    );
    assert.equal(
      refusal(() => api['auth.registerFounder'](join('NOPE', { handle: 'x', email: 'x@example.test' }))).code,
      'auth.invite_invalid',
    );
    api['auth.registerFounder'](join('TEST-INVITE-PHANTOM', { handle: 'test-two', email: 'two@example.test' }));
    assert.deepEqual(api['auth.founderEnrolmentStatus'](), { open: false });
  });

  it('refuses taken handles and emails, and a pinned pair', () => {
    const state = {};
    const api = fixtureFounderEnrolmentHandlers(state);
    api['auth.registerFounder'](join('TEST-INVITE-NITRO'));
    assert.equal(
      refusal(() => api['auth.registerFounder'](join('TEST-INVITE-PHANTOM', { email: 'other@example.test' }))).code,
      'auth.handle_taken',
    );
    assert.equal(refusal(() => api['auth.registerFounder'](join('TEST-INVITE-PHANTOM', { handle: 'other' }))).code, 'auth.email_taken');
    state.pinned = true;
    assert.equal(
      refusal(() => api['auth.registerFounder'](join('TEST-INVITE-PHANTOM', { handle: 'o', email: 'o@example.test' }))).code,
      'auth.founder_enrolment_closed',
    );
  });

  it('enrols an authenticator with 123456 only, locks after repeated misses, and ends on logout', () => {
    const api = fixtureFounderEnrolmentHandlers({});
    const session = api['auth.registerFounder'](join('TEST-INVITE-NITRO'));
    const started = api['totp.enrol']();
    assert.match(started.uri, /^otpauth:\/\/totp\//);
    assert.deepEqual(started.recoveryCodes, TEST_RECOVERY_CODES);
    assert.equal(refusal(() => api['totp.confirm']({ secret: started.secret, code: '000000' })).code, 'auth.mfa_invalid');
    assert.deepEqual(api['totp.confirm']({ secret: started.secret, code: '123456' }), { ok: true });
    // Passkeys: no step-up, no passkey. A fresh code buys a step-up, but the preview cannot do real WebAuthn.
    assert.equal(refusal(() => api['webauthn.registerOptions']()).code, 'auth.mfa_required');
    assert.equal(refusal(() => api['auth.stepUp']({ totpCode: '000000' })).code, 'auth.mfa_invalid');
    assert.match(api['auth.stepUp']({ totpCode: '123456' }).accessToken, /^test-stepup-/);
    assert.equal(refusal(() => api['webauthn.registerOptions']()).code, 'auth.passkey_preview_unavailable');
    assert.equal(refusal(() => api['webauthn.registerVerify']({})).code, 'auth.passkey_preview_unavailable');
    api['auth.logout']({ refreshToken: session.refreshToken });
    assert.equal(refusal(() => api['totp.enrol']()).code, 'auth.session_denied');
  });

  it('refreshes tokens, replacing the refresh token, and refuses a retired one', () => {
    const api = fixtureFounderEnrolmentHandlers({});
    const first = api['auth.registerFounder'](join('TEST-INVITE-NITRO'));
    const next = api['auth.refresh']({ refreshToken: first.refreshToken });
    assert.equal(next.userId, first.userId);
    assert.notEqual(next.refreshToken, first.refreshToken);
    assert.equal(refusal(() => api['auth.refresh']({ refreshToken: first.refreshToken })).code, 'auth.session_revoked');
    assert.deepEqual(api['totp.enrol']().recoveryCodes, TEST_RECOVERY_CODES);
  });

  it('answers too_many_attempts after five wrong codes', () => {
    const api = fixtureFounderEnrolmentHandlers({});
    api['auth.registerFounder'](join('TEST-INVITE-NITRO'));
    const { secret } = api['totp.enrol']();
    for (let i = 0; i < 5; i += 1) refusal(() => api['totp.confirm']({ secret, code: '000000' }));
    assert.equal(refusal(() => api['totp.confirm']({ secret, code: '123456' })).code, 'auth.too_many_attempts');
  });
});
