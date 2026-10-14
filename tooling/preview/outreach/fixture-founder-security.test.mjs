/** Run: node --test tooling/preview/outreach/fixture-founder-security.test.mjs */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureFounderSecurityHandlers } from './fixture-founder-security.mjs';

const setup = () => {
  const state = {};
  let now = Date.parse('2026-10-14T02:00:00Z');
  const h = fixtureFounderSecurityHandlers(state, () => now);
  return { state, h, advance: (ms) => (now += ms) };
};
const refused = (fn, code, status) => assert.throws(fn, (error) => error.code === code && error.status === status);

describe('founder security preview handlers', () => {
  it('reports an overview and one test passkey', () => {
    const { h } = setup();
    assert.deepEqual(
      { ...h['auth.securityOverview']({}), totpEnrolledAt: 'x' },
      { totpEnrolled: true, totpEnrolledAt: 'x', recoveryCodesRemaining: 10, passkeys: 1, passwordChangedAt: null },
    );
    assert.equal(h['webauthn.list']({ limit: 50 }).length, 1);
  });
  it('removes a passkey once, after a step-up', () => {
    const { h } = setup();
    refused(() => h['webauthn.remove']({ credentialId: 'TEST-passkey-1' }), 'auth.mfa_required', 403);
    h['auth.stepUp']({ totpCode: '123456' });
    assert.deepEqual(h['webauthn.remove']({ credentialId: 'TEST-passkey-1' }), { removed: true });
    h['auth.stepUp']({ totpCode: '123456' });
    assert.deepEqual(h['webauthn.remove']({ credentialId: 'TEST-passkey-1' }), { removed: false });
  });
  it('needs a step-up to add a passkey, then refuses in the preview', () => {
    const { h } = setup();
    refused(() => h['webauthn.registerOptions']({}), 'auth.mfa_required', 403);
    h['auth.stepUp']({ totpCode: '123456' });
    refused(() => h['webauthn.registerOptions']({}), 'auth.webauthn_invalid', 400);
  });
  it('changes the password with the right current one and refuses the rest', () => {
    const { h, state } = setup();
    refused(() => h['auth.changePassword']({ currentPassword: 'wrong', newPassword: 'a-new-password-1' }), 'auth.invalid_credentials', 401);
    refused(() => h['auth.changePassword']({ currentPassword: state.password, newPassword: 'short' }), 'auth.password_policy', 400);
    refused(
      () => h['auth.changePassword']({ currentPassword: state.password, newPassword: state.password }),
      'auth.password_unchanged',
      400,
    );
    assert.deepEqual(h['auth.changePassword']({ currentPassword: state.password, newPassword: 'a-new-password-1' }), { ok: true });
    assert.equal(state.password, 'a-new-password-1');
    assert.ok(state.passwordChangedAt);
  });
  it('locks out after repeated wrong guesses', () => {
    const { h } = setup();
    for (let i = 0; i < 5; i += 1)
      refused(() => h['auth.changePassword']({ currentPassword: 'x', newPassword: 'a-new-password-1' }), 'auth.invalid_credentials', 401);
    refused(() => h['auth.changePassword']({ currentPassword: 'x', newPassword: 'a-new-password-1' }), 'auth.too_many_attempts', 429);
  });
  it('needs a step-up for each sensitive action, and a step-up pays for exactly one', () => {
    const { h } = setup();
    refused(() => h['totp.regenerateRecoveryCodes']({}), 'auth.mfa_required', 403);
    refused(() => h['auth.stepUp']({ totpCode: '000000' }), 'auth.invalid_credentials', 401);
    assert.equal(h['auth.stepUp']({ totpCode: '123456' }).accessToken, 'test-step-up-token');
    const { recoveryCodes } = h['totp.regenerateRecoveryCodes']({});
    assert.equal(recoveryCodes.length, 10);
    assert.match(recoveryCodes[0], /^FACED-1\d{4}$/);
    refused(() => h['totp.regenerateRecoveryCodes']({}), 'auth.mfa_required', 403);
  });
  it('expires a step-up after five minutes', () => {
    const { h, advance } = setup();
    h['auth.stepUp']({ totpCode: '123456' });
    advance(5 * 60_000 + 1);
    refused(() => h['auth.setPassword']({ newPassword: 'a-new-password-1' }), 'auth.mfa_required', 403);
  });
  it('steps up with a recovery code, which is then used up, and refuses a passkey proof in the preview', () => {
    const { h, state } = setup();
    h['auth.stepUp']({ totpCode: 'FACED-00001' });
    assert.equal(state.recoveryCodes.length, 9);
    refused(() => h['auth.stepUp']({ totpCode: 'FACED-00001' }), 'auth.invalid_credentials', 401);
    refused(() => h['auth.stepUp']({ webauthn: {} }), 'auth.invalid_credentials', 401);
    assert.ok(h['auth.stepUpOptions']({}).challenge);
  });
  it('replaces the authenticator: step-up, a labelled test secret, then a confirmed code', () => {
    const { h } = setup();
    refused(() => h['totp.replaceBegin']({}), 'auth.mfa_required', 403);
    h['auth.stepUp']({ totpCode: '123456' });
    const begun = h['totp.replaceBegin']({});
    assert.match(begun.uri, /^otpauth:\/\/totp\/INTAFACED%20TEST:/);
    refused(() => h['totp.replaceConfirm']({ code: '999999' }), 'auth.mfa_invalid', 400);
    assert.deepEqual(h['totp.replaceConfirm']({ code: '123456' }), { ok: true });
    refused(() => h['totp.replaceConfirm']({ code: '123456' }), 'auth.mfa_invalid', 400);
  });
  it('sets a password after a step-up', () => {
    const { h, state } = setup();
    h['auth.stepUp']({ totpCode: '123456' });
    h['auth.setPassword']({ newPassword: 'another-new-password' });
    assert.equal(state.password, 'another-new-password');
  });
  it('resets a password with the app code and an unused recovery code, and refuses everything else the same way', () => {
    const { h, state } = setup();
    const good = { identifier: 'test-nitro', totpCode: '123456', recoveryCode: 'FACED-00002', newPassword: 'a-new-password-1' };
    refused(() => h['auth.resetPassword']({ ...good, totpCode: '000000' }), 'auth.reset_refused', 400);
    refused(() => h['auth.resetPassword']({ ...good, recoveryCode: 'FACED-99999' }), 'auth.reset_refused', 400);
    assert.deepEqual(h['auth.resetPassword'](good), { ok: true });
    assert.equal(state.password, 'a-new-password-1');
    refused(() => h['auth.resetPassword'](good), 'auth.reset_refused', 400);
  });
});
