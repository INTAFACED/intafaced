import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';
import { PROD_TOTP_KEY_REQUIRED, SIGNING_ENC_KEY_REQUIRED } from '../auth/totp-crypto.js';
import { BOOT_TIMEOUT_MS, bootIdentity, contextWith } from '../boot.testkit.js';
import { KYC_VAULT_UNWIRED } from './boot-vault.js';

const here = dirname(fileURLToPath(import.meta.url));
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '22222222-2222-4222-8222-222222222222';
const KEY = () => randomBytes(32).toString('base64');
/** The settings a hosted start refuses to run without, other than the two keys under test. */
const HOSTED = { INTERNAL_SERVICE_BODY_BIND: 'require', WEBAUTHN_ENABLED: 'off' };

/** kyc.listDocuments as a compliance operator on the booted service: the rows, or the refusal. */
async function listAsCompliance(env: Record<string, string | undefined>) {
  const boot = await bootIdentity(env);
  const api = boot.appRouter.createCaller(await contextWith(['admin:compliance'], { userId: OPERATOR, mfa: true }));
  const health = await boot.app.inject({ method: 'GET', url: '/health' });
  return { health: health.statusCode, listed: await api.kyc.listDocuments({ userId: USER, limit: 10 }).catch((e: unknown) => e) };
}

describe('production index boots KYC vault from IDENTITY_KYC_DOC_KEY only', () => {
  it(
    'the booted service opens the vault only from the env key and still serves without it',
    async () => {
      // Key set: the vault doors reach the store (no rows here), not the unwired refusal.
      const keyed = await listAsCompliance({ IDENTITY_KYC_DOC_KEY: KEY() });
      expect(keyed.health).toBe(200);
      expect(String((keyed.listed as Error).message ?? '')).not.toContain(KYC_VAULT_UNWIRED);
      // Key unset or blank: the service still serves, and the vault doors refuse named — no invented key.
      for (const IDENTITY_KYC_DOC_KEY of [undefined, '']) {
        const unkeyed = await listAsCompliance({ IDENTITY_KYC_DOC_KEY });
        expect(unkeyed.health).toBe(200);
        expect(unkeyed.listed).toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(String((unkeyed.listed as Error).message)).toContain(KYC_VAULT_UNWIRED);
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

describe('prod boot refuses a missing IDENTITY_TOTP_SECRET_KEY', () => {
  it(
    'a prod start without the TOTP key, or without the signing key, stops before it listens',
    async () => {
      await expect(
        bootIdentity({ ...HOSTED, APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: undefined, API_KEY_SIGNING_ENC_KEY: KEY() }),
      ).rejects.toThrow(PROD_TOTP_KEY_REQUIRED);
      await expect(
        bootIdentity({ ...HOSTED, APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: KEY(), API_KEY_SIGNING_ENC_KEY: undefined }),
      ).rejects.toThrow(SIGNING_ENC_KEY_REQUIRED);
      await expect(bootIdentity({ ...HOSTED, APP_ENV: 'staging', API_KEY_SIGNING_ENC_KEY: undefined })).rejects.toThrow(
        SIGNING_ENC_KEY_REQUIRED,
      );
      // The test stack needs neither.
      await expect(bootIdentity({ IDENTITY_TOTP_SECRET_KEY: undefined, API_KEY_SIGNING_ENC_KEY: undefined })).resolves.toBeDefined();
    },
    BOOT_TIMEOUT_MS,
  );
});

// Host IDENTITY_KYC_DOC_KEY must reach the identity container or the #1806 vault stays dark.
describe('compose passes IDENTITY_KYC_DOC_KEY through to svc-identity', () => {
  const composeSrc = readFileSync(join(here, '../../../../docker-compose.apps.yml'), 'utf8');
  const identityBlock = composeServiceBlock(composeSrc, 'svc-identity');

  it('forwards the host key — no compose default, no invented key, blank stays optional', () => {
    expect(identityBlock.length).toBeGreaterThan(0);
    expect(identityBlock).toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:-\}/);
    // `:?` would refuse `platform:up` when the host has no key. Vault is optional.
    expect(identityBlock).not.toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:\?/);
    // No literal key material in compose.
    expect(identityBlock).not.toMatch(/IDENTITY_KYC_DOC_KEY:\s*['"]?[A-Za-z0-9+/=]{32,}/);
  });
});

// Host IDENTITY_TOTP_SECRET_KEY must reach the identity container or TOTP enrol stays refuse-closed.
describe('compose passes IDENTITY_TOTP_SECRET_KEY through to svc-identity', () => {
  const composeSrc = readFileSync(join(here, '../../../../docker-compose.apps.yml'), 'utf8');
  const identityBlock = composeServiceBlock(composeSrc, 'svc-identity');

  it('forwards the host key — no compose default, no invented key, blank stays optional', () => {
    expect(identityBlock.length).toBeGreaterThan(0);
    expect(identityBlock).toMatch(/IDENTITY_TOTP_SECRET_KEY:\s*\$\{IDENTITY_TOTP_SECRET_KEY:-\}/);
    // `:?` would refuse `platform:up` when the host has no key. Enrol is optional until set.
    expect(identityBlock).not.toMatch(/IDENTITY_TOTP_SECRET_KEY:\s*\$\{IDENTITY_TOTP_SECRET_KEY:\?/);
    // No literal key material in compose.
    expect(identityBlock).not.toMatch(/IDENTITY_TOTP_SECRET_KEY:\s*['"]?[A-Za-z0-9+/=]{32,}/);
  });
});
