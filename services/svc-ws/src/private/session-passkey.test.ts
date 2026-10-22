import { describe, expect, it } from 'vitest';
import { SessionPasskeyError, assertSessionPasskey, optionalLastVerifiedAt, optionalPasskeyCreds } from './session-passkey.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED = '2026-08-25T00:00:00.000Z';

describe('assertSessionPasskey', () => {
  it('enrolled + lastVerifiedAt may keep the stream open', () => {
    expect(() =>
      assertSessionPasskey({
        userId: USER,
        webauthnCreds: [{ credentialId: 'cred-1', lastVerifiedAt: VERIFIED }],
      }),
    ).not.toThrow();
    expect(optionalLastVerifiedAt({ lastVerifiedAt: VERIFIED })).toBe(VERIFIED);
  });

  it('empty webauthn_creds cannot keep the stream open', () => {
    try {
      assertSessionPasskey({ userId: USER, webauthn_creds: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
  });

  it('missing creds/lastVerifiedAt refuses verify unavailable', () => {
    try {
      assertSessionPasskey({ userId: USER, status: 'active' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
    expect(optionalPasskeyCreds({ userId: USER })).toBeUndefined();
  });

  it('creds without lastVerifiedAt refuses (no invented challenge)', () => {
    try {
      assertSessionPasskey({ userId: USER, webauthnCreds: [{ credentialId: 'cred-1' }] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
  });

  it('passkeyVerified true may keep the stream open', () => {
    expect(() => assertSessionPasskey({ userId: USER, passkeyVerified: true })).not.toThrow();
  });

  it('verified true on the body may keep the stream open', () => {
    expect(() => assertSessionPasskey({ userId: USER, verified: true })).not.toThrow();
  });

  it('root last_verified_at may keep the stream open', () => {
    expect(() => assertSessionPasskey({ userId: USER, last_verified_at: VERIFIED })).not.toThrow();
  });

  it('walks a tRPC envelope', () => {
    expect(() => assertSessionPasskey({ result: { data: { json: { lastVerifiedAt: VERIFIED } } } })).not.toThrow();
  });
});
