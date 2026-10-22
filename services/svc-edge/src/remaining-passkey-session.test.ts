import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { remainingPasskeyOpensSession } from './remaining-passkey-session.js';
import { SessionPasskeyError, assertIdentitySessionPasskey, assertSessionPasskey } from './session-passkey.js';

const USER = '11111111-1111-4111-8111-111111111111';
const VERIFIED = '2026-08-25T00:00:00.000Z';

const REMAINING_VERIFIED = {
  userId: USER,
  webauthnCreds: [{ credentialId: 'cred-2', lastVerifiedAt: VERIFIED }],
};

const options = {
  identityUrl: 'http://identity.test',
  userId: USER,
  identityOwnershipSecret: 'edge-test-identity-ownership-secret-32',
};

describe('remainingPasskeyOpensSession — unenroll first of two', () => {
  it('remaining verified cred opens the session; no new session minted', async () => {
    expect(() => remainingPasskeyOpensSession(REMAINING_VERIFIED)).not.toThrow();
    expect(() => assertSessionPasskey(REMAINING_VERIFIED)).not.toThrow();
    await expect(
      assertIdentitySessionPasskey({
        ...options,
        fetch: async () =>
          new Response(JSON.stringify(REMAINING_VERIFIED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it('remaining cred without lastVerifiedAt is auth.passkey_verify_unavailable', () => {
    const remainingUnverified = { userId: USER, webauthnCreds: [{ credentialId: 'cred-2' }] };
    try {
      remainingPasskeyOpensSession(remainingUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
    try {
      assertSessionPasskey(remainingUnverified);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_verify_unavailable');
    }
  });

  it('empty remaining creds is auth.passkey_missing', () => {
    const empty = { userId: USER, webauthnCreds: [] };
    try {
      remainingPasskeyOpensSession(empty);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
    try {
      assertSessionPasskey(empty);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPasskeyError);
      expect((err as SessionPasskeyError).code).toBe('auth.passkey_missing');
    }
  });

  it('source reuses assertSessionPasskey; no invented challenge or session', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'remaining-passkey-session.ts'), 'utf8');
    expect(src).toMatch(/assertSessionPasskey/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
    expect(src).not.toMatch(/INSERT INTO sessions/);
  });
});
