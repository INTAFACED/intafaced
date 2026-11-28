import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';
import { PROD_TOTP_KEY_REQUIRED, SIGNING_ENC_KEY_REQUIRED } from '../auth/totp-crypto.js';
import { BOOT_TIMEOUT_MS, bootIdentity, contextWith, lastBootTrace, type SqlCall } from '../boot.testkit.js';
import { KYC_VAULT_UNWIRED } from './boot-vault.js';

const here = dirname(fileURLToPath(import.meta.url));
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const KEY = () => randomBytes(32).toString('base64');
/** The settings a hosted start refuses to run without, other than the two keys under test. */
const HOSTED = { INTERNAL_SERVICE_BODY_BIND: 'require', WEBAUTHN_ENABLED: 'off' };

/** The vault's database: one stored document's metadata for USER. */
const oneDocument = ({ text, values }: SqlCall) =>
  /FROM kyc_documents/.test(text) && values.includes(USER)
    ? [
        {
          id: DOC,
          user_id: USER,
          content_type: 'image/png',
          byte_length: 4,
          stored_by: OPERATOR,
          created_at: new Date('2026-11-01T00:00:00Z'),
        },
      ]
    : undefined;

/** The booted service with this KYC key, asked as a compliance operator: health, the list, a read, and the vault's queries. */
async function vaultDoors(key: string | undefined) {
  const boot = await bootIdentity({ IDENTITY_KYC_DOC_KEY: key }, oneDocument);
  const api = boot.appRouter.createCaller(await contextWith(['admin:compliance'], { userId: OPERATOR, mfa: true }));
  const health = (await boot.app.inject({ method: 'GET', url: '/health' })).statusCode;
  const listed = await api.kyc.listDocuments({ userId: USER, limit: 10 }).catch((e: unknown) => e);
  const read = await api.kyc.getDocument({ documentId: DOC }).catch((e: unknown) => e);
  const vaultQueries = boot.queries.filter((q) => /kyc_documents/.test(q.text));
  return { health, listed, read, vaultQueries };
}

const messageOf = (e: unknown) => String((e as Error | undefined)?.message ?? '');

describe('production index boots KYC vault from IDENTITY_KYC_DOC_KEY only', () => {
  it(
    'with the env key set, the vault the doors reach is the store opened from that key',
    async () => {
      const keyed = await vaultDoors(KEY());
      expect(keyed.health).toBe(200);
      // The list is the store's answer for this user, not a refusal: the vault is in the router (a silent missing store
      // would refuse unwired here).
      expect(Array.isArray(keyed.listed)).toBe(true);
      expect((keyed.listed as Array<{ id: string }>).map((d) => d.id)).toEqual([DOC]);
      expect(keyed.vaultQueries.some((q) => q.values.includes(USER))).toBe(true);
      // A read goes on to its approval step instead of refusing unwired.
      expect(messageOf(keyed.read)).not.toContain(KYC_VAULT_UNWIRED);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'without the key the service still serves and every vault door refuses named: no key is invented',
    async () => {
      // Unset and blank, each a fresh start: an invented (random) key would open the vault in both.
      for (const key of [undefined, '']) {
        const unkeyed = await vaultDoors(key);
        expect(unkeyed.health, `key ${JSON.stringify(key)}`).toBe(200);
        expect(unkeyed.listed).toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(messageOf(unkeyed.listed)).toContain(KYC_VAULT_UNWIRED);
        expect(messageOf(unkeyed.read)).toContain(KYC_VAULT_UNWIRED);
        // The vault's table is never touched without a key.
        expect(unkeyed.vaultQueries).toEqual([]);
      }
      // The process does not stop for a missing KYC key: the start reached listen.
      expect(lastBootTrace()?.listens).toBe(1);
    },
    BOOT_TIMEOUT_MS,
  );
});

describe('prod boot refuses a missing IDENTITY_TOTP_SECRET_KEY', () => {
  it(
    'a prod start without the TOTP key, or without the signing key, stops before it opens the database or a server',
    async () => {
      await expect(
        bootIdentity({ ...HOSTED, APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: undefined, API_KEY_SIGNING_ENC_KEY: KEY() }),
      ).rejects.toThrow(PROD_TOTP_KEY_REQUIRED);
      const noTotp = lastBootTrace();
      expect(noTotp?.connections).toBe(0);
      expect(noTotp?.servers).toBe(0);
      expect(noTotp?.listens).toBe(0);
      // A key that is not 32 bytes is no key.
      await expect(
        bootIdentity({
          ...HOSTED,
          APP_ENV: 'prod',
          IDENTITY_TOTP_SECRET_KEY: randomBytes(16).toString('base64'),
          API_KEY_SIGNING_ENC_KEY: KEY(),
        }),
      ).rejects.toThrow(PROD_TOTP_KEY_REQUIRED);

      await expect(
        bootIdentity({ ...HOSTED, APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: KEY(), API_KEY_SIGNING_ENC_KEY: undefined }),
      ).rejects.toThrow(SIGNING_ENC_KEY_REQUIRED);
      expect(lastBootTrace()?.listens).toBe(0);
      // The signing key is parsed, not only present.
      await expect(
        bootIdentity({ ...HOSTED, APP_ENV: 'prod', IDENTITY_TOTP_SECRET_KEY: KEY(), API_KEY_SIGNING_ENC_KEY: 'not-a-key' }),
      ).rejects.toThrow(SIGNING_ENC_KEY_REQUIRED);
      await expect(bootIdentity({ ...HOSTED, APP_ENV: 'staging', API_KEY_SIGNING_ENC_KEY: undefined })).rejects.toThrow(
        SIGNING_ENC_KEY_REQUIRED,
      );
      expect(lastBootTrace()?.connections).toBe(0);

      // The test stack needs neither, and serves.
      const stack = await bootIdentity({ IDENTITY_TOTP_SECRET_KEY: undefined, API_KEY_SIGNING_ENC_KEY: undefined });
      expect(lastBootTrace()?.listens).toBe(1);
      expect((await stack.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
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
