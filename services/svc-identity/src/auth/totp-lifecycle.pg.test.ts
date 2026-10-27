/**
 * Authenticator app lifecycle against Postgres (I-signin-sessions-11): rename, disable, replace, lockout.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { hashToken } from './passwords.js';
import { MemoryPendingTotpEnrolmentStore } from './pending-totp-store.js';
import { generateSecret, totp } from './totp.js';
import { encryptTotpSecret } from './totp-crypto.js';
import { normalizeTotpLabel, TotpLifecycle } from './totp-lifecycle.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));

describe('authenticator label', () => {
  it('trims, and refuses empty, 65 characters and control characters', () => {
    expect(normalizeTotpLabel('  Phone app ')).toBe('Phone app');
    for (const bad of ['', '  ', 'a'.repeat(65), 'tab\there']) expect(() => normalizeTotpLabel(bad)).toThrow(/totp_label_invalid/);
  });
});

const available = await postgresAvailable(url);
if (!available) {
  describe.skip('authenticator lifecycle (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  afterAll(async () => {
    await db.drop();
  });
  const key = randomBytes(32);
  const lifecycle = () => new TotpLifecycle({ sql: db.sql, key, pending: new MemoryPendingTotpEnrolmentStore() });

  async function seed(opts: { secret?: string; recovery?: string[]; status?: string } = {}) {
    const id = randomUUID();
    const handle = `t${id.replaceAll('-', '').slice(0, 16)}`;
    const secret = opts.secret ?? generateSecret();
    await db.sql`INSERT INTO users (id, handle, email, password_hash, status, totp_secret, totp_enrolled_at, recovery_code_hashes)
      VALUES (${id}, ${handle}, ${`${handle}@example.com`}, 'x', ${opts.status ?? 'active'}, ${encryptTotpSecret(key, secret)}, now(),
        ${db.sql.json((opts.recovery ?? []).map((c) => hashToken(c)) as never)})`;
    return { id, secret };
  }
  const row = async (id: string) =>
    (
      await db.sql<
        Array<Record<string, unknown>>
      >`SELECT totp_secret, totp_label, totp_last_step, recovery_code_hashes FROM users WHERE id = ${id}`
    )[0]!;
  const attempts = async (id: string) =>
    (await db.sql<Array<{ failures: number }>>`SELECT failures FROM auth_attempts WHERE user_id = ${id} AND kind = 'mfa'`)[0]?.failures ??
    0;

  describe('authenticator lifecycle', () => {
    it('status shows on, label, date and recovery codes left; rename is idempotent and clears with disable', async () => {
      const { id, secret } = await seed({ recovery: ['AAAA-1', 'BBBB-2'] });
      expect(await lifecycle().status(id)).toMatchObject({ enabled: true, label: null, recoveryCodesLeft: 2 });
      await lifecycle().rename(id, ' Work phone ');
      const again = await lifecycle().rename(id, 'Work phone');
      expect(again.label).toBe('Work phone');
      await lifecycle().disable(id, totp(secret));
      expect(await lifecycle().status(id)).toMatchObject({ enabled: false, label: null, recoveryCodesLeft: 0 });
      await expect(lifecycle().rename(id, 'x')).rejects.toMatchObject({ code: 'auth.not_found' });
    });

    it('disable with a right code turns it off, and twice answers ok', async () => {
      const { id, secret } = await seed();
      const first = await lifecycle().disable(id, totp(secret));
      expect(first).toEqual({ disabled: true, recoveryCodeSpent: false });
      expect((await row(id)).totp_secret).toBeNull();
      expect(await lifecycle().disable(id, '000000')).toEqual({ disabled: true, recoveryCodeSpent: false });
    });

    it('a wrong code changes nothing and counts on the MFA lockout; five wrong codes lock', async () => {
      const { id, secret } = await seed();
      for (let i = 0; i < 5; i++) await expect(lifecycle().disable(id, '000000')).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
      expect((await row(id)).totp_secret).not.toBeNull();
      expect(await attempts(id)).toBe(5);
      await expect(lifecycle().disable(id, totp(secret))).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      expect((await row(id)).totp_secret).not.toBeNull();
    });

    it('a recovery code disables, is spent, and the user is told', async () => {
      const { id } = await seed({ recovery: ['RECOV-ONE', 'RECOV-TWO'] });
      expect(await lifecycle().disable(id, 'RECOV-ONE')).toEqual({ disabled: true, recoveryCodeSpent: true });
      expect((await row(id)).recovery_code_hashes).toEqual([]);
    });

    it('a TOTP step already used cannot disable (no replay)', async () => {
      const { id, secret } = await seed();
      const code = totp(secret);
      await db.sql`UPDATE users SET totp_last_step = ${String(Math.floor(Date.now() / 30_000) + 5)} WHERE id = ${id}`;
      await expect(lifecycle().disable(id, code)).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
      expect((await row(id)).totp_secret).not.toBeNull();
    });

    it('refuses on a frozen account', async () => {
      const { id, secret } = await seed({ status: 'frozen' });
      await expect(lifecycle().disable(id, totp(secret))).rejects.toMatchObject({ code: 'auth.account_frozen' });
      await expect(lifecycle().rename(id, 'x')).rejects.toMatchObject({ code: 'auth.account_frozen' });
    });

    it('replace: a wrong new code leaves the old secret live and counts nothing', async () => {
      const { id, secret } = await seed();
      const l = lifecycle();
      const started = await l.replaceStart(id);
      await expect(l.replaceConfirm(id, { secret: started.secret, newCode: '000000', currentCode: totp(secret) })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
      const stored = await row(id);
      expect(stored.totp_secret).toBe(
        (await db.sql<Array<{ totp_secret: string }>>`SELECT totp_secret FROM users WHERE id = ${id}`)[0]!.totp_secret,
      );
      expect(await attempts(id)).toBe(0);
    });

    it('replace: a wrong old proof leaves the old secret and keeps the parked one usable', async () => {
      const { id, secret } = await seed();
      const l = lifecycle();
      const before = (await row(id)).totp_secret;
      const started = await l.replaceStart(id);
      const newCode = totp(started.secret);
      await expect(l.replaceConfirm(id, { secret: started.secret, newCode, currentCode: '000000' })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
      expect((await row(id)).totp_secret).toBe(before);
      expect(await attempts(id)).toBe(1);
      const done = await l.replaceConfirm(id, { secret: started.secret, newCode, currentCode: totp(secret) });
      expect(done).toMatchObject({ replaced: true, recoveryCodeSpent: false, sessionsEnded: 0 });
      expect((await row(id)).totp_secret).not.toBe(before);
      expect(await attempts(id)).toBe(0);
    });

    it('replace keeps the label, a recovery code can prove the old one, and new codes replace every old one', async () => {
      const { id } = await seed({ recovery: ['KEEP-1', 'USE-2'] });
      await lifecycle().rename(id, 'Old phone');
      const l = lifecycle();
      const started = await l.replaceStart(id);
      const done = await l.replaceConfirm(id, { secret: started.secret, newCode: totp(started.secret), currentCode: 'USE-2' });
      expect(done.recoveryCodeSpent).toBe(true);
      expect(done.recoveryCodes).toHaveLength(10);
      expect(new Set(done.recoveryCodes).size).toBe(10);
      const after = await row(id);
      expect(after.totp_label).toBe('Old phone');
      // Only hashes are stored, and the code left over from the old set no longer works.
      expect(after.recovery_code_hashes).toEqual(done.recoveryCodes.map((c) => hashToken(c)));
      expect(after.recovery_code_hashes).not.toContain(hashToken('KEEP-1'));
    });

    it('replace ends every other session and every other device trust in the same step, and keeps the one replacing', async () => {
      const { id, secret } = await seed();
      const [keep, phone, laptop] = [randomUUID(), randomUUID(), randomUUID()];
      const [newPhone, lostPhone] = [randomUUID(), randomUUID()];
      for (const device of [newPhone, lostPhone]) {
        await db.sql`INSERT INTO trusted_devices (id, user_id, device_key_hash, label, trusted_by)
          VALUES (${device}, ${id}, ${hashToken(device)}, 'TEST device', 'sign-in')`;
      }
      for (const [sid, device] of [
        [keep, newPhone],
        [phone, lostPhone],
        [laptop, null],
      ] as const) {
        await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, expires_at, trusted_device_id)
          VALUES (${sid}, ${id}, ${hashToken(sid)}, now() + interval '1 day', ${device})`;
      }
      const l = lifecycle();
      const started = await l.replaceStart(id);
      const done = await l.replaceConfirm(id, { secret: started.secret, newCode: totp(started.secret), currentCode: totp(secret) }, keep);
      expect(done.sessionsEnded).toBe(2);
      const live = await db.sql<Array<{ id: string }>>`SELECT id FROM sessions WHERE user_id = ${id} AND revoked = false`;
      expect(live.map((r) => r.id)).toEqual([keep]);
      // The lost phone asks for approval again at its next sign-in; the new phone stays trusted.
      const trusted = await db.sql<Array<{ id: string }>>`SELECT id FROM trusted_devices WHERE user_id = ${id} AND removed_at IS NULL`;
      expect(trusted.map((r) => r.id)).toEqual([newPhone]);
    });

    it('a refused replace ends no session, forgets no device and keeps the old recovery codes', async () => {
      const { id } = await seed({ recovery: ['KEEP-1'] });
      const [sid, device] = [randomUUID(), randomUUID()];
      await db.sql`INSERT INTO trusted_devices (id, user_id, device_key_hash, label, trusted_by)
        VALUES (${device}, ${id}, ${hashToken(device)}, 'TEST device', 'sign-in')`;
      await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, expires_at, trusted_device_id)
        VALUES (${sid}, ${id}, ${hashToken(sid)}, now() + interval '1 day', ${device})`;
      const l = lifecycle();
      const started = await l.replaceStart(id);
      await expect(
        l.replaceConfirm(id, { secret: started.secret, newCode: totp(started.secret), currentCode: '000000' }),
      ).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
      expect((await row(id)).recovery_code_hashes).toEqual([hashToken('KEEP-1')]);
      const [live] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${id} AND revoked = false`;
      expect(live!.n).toBe(1);
      const [trusted] = await db.sql<
        Array<{ n: number }>
      >`SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = ${id} AND removed_at IS NULL`;
      expect(trusted!.n).toBe(1);
    });

    it('replace start needs an enrolled authenticator, and a confirm with a made-up secret is refused', async () => {
      const { id, secret } = await seed();
      await db.sql`UPDATE users SET totp_secret = NULL WHERE id = ${id}`;
      await expect(lifecycle().replaceStart(id)).rejects.toMatchObject({ code: 'auth.mfa_not_enrolled' });
      await db.sql`UPDATE users SET totp_secret = ${encryptTotpSecret(key, secret)} WHERE id = ${id}`;
      const fake = generateSecret();
      await expect(lifecycle().replaceConfirm(id, { secret: fake, newCode: totp(fake), currentCode: totp(secret) })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
    });
  });
}
