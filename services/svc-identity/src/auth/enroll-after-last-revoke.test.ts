import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { newlyEnrolledPasskeyRevokes, revokeApiKeyAfterNewlyEnrolledPasskey } from './enroll-after-last-revoke.js';

// The WebAuthn library, watched: revoking after a passkey must never start a ceremony of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...real, generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions) };
});

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  return fn as unknown as Parameters<typeof revokeApiKeyAfterNewlyEnrolledPasskey>[1];
}

/** A `sql` tag that answers every query with `rows` and records each statement's text. */
function recordingSql(rows: unknown[]) {
  const statements: string[] = [];
  const fn = async (strings: TemplateStringsArray) => {
    statements.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return rows;
  };
  return { sql: fn as Parameters<typeof revokeApiKeyAfterNewlyEnrolledPasskey>[1], statements };
}

/** The code a synchronous check refuses with, or null when it passes. */
function refusalOf(check: () => void): unknown {
  try {
    check();
    return null;
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
}

function makeMinter() {
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey() {
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, revoked };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const verifiedAt = '2026-08-25T00:00:00.000Z';
const enrolledAgain = {
  credentialId: 'cred-3',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
  lastVerifiedAt: verifiedAt,
};
const enrolledUnverified = {
  credentialId: 'cred-3',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
};
const revokeInput = { userId: A, keyId: 'old' };

describe('newlyEnrolledPasskeyRevokes — enroll after last unenroll', () => {
  it('newly enrolled verified cred revokes; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyRevokes([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const { minter, revoked } = makeMinter();
    await expect(
      revokeApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [enrolledAgain] }]), revokeInput),
    ).resolves.toEqual({ revokedKeyId: 'old' });
    expect(revoked).toEqual(['old']);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokes([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, revoked } = makeMinter();
    await expect(
      revokeApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [enrolledUnverified] }]), revokeInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(revoked).toEqual([]);
  });

  it('empty after last unenroll is auth.passkey_missing and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokes([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, revoked } = makeMinter();
    await expect(revokeApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [] }]), revokeInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(revoked).toEqual([]);
  });

  it("gates on requireVerifiedPasskey, then revokes through the minter's revokeApiKey alone; no invented challenge", async () => {
    for (const creds of [[enrolledAgain], [enrolledUnverified], []]) {
      const { minter, revoked } = makeMinter();
      const { sql, statements } = recordingSql([{ webauthn_creds: creds }]);
      const gate = refusalOf(() => requireVerifiedPasskey(creds));
      const out = revokeApiKeyAfterNewlyEnrolledPasskey(minter, sql, revokeInput);
      if (gate) {
        await expect(out).rejects.toMatchObject({ code: gate });
        expect(revoked).toEqual([]);
      } else {
        await expect(out).resolves.toEqual({ revokedKeyId: 'old' });
        expect(revoked).toEqual(['old']);
      }
      // Its one statement is the read of the stored passkeys: no challenge or key is written here.
      expect(statements).toEqual(['SELECT webauthn_creds FROM users WHERE id = ? LIMIT 1']);
    }
    // A key the minter does not revoke is not found, never reported revoked.
    const missing: ApiKeyMinter = { ...makeMinter().minter, revokeApiKey: async () => false };
    await expect(
      revokeApiKeyAfterNewlyEnrolledPasskey(missing, fakeSql([{ webauthn_creds: [enrolledAgain] }]), revokeInput),
    ).rejects.toMatchObject({ code: 'auth.not_found' });
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });
});
