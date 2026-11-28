import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import * as totp from './totp.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { revokeAllRecoveryCodesAfterPasskey, verifiedPasskeyRevokesAllRecoveryCodes } from './revoke-recovery-codes-passkey.js';

// The recovery-code generator and the WebAuthn library, watched (each still runs for real if called).
vi.mock('./totp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./totp.js')>();
  return { ...real, generateRecoveryCodes: vi.fn(real.generateRecoveryCodes) };
});
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...real,
    generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions),
    generateRegistrationOptions: vi.fn(real.generateRegistrationOptions),
  };
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

function fakeSql(row: { webauthn_creds: unknown; recovery_code_hashes?: unknown } | null) {
  const bag = { updates: [] as unknown[], statements: [] as string[] };
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    bag.statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update') && text.includes('recovery_code_hashes')) {
      bag.updates.push(values);
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (value: unknown) => value,
    bag,
  }) as Parameters<typeof revokeAllRecoveryCodesAfterPasskey>[0] & {
    bag: { updates: unknown[]; statements: string[] };
  };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const verifiedAt = '2026-08-25T00:00:00.000Z';
const verified = { ...enrolled, lastVerifiedAt: verifiedAt };
const hashes = ['hash-1', 'hash-2'];

describe('verifiedPasskeyRevokesAllRecoveryCodes', () => {
  it('refuses empty creds as passkey_missing', () => {
    try {
      verifiedPasskeyRevokesAllRecoveryCodes([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    expect(() => requireVerifiedPasskey([])).toThrow(/No enrolled passkey/);
  });

  it('refuses enrolled creds without lastVerifiedAt as verify unavailable', () => {
    try {
      verifiedPasskeyRevokesAllRecoveryCodes([enrolled]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
  });

  it('allows a cred with lastVerifiedAt and does not invent a challenge', () => {
    expect(() => verifiedPasskeyRevokesAllRecoveryCodes([verified])).not.toThrow();
    expect(() => requireVerifiedPasskey([verified])).not.toThrow();
  });
});

describe('revokeAllRecoveryCodesAfterPasskey', () => {
  it('refuses a missing passkey and does not revoke', async () => {
    const sql = fakeSql({ webauthn_creds: [], recovery_code_hashes: hashes });
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('refuses creds without lastVerifiedAt and does not revoke', async () => {
    const sql = fakeSql({ webauthn_creds: [enrolled], recovery_code_hashes: hashes });
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('clears every recovery hash after lastVerifiedAt', async () => {
    const sql = fakeSql({ webauthn_creds: [verified], recovery_code_hashes: hashes });
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).resolves.toEqual({ revoked: 2 });
    expect(sql.bag.updates).toHaveLength(1);
    const written = sql.bag.updates[0] as unknown[];
    expect(written).toContainEqual([]);
    expect(written.some((value) => Array.isArray(value) && value.includes('hash-1'))).toBe(false);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null);
    await expect(revokeAllRecoveryCodesAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.bag.updates).toEqual([]);
  });

  it('gates on requireVerifiedPasskey; mints no replacement code and starts no ceremony or challenge', async () => {
    for (const creds of [[verified], [enrolled], []]) {
      const sql = fakeSql({ webauthn_creds: creds, recovery_code_hashes: hashes });
      const gate = refusalOf(() => requireVerifiedPasskey(creds));
      const out = revokeAllRecoveryCodesAfterPasskey(sql, { userId: A });
      if (gate) {
        await expect(out).rejects.toMatchObject({ code: gate });
        expect(sql.bag.statements).toHaveLength(1);
      } else {
        await expect(out).resolves.toEqual({ revoked: 2 });
        // The gate's read and the one update that empties the list: nothing else is written.
        expect(sql.bag.statements).toHaveLength(2);
        expect(sql.bag.updates).toEqual([[[], A]]);
      }
      expect(sql.bag.statements.filter((s) => /insert\s+(into\s+)?challenges/.test(s))).toEqual([]);
    }
    expect(totp.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
    expect(vi.mocked(webauthnLib.generateRegistrationOptions)).not.toHaveBeenCalled();
  });
});
