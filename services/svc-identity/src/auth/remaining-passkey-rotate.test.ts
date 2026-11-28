import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';
import { remainingPasskeyRotates, rotateApiKeyAfterRemainingPasskey } from './remaining-passkey-rotate.js';

// The WebAuthn library, watched: rotating after a passkey must never start a ceremony of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...real, generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions) };
});

function fakeSql(queue: unknown[][]) {
  let i = 0;
  const fn = async () => {
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return fn as unknown as Parameters<typeof rotateApiKeyAfterPasskey>[1];
}

/** A `sql` tag that answers queries from `queue` in turn and records each statement's text. */
function recordingSql(queue: unknown[][]) {
  const statements: string[] = [];
  let i = 0;
  const fn = async (strings: TemplateStringsArray) => {
    statements.push(strings.join('?').replace(/\s+/g, ' ').trim());
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return { sql: fn as Parameters<typeof rotateApiKeyAfterPasskey>[1], statements };
}

/** A call's outcome: its answer (the old key's end time as "a date"), or the code it refused with. */
async function settle<T>(p: Promise<T>): Promise<{ value: unknown } | { code: unknown }> {
  try {
    const value = await p;
    return { value: { ...value, endsAt: (value as { endsAt?: unknown }).endsAt instanceof Date } };
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
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, created, revoked };
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
const oldRow = {
  id: 'old',
  name: 'desk',
  scopes: ['identity:read'],
  domain_whitelist: [],
  expires_at: null,
  mode: 'live',
  ip_allowlist: [],
  account_id: null,
};
const rotateInput = { userId: A, keyId: 'old', grantorScopes: ['identity:read'] as const };

describe('remainingPasskeyRotates — unenroll first of two', () => {
  it('remaining verified cred rotates; no invented challenge', async () => {
    expect(() => remainingPasskeyRotates([remaining])).not.toThrow();
    expect(() => requireVerifiedPasskey([remaining])).not.toThrow();
    const { minter, created, revoked } = makeMinter();
    await expect(
      rotateApiKeyAfterRemainingPasskey(minter, fakeSql([[{ webauthn_creds: [remaining] }], [oldRow]]), rotateInput),
    ).resolves.toEqual({
      id: 'k1',
      key: 'ifk_live_secret',
      prefix: 'ifk_live',
      mode: 'live',
      revokedKeyId: 'old',
      // No overlap: the old key ends now.
      endsAt: expect.any(Date),
      signingSecret: null,
    });
    await expect(
      rotateApiKeyAfterPasskey(minter, fakeSql([[{ webauthn_creds: [remaining] }], [oldRow]]), rotateInput),
    ).resolves.toMatchObject({ id: 'k1', revokedKeyId: 'old' });
    expect(created).toHaveLength(2);
    expect(revoked).toEqual(['old', 'old']);
  });

  it('remaining cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not rotate', async () => {
    try {
      remainingPasskeyRotates([remainingUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const { minter, created, revoked } = makeMinter();
    await expect(
      rotateApiKeyAfterRemainingPasskey(minter, fakeSql([[{ webauthn_creds: [remainingUnverified] }]]), rotateInput),
    ).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('empty remaining creds is auth.passkey_missing and does not rotate', async () => {
    try {
      remainingPasskeyRotates([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, created, revoked } = makeMinter();
    await expect(rotateApiKeyAfterRemainingPasskey(minter, fakeSql([[{ webauthn_creds: [] }]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('rotates and refuses exactly as rotateApiKeyAfterPasskey does; no invented challenge', async () => {
    for (const creds of [[remaining], [remainingUnverified], []]) {
      const own = makeMinter();
      const ownSql = recordingSql([[{ webauthn_creds: creds }], [oldRow]]);
      const ownOut = await settle(rotateApiKeyAfterRemainingPasskey(own.minter, ownSql.sql, rotateInput));
      const base = makeMinter();
      const baseSql = recordingSql([[{ webauthn_creds: creds }], [oldRow]]);
      const baseOut = await settle(rotateApiKeyAfterPasskey(base.minter, baseSql.sql, rotateInput));
      expect(ownOut).toEqual(baseOut);
      expect([own.created, own.revoked]).toEqual([base.created, base.revoked]);
      expect(ownSql.statements).toEqual(baseSql.statements);
      // The gate is requireVerifiedPasskey's on the stored passkeys: its refusal, or a rotated key.
      const gate = refusalOf(() => requireVerifiedPasskey(creds));
      if (gate) expect(ownOut).toEqual({ code: gate });
      else expect(ownOut).toMatchObject({ value: { id: 'k1', revokedKeyId: 'old' } });
      expect(ownSql.statements.filter((s) => /INSERT\s+(INTO\s+)?challenges/i.test(s))).toEqual([]);
    }
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });
});
