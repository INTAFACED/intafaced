import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { mintApiKeyAfterRemainingPasskey, remainingPasskeyMints } from './remaining-passkey-mint.js';

// The WebAuthn library, watched: minting after a passkey must never start a ceremony of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...real, generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions) };
});

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  return fn as unknown as Parameters<typeof mintApiKeyAfterPasskey>[1];
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
const remaining = {
  credentialId: 'cred-2',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T00:00:00.000Z',
  lastVerifiedAt: verifiedAt,
};
const remainingUnverified = { credentialId: 'cred-2', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const mintInput = {
  userId: A,
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'] as const,
};

describe('remainingPasskeyMints — unenroll first of two', () => {
  it('remaining verified cred mints; no invented challenge', async () => {
    expect(() => remainingPasskeyMints([remaining])).not.toThrow();
    expect(() => requireVerifiedPasskey([remaining])).not.toThrow();
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterRemainingPasskey(minter, fakeSql([{ webauthn_creds: [remaining] }]), mintInput)).resolves.toEqual({
      id: 'k1',
      key: 'ifk_live_secret',
      prefix: 'ifk_live',
      mode: 'live',
    });
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [remaining] }]), mintInput)).resolves.toMatchObject({
      id: 'k1',
    });
    expect(created).toHaveLength(2);
  });

  it('remaining cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not mint', async () => {
    try {
      remainingPasskeyMints([remainingUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, created } = makeMinter();
    await expect(
      mintApiKeyAfterRemainingPasskey(minter, fakeSql([{ webauthn_creds: [remainingUnverified] }]), mintInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
  });

  it('empty remaining creds is auth.passkey_missing and does not mint', async () => {
    try {
      remainingPasskeyMints([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterRemainingPasskey(minter, fakeSql([{ webauthn_creds: [] }]), mintInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
  });

  it('mints and refuses exactly as mintApiKeyAfterPasskey does; no invented challenge', async () => {
    for (const creds of [[remaining], [remainingUnverified], []]) {
      const own = makeMinter();
      const ownSql = recordingSql([{ webauthn_creds: creds }]);
      const ownOut = await settle(mintApiKeyAfterRemainingPasskey(own.minter, ownSql.sql, mintInput));
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
