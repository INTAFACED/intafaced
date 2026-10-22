/**
 * Factor status and the Security checklist against Postgres (I-signin-sessions-14).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { checklistFor, factorStatus } from './factor-status.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));

const none = { platform: 0, cross_device: 0, security_key: 0, unknown: 0 };

describe('Security checklist', () => {
  it('a password-only account has its second step, passkey, authenticator and recovery codes all pending', () => {
    const list = checklistFor({
      password: true,
      authenticator: { on: false, label: null },
      passkeys: { count: 0, kinds: none },
      recoveryCodesLeft: 0,
      secondStepRequired: { floor: ['money_out', 'security_change'], policy: null },
    });
    expect(list).toEqual([
      { key: 'second_factor', done: false },
      { key: 'passkey', done: false },
      { key: 'authenticator', done: false },
      { key: 'recovery_codes', done: false },
    ]);
  });

  it('a passkey alone is a second step; recovery codes count only with an authenticator on', () => {
    const list = checklistFor({
      password: true,
      authenticator: { on: false, label: null },
      passkeys: { count: 1, kinds: { ...none, platform: 1 } },
      recoveryCodesLeft: 3,
      secondStepRequired: { floor: ['money_out', 'security_change'], policy: null },
    });
    expect(list.filter((item) => item.done).map((item) => item.key)).toEqual(['second_factor', 'passkey']);
  });
});

const available = await postgresAvailable(url);
if (!available) {
  describe.skip('factor status (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  afterAll(async () => {
    await db.drop();
  });

  async function seed(opts: { totp?: boolean; label?: string; creds?: unknown[]; recovery?: unknown[] } = {}) {
    const id = randomUUID();
    const handle = `f${id.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_label, webauthn_creds, recovery_code_hashes)
      VALUES (${id}, ${handle}, ${`${handle}@example.com`}, 'x', ${opts.totp ? 'sealed' : null}, ${opts.label ?? null},
        ${db.sql.json((opts.creds ?? []) as never)}, ${db.sql.json((opts.recovery ?? []) as never)})`;
    return id;
  }

  describe('factor status', () => {
    it('given a password only, nothing else is on, and the floor alone is required', async () => {
      const status = await factorStatus(db.sql, await seed());
      expect(status).toMatchObject({
        password: true,
        authenticator: { on: false, label: null },
        passkeys: { count: 0, kinds: none },
        recoveryCodesLeft: 0,
        secondStepRequired: { floor: ['money_out', 'security_change'], policy: null },
      });
      expect(status.checklist.every((item) => !item.done)).toBe(true);
    });

    it('given passkeys and an authenticator, both are listed with kinds, label and codes left', async () => {
      const id = await seed({
        totp: true,
        label: 'Phone app',
        recovery: ['h1', 'h2', 7],
        creds: [
          { credentialId: 'a', kind: 'platform' },
          { credentialId: 'b', transports: ['usb'] },
          { credentialId: 'c', transports: ['hybrid', 'internal'] },
          { credentialId: 'd', kind: 'hybrid', transports: ['usb'] },
          { nope: true },
        ],
      });
      const status = await factorStatus(db.sql, id);
      expect(status.authenticator).toEqual({ on: true, label: 'Phone app' });
      expect(status.passkeys).toEqual({ count: 4, kinds: { platform: 1, cross_device: 1, security_key: 2, unknown: 0 } });
      expect(status.recoveryCodesLeft).toBe(2);
      expect(status.checklist.every((item) => item.done)).toBe(true);
    });

    it('recovery codes left over from a removed authenticator count as none', async () => {
      const status = await factorStatus(db.sql, await seed({ recovery: ['h1'] }));
      expect(status.recoveryCodesLeft).toBe(0);
    });

    it('an unknown account is not found', async () => {
      await expect(factorStatus(db.sql, randomUUID())).rejects.toMatchObject({ code: 'auth.not_found' });
    });
  });
}
