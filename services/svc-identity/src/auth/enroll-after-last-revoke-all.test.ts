import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';
import { newlyEnrolledPasskeyRevokesAllKeys, revokeAllApiKeysAfterNewlyEnrolledPasskey } from './enroll-after-last-revoke-all.js';

// The WebAuthn library, watched: revoking after a passkey must never start a ceremony of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...real, generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions) };
});

/** The code a synchronous check refuses with, or null when it passes. */
function refusalOf(check: () => void): unknown {
  try {
    check();
    return null;
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
}

type KeyRow = { id: string; user_id: string; revoked: boolean };

function fakeSql(creds: unknown[] | null, keys: KeyRow[]) {
  let keyWrites = 0;
  const statements: string[] = [];
  const writes: unknown[][] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (creds === null) return [];
      return [{ webauthn_creds: creds }];
    }
    if (text.includes('update api_keys')) {
      keyWrites += 1;
      writes.push(values);
      const named = values[0];
      const out: Array<{ id: string }> = [];
      for (const k of keys) {
        if (k.user_id === named && k.revoked === false) {
          k.revoked = true;
          out.push({ id: k.id });
        }
      }
      return out;
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  const sql = Object.assign(fn, { keys, statements, writes }) as Parameters<typeof revokeAllApiKeysAfterNewlyEnrolledPasskey>[0] & {
    keyWrites: number;
    keys: KeyRow[];
    statements: string[];
    writes: unknown[][];
  };
  Object.defineProperty(sql, 'keyWrites', { get: () => keyWrites });
  return sql;
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

function liveKeys(): KeyRow[] {
  return [
    { id: 'live-1', user_id: A, revoked: false },
    { id: 'live-2', user_id: A, revoked: false },
    { id: 'dead', user_id: A, revoked: true },
  ];
}

describe('newlyEnrolledPasskeyRevokesAllKeys — enroll after last unenroll', () => {
  it('newly enrolled verified cred revokes every live key; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyRevokesAllKeys([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const sql = fakeSql([enrolledAgain], liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).resolves.toEqual({
      userId: A,
      revoked: 2,
    });
    expect(sql.keyWrites).toBe(1);
    expect(sql.keys.map((k) => k.revoked)).toEqual([true, true, true]);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesAllKeys([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const sql = fakeSql([enrolledUnverified], liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('empty after last unenroll is auth.passkey_missing and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesAllKeys([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const sql = fakeSql([], liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('missing user is auth.not_found and does not revoke', async () => {
    const sql = fakeSql(null, liveKeys());
    await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.keyWrites).toBe(0);
    expect(sql.keys.map((k) => k.revoked)).toEqual([false, false, true]);
  });

  it('revokes exactly as revokeAllApiKeys does, after one passkey read; no invented challenge; not one-key revoke', async () => {
    const own = fakeSql([enrolledAgain], liveKeys());
    const ownOut = await revokeAllApiKeysAfterNewlyEnrolledPasskey(own, { userId: A });
    const base = fakeSql([enrolledAgain], liveKeys());
    const baseOut = await revokeAllApiKeys(base, A, A);
    expect(ownOut).toEqual(baseOut);
    expect(own.keys).toEqual(base.keys);
    // One read of the stored passkeys (the gate), then revokeAllApiKeys's own statements and nothing else.
    expect(own.statements[0]).toMatch(/^select webauthn_creds from users where id = \? limit 1$/);
    expect(own.statements.slice(1)).toEqual(base.statements);
    // The update names the user alone, never one key id.
    expect(own.writes).toEqual([[A]]);
    expect(own.statements.filter((s) => /insert\s+(into\s+)?challenges/.test(s))).toEqual([]);
    // Refused at the gate, revokeAllApiKeys never runs: only the passkey read.
    for (const creds of [[enrolledUnverified], []]) {
      const refused = fakeSql(creds, liveKeys());
      await expect(revokeAllApiKeysAfterNewlyEnrolledPasskey(refused, { userId: A })).rejects.toMatchObject({
        code: refusalOf(() => requireVerifiedPasskey(creds)),
      });
      expect(refused.statements).toHaveLength(1);
    }
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });
});
