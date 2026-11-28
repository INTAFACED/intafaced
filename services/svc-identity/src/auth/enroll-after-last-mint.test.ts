import { describe, expect, it, vi } from 'vitest';
import { fakeSql as kitFakeSql } from '@intafaced/service-kit/testing';
import * as webauthnLib from '@simplewebauthn/server';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { mintApiKeyAfterNewlyEnrolledPasskey, newlyEnrolledPasskeyMints } from './enroll-after-last-mint.js';

// The WebAuthn library, watched: minting after a passkey must never start a ceremony of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...real, generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions) };
});

function fakeSql(rows: unknown[] = []) {
  return kitFakeSql<Parameters<typeof mintApiKeyAfterPasskey>[1]>(rows);
}

/** A `sql` tag that answers every query with `rows` and records each statement's text. */
function recordingSql(rows: unknown[]) {
  const statements: string[] = [];
  const fn = async (strings: TemplateStringsArray) => {
    statements.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return rows;
  };
  return { sql: fn as Parameters<typeof mintApiKeyAfterPasskey>[1], statements };
}

/** A call's outcome: its answer, or the code it refused with. */
async function settle<T>(p: Promise<T>): Promise<{ value: T } | { code: unknown }> {
  try {
    return { value: await p };
  } catch (err) {
    return { code: (err as { code?: unknown }).code };
  }
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
  const created: unknown[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey() {
      return true;
    },
  };
  return { minter, created };
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
const mintInput = {
  userId: A,
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'] as const,
};

describe('newlyEnrolledPasskeyMints — enroll after last unenroll', () => {
  it('newly enrolled verified cred mints; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyMints([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [enrolledAgain] }]), mintInput)).resolves.toEqual({
      id: 'k1',
      key: 'ifk_live_secret',
      prefix: 'ifk_live',
      mode: 'live',
    });
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [enrolledAgain] }]), mintInput)).resolves.toMatchObject({
      id: 'k1',
    });
    expect(created).toHaveLength(2);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not mint', async () => {
    try {
      newlyEnrolledPasskeyMints([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, created } = makeMinter();
    await expect(
      mintApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [enrolledUnverified] }]), mintInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
  });

  it('empty after last unenroll is auth.passkey_missing and does not mint', async () => {
    try {
      newlyEnrolledPasskeyMints([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterNewlyEnrolledPasskey(minter, fakeSql([{ webauthn_creds: [] }]), mintInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
  });

  it('mints and refuses exactly as mintApiKeyAfterPasskey does; no invented challenge', async () => {
    for (const creds of [[enrolledAgain], [enrolledUnverified], []]) {
      const own = makeMinter();
      const ownSql = recordingSql([{ webauthn_creds: creds }]);
      const ownOut = await settle(mintApiKeyAfterNewlyEnrolledPasskey(own.minter, ownSql.sql, mintInput));
      const base = makeMinter();
      const baseSql = recordingSql([{ webauthn_creds: creds }]);
      const baseOut = await settle(mintApiKeyAfterPasskey(base.minter, baseSql.sql, mintInput));
      expect(ownOut).toEqual(baseOut);
      expect(own.created).toEqual(base.created);
      expect(ownSql.statements).toEqual(baseSql.statements);
      // The gate is requireVerifiedPasskey's on the stored passkeys: its refusal, or a minted key.
      const gate = refusalOf(() => requireVerifiedPasskey(creds));
      if (gate) expect(ownOut).toEqual({ code: gate });
      else expect(ownOut).toEqual({ value: { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: 'live' } });
      expect(ownSql.statements.filter((s) => /INSERT\s+(INTO\s+)?challenges/i.test(s))).toEqual([]);
    }
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });
});
