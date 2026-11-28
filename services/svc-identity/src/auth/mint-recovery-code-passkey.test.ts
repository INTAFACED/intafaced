import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import * as passwords from './passwords.js';
import * as totp from './totp.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { mintRecoveryCodeAfterPasskey, verifiedPasskeyMintsRecoveryCode } from './mint-recovery-code-passkey.js';

const { hashToken } = passwords;

// The shared generator and hash, and the WebAuthn library, watched (each still runs for real).
vi.mock('./totp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./totp.js')>();
  return { ...real, generateRecoveryCodes: vi.fn(real.generateRecoveryCodes) };
});
vi.mock('./passwords.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./passwords.js')>();
  return { ...real, hashToken: vi.fn(real.hashToken) };
});
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

function fakeSql(row: { webauthn_creds: unknown; recovery_code_hashes?: unknown } | null) {
  const updates: unknown[] = [];
  const statements: string[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (!row) return [];
      return [row];
    }
    if (text.includes('update') && text.includes('recovery_code_hashes')) {
      updates.push(values);
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  return Object.assign(fn, {
    json: (value: unknown) => value,
    get updates() {
      return updates;
    },
    statements,
  }) as Parameters<typeof mintRecoveryCodeAfterPasskey>[0] & { updates: unknown[]; statements: string[] };
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const enrolled = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' };
const verifiedAt = '2026-08-25T00:00:00.000Z';
const verified = { ...enrolled, lastVerifiedAt: verifiedAt };
const codeShape = /^[0-9A-F]{5}-[0-9A-F]{5}$/;

describe('verifiedPasskeyMintsRecoveryCode', () => {
  it('refuses empty creds as passkey_missing', () => {
    try {
      verifiedPasskeyMintsRecoveryCode([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    expect(() => requireVerifiedPasskey([])).toThrow(/No enrolled passkey/);
  });

  it('refuses enrolled creds without lastVerifiedAt as verify unavailable', () => {
    try {
      verifiedPasskeyMintsRecoveryCode([enrolled]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
  });

  it('allows a cred with lastVerifiedAt and does not invent a challenge', () => {
    expect(() => verifiedPasskeyMintsRecoveryCode([verified])).not.toThrow();
    expect(() => requireVerifiedPasskey([verified])).not.toThrow();
  });
});

describe('mintRecoveryCodeAfterPasskey', () => {
  it('refuses a missing passkey and does not mint', async () => {
    const sql = fakeSql({ webauthn_creds: [] });
    await expect(mintRecoveryCodeAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.updates).toEqual([]);
  });

  it('refuses creds without lastVerifiedAt and does not mint a code or a challenge', async () => {
    const sql = fakeSql({ webauthn_creds: [enrolled], recovery_code_hashes: [] });
    await expect(mintRecoveryCodeAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.updates).toEqual([]);
  });

  it('mints one recovery code after lastVerifiedAt; stores the hash, not the plaintext', async () => {
    const sql = fakeSql({ webauthn_creds: [verified], recovery_code_hashes: [] });
    const minted = await mintRecoveryCodeAfterPasskey(sql, { userId: A });
    expect(minted.code).toMatch(codeShape);
    expect(sql.updates).toHaveLength(1);
    const written = sql.updates[0] as unknown[];
    expect(written).toContainEqual([hashToken(minted.code)]);
    expect(written.some((value) => value === minted.code)).toBe(false);
  });

  it('treats a missing user as not found', async () => {
    const sql = fakeSql(null);
    await expect(mintRecoveryCodeAfterPasskey(sql, { userId: A })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(sql.updates).toEqual([]);
  });

  it('mints through generateRecoveryCodes and stores hashToken of it beside the old hashes; no invented challenge', async () => {
    vi.mocked(totp.generateRecoveryCodes).mockClear();
    vi.mocked(passwords.hashToken).mockClear();
    const sql = fakeSql({ webauthn_creds: [verified], recovery_code_hashes: ['old-hash'] });
    const minted = await mintRecoveryCodeAfterPasskey(sql, { userId: A });
    // One code from the shared generator, and the code handed back is the one it made.
    expect(vi.mocked(totp.generateRecoveryCodes).mock.calls).toEqual([[1]]);
    expect(vi.mocked(totp.generateRecoveryCodes).mock.results[0]?.value).toEqual([minted.code]);
    // The stored hash is the shared hashToken's, appended to the hashes already held.
    expect(vi.mocked(passwords.hashToken).mock.calls).toEqual([[minted.code]]);
    expect(sql.updates[0]).toEqual([['old-hash', hashToken(minted.code)], A]);
    // Its statements are the gate's read and the one update: no challenge is written, no ceremony started.
    expect(sql.statements).toHaveLength(2);
    expect(sql.statements.filter((s) => /insert\s+(into\s+)?challenges/.test(s))).toEqual([]);
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
    // Refused at requireVerifiedPasskey's gate, nothing is generated.
    vi.mocked(totp.generateRecoveryCodes).mockClear();
    for (const creds of [[enrolled], []]) {
      await expect(mintRecoveryCodeAfterPasskey(fakeSql({ webauthn_creds: creds }), { userId: A })).rejects.toMatchObject({
        code: refusalOf(() => requireVerifiedPasskey(creds)),
      });
    }
    expect(totp.generateRecoveryCodes).not.toHaveBeenCalled();
  });
});
