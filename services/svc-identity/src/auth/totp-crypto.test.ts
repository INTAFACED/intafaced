import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertProdTotpKey,
  assertSigningEncKey,
  SIGNING_ENC_KEY_REQUIRED,
  decryptTotpSecret,
  encryptTotpSecret,
  isEncryptedTotpSecret,
  materializeTotpSecret,
  parseTotpSecretKey,
  TOTP_SECRET_ENC_PREFIX,
} from './totp-crypto.js';

describe('TOTP secret encrypt-at-rest', () => {
  it('round-trips a base32 secret', () => {
    const key = randomBytes(32);
    const plain = 'JBSWY3DPEHPK3PXP';
    const sealed = encryptTotpSecret(key, plain);
    expect(sealed.startsWith(TOTP_SECRET_ENC_PREFIX)).toBe(true);
    expect(sealed).not.toContain(plain);
    expect(decryptTotpSecret(key, sealed)).toBe(plain);
  });

  it('produces different ciphertext each seal (random nonce)', () => {
    const key = randomBytes(32);
    const plain = 'JBSWY3DPEHPK3PXP';
    expect(encryptTotpSecret(key, plain)).not.toBe(encryptTotpSecret(key, plain));
  });

  it('refuses a wrong key', () => {
    const sealed = encryptTotpSecret(randomBytes(32), 'JBSWY3DPEHPK3PXP');
    expect(() => decryptTotpSecret(randomBytes(32), sealed)).toThrow();
  });

  it('rejects garbage ciphertext', () => {
    const key = randomBytes(32);
    expect(() => decryptTotpSecret(key, `${TOTP_SECRET_ENC_PREFIX}not-valid-envelope!!!`)).toThrow();
    expect(() => decryptTotpSecret(key, `${TOTP_SECRET_ENC_PREFIX}${Buffer.from('short').toString('base64')}`)).toThrow(
      /too short|ciphertext/,
    );
    expect(() => decryptTotpSecret(key, 'plaintext-not-prefixed')).toThrow(/not enc:v1/);
  });

  it('parses base64 and hex keys; rejects weak', () => {
    const raw = randomBytes(32);
    expect(parseTotpSecretKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(parseTotpSecretKey(raw.toString('hex'))?.equals(raw)).toBe(true);
    expect(parseTotpSecretKey('')).toBeNull();
    expect(parseTotpSecretKey('short')).toBeNull();
    expect(parseTotpSecretKey(undefined)).toBeNull();
  });

  it('dual-read: legacy plaintext passes through; enc:v1 needs key', () => {
    const key = randomBytes(32);
    const plain = 'JBSWY3DPEHPK3PXP';
    expect(materializeTotpSecret(null, plain)).toBe(plain);
    expect(materializeTotpSecret(key, plain)).toBe(plain);

    const sealed = encryptTotpSecret(key, plain);
    expect(isEncryptedTotpSecret(sealed)).toBe(true);
    expect(materializeTotpSecret(key, sealed)).toBe(plain);
    expect(() => materializeTotpSecret(null, sealed)).toThrow(/IDENTITY_TOTP_SECRET_KEY/);
  });
});

describe('assertProdTotpKey — prod boot refuses a missing TOTP key', () => {
  const message = 'IDENTITY_TOTP_SECRET_KEY is required in prod (32-byte AES key as base64 or 64-char hex)';

  it('throws the existing message when APP_ENV=prod and the key is blank, missing, or weak', () => {
    expect(() => assertProdTotpKey({ APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: '' })).toThrow(message);
    expect(() => assertProdTotpKey({ APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: '   ' })).toThrow(message);
    expect(() => assertProdTotpKey({ APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: undefined })).toThrow(message);
    expect(() => assertProdTotpKey({ APP_ENV: 'prod' })).toThrow(message);
    expect(() => assertProdTotpKey({ APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: 'short' })).toThrow(message);
  });

  it('accepts a 32-byte key in prod (base64 or hex)', () => {
    const raw = randomBytes(32);
    expect(() => assertProdTotpKey({ APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: raw.toString('base64') })).not.toThrow();
    expect(() => assertProdTotpKey({ APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: raw.toString('hex') })).not.toThrow();
  });

  it('does not tighten non-prod — staging/dev/test may boot without the key', () => {
    for (const APP_ENV of ['dev', 'test', 'staging'] as const) {
      expect(() => assertProdTotpKey({ APP_ENV, IDENTITY_TOTP_SECRET_KEY: '' })).not.toThrow();
      expect(() => assertProdTotpKey({ APP_ENV, IDENTITY_TOTP_SECRET_KEY: undefined })).not.toThrow();
    }
  });
});

describe('assertSigningEncKey — prod and staging boot refuse a missing signing key', () => {
  it('throws when prod or staging has a blank, missing, or short key', () => {
    for (const APP_ENV of ['prod', 'staging'] as const) {
      expect(() => assertSigningEncKey({ APP_ENV, API_KEY_SIGNING_ENC_KEY: '' })).toThrow(SIGNING_ENC_KEY_REQUIRED);
      expect(() => assertSigningEncKey({ APP_ENV, API_KEY_SIGNING_ENC_KEY: undefined })).toThrow(SIGNING_ENC_KEY_REQUIRED);
      expect(() => assertSigningEncKey({ APP_ENV, API_KEY_SIGNING_ENC_KEY: 'short' })).toThrow(SIGNING_ENC_KEY_REQUIRED);
    }
  });

  it('accepts a 32-byte key in prod and staging, and lets dev and test boot without one', () => {
    const raw = randomBytes(32);
    for (const APP_ENV of ['prod', 'staging'] as const) {
      expect(() => assertSigningEncKey({ APP_ENV, API_KEY_SIGNING_ENC_KEY: raw.toString('base64') })).not.toThrow();
      expect(() => assertSigningEncKey({ APP_ENV, API_KEY_SIGNING_ENC_KEY: raw.toString('hex') })).not.toThrow();
    }
    for (const APP_ENV of ['dev', 'test'] as const) {
      expect(() => assertSigningEncKey({ APP_ENV, API_KEY_SIGNING_ENC_KEY: '' })).not.toThrow();
    }
  });
});
