import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { FounderControls, founderActorRefusal, hasVerifiedSecondFactor, parseFounderPair } from './founder-controls.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-10-10T12:00:00Z');
const principal: Principal = {
  sub: A,
  userId: A,
  scopes: ['identity:write'],
  sid: S,
  tier: 'none',
  mfa: true,
  expiresAt: new Date(now.getTime() + 60000),
};
const context: Context = { principal, service: null, region: 'DE', requestId: 'test' };
const user = {
  id: A,
  status: 'active' as const,
  identity_control_version: '0',
  totp_enrolled_at: now,
  totp_secret: 'test-verified-factor',
  webauthn_creds: [],
};
const session = { id: S, user_id: A, mfa: true, revoked: false, expires_at: new Date(now.getTime() + 60000) };
const entitlement = { user_id: A, enabled: true, version: '1', changed_at: now };

describe('founder identity authority', () => {
  it('requires two distinct UUIDs rather than GitHub handles or labels', () => {
    expect(parseFounderPair(B, A)).toEqual([A, B]);
    for (const [first, second] of [
      [undefined, B],
      ['', B],
      [A, A],
      ['Nitro', 'Phantom'],
      [A, 'not-a-uuid'],
    ]) {
      expect(parseFounderPair(first, second)).toBeNull();
    }
  });
  it('requires enrolled TOTP or a credential carrying verified passkey evidence', () => {
    expect(hasVerifiedSecondFactor(user)).toBe(true);
    const credential = { credentialId: 'key', publicKey: 'test-key', counter: 0, createdAt: now.toISOString() };
    expect(hasVerifiedSecondFactor({ totp_enrolled_at: null, totp_secret: null, webauthn_creds: [credential] })).toBe(true);
    for (const malformed of [
      { ...credential, counter: -1 },
      { ...credential, counter: 0.5 },
      { ...credential, createdAt: 'invalid' },
    ]) {
      expect(hasVerifiedSecondFactor({ totp_enrolled_at: null, totp_secret: null, webauthn_creds: [malformed] })).toBe(false);
    }
    expect(hasVerifiedSecondFactor({ ...user, totp_secret: null })).toBe(false);
    expect(
      hasVerifiedSecondFactor({
        totp_enrolled_at: null,
        totp_secret: null,
        webauthn_creds: [{ credentialId: 'key', publicKey: 'test-key' }],
      }),
    ).toBe(false);
  });
  it('accepts actual interactive founder authority without generic admin scopes or a second approver', () => {
    expect(founderActorRefusal(context, [A, B], user, session, entitlement, now)).toBeNull();
  });
  it('refuses API keys, service identity, subaccounts, expired access and revoked/foreign sessions', () => {
    for (const denied of [
      { ...context, service: 'svc-ops' },
      { ...context, principal: { ...principal, kid: B } },
      { ...context, principal: { ...principal, sub_account: B } },
      { ...context, principal: { ...principal, expiresAt: now } },
      { ...context, principal: { ...principal, userId: B } },
    ])
      expect(founderActorRefusal(denied, [A, B], user, session, entitlement, now)).toBe('operator.denied');
    for (const row of [
      { ...session, revoked: true },
      { ...session, expires_at: now },
      { ...session, user_id: B },
      { ...session, id: B },
    ]) {
      expect(founderActorRefusal(context, [A, B], user, row, entitlement, now)).toBe('operator.denied');
    }
    expect(founderActorRefusal(context, [A, B], { ...user, status: 'frozen' }, session, entitlement, now)).toBe('operator.denied');
    expect(founderActorRefusal(context, [A, B], user, session, { ...entitlement, enabled: false }, now)).toBe('operator.denied');
  });
  it('requires both token MFA and current DB session MFA', () => {
    expect(founderActorRefusal({ ...context, principal: { ...principal, mfa: false } }, [A, B], user, session, entitlement, now)).toBe(
      'mfa.required',
    );
    expect(founderActorRefusal(context, [A, B], user, { ...session, mfa: false }, entitlement, now)).toBe('mfa.required');
  });
  it('does not fabricate persisted success when the migration/storage is missing', async () => {
    const unavailable = {
      begin: async () => {
        throw Object.assign(new Error('missing migration'), { code: '42P01' });
      },
    } as unknown as ConstructorParameters<typeof FounderControls>[0];
    const controls = new FounderControls(unavailable, [A, B]);
    expect(await controls.bootstrap()).toBe(false);
    await expect(
      controls.change(context, {
        requestId: S,
        target: { area: 'identity', userId: B },
        action: 'restrict',
        reason: 'Incident review',
        expectedVersion: '0',
      }),
    ).rejects.toMatchObject({ code: 'identity.controls_unconfigured' });
  });
});
