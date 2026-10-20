import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService, type SessionTokens } from './auth-service.js';
import { publishedPasswordResetTtlSeconds } from './password-reset.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { createIdentityRouter } from '../router.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Signed-out password reset (S13, D-38). ACC-0017, ACC-0064, ACC-0172.
 *
 * A person who is signed out and controls the registered email can ask for a
 * one-time proof. The password hash stays as it is until that proof succeeds.
 * A wrong, expired, spent, or unknown-email proof changes nothing and the old
 * password still signs in. A correct proof changes the hash, ends the old
 * sessions, and does not mint a new session. Submitting the same proof again
 * does not rotate the hash a second time.
 *
 * The proof code is handed only to the mail port. 900 seconds is a fixture in
 * this file, not an owner-published lifetime.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase 2026';
const NEWER = 'another passphrase after reset';
const RESET_TTL_SECONDS = 900;
const POLICY = {
  maxAttempts: 3,
  requestMax: 5,
  requestWindowSeconds: 3600,
  subjectKey: 'test-only-flow-subject-key-0123456789abcdef',
  notifyUnknown: false,
} as const;
const T0 = Date.parse('2026-10-17T02:00:00.000Z');

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

const anonContext: Context = { principal: null, service: null, region: 'DE', requestId: 'req-reset' };

describe('publishedPasswordResetTtlSeconds', () => {
  it('accepts an owner-published lifetime and does not invent 900 when unset', () => {
    expect(publishedPasswordResetTtlSeconds(undefined)).toBeUndefined();
    expect(publishedPasswordResetTtlSeconds(0)).toBeUndefined();
    expect(publishedPasswordResetTtlSeconds(15.5)).toBeUndefined();
    expect(publishedPasswordResetTtlSeconds(86_401)).toBeUndefined();
    expect(publishedPasswordResetTtlSeconds(900)).toBe(900);
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('auth password reset (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const keyMaterial = randomBytes(32).toString('base64');
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, keyMaterial, undefined, undefined, 25);
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  auth.useLogger({ warn: (obj, msg) => void warnings.push({ obj, msg }) });
  const router = createIdentityRouter(auth, rank, { registrationOpen: true, actionApprovals: stubActionApprovals() });
  const anon = () => router.createCaller(anonContext);

  const sent: Array<{ email: string; code: string; expiresAt: Date }> = [];
  let failSend = false;
  let nowMs = T0;
  const mail = {
    async send(message: { email: string; code: string; expiresAt: Date }) {
      sent.push(message);
      if (failSend) throw new Error('mail transport lost the reply');
    },
  };

  let counter = 0;
  const unique = () => `pr${process.pid}x${++counter}`;

  const register = async () => {
    const handle = unique();
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: OLD });
    return { handle, email, ...session };
  };
  const hashOf = async (userId: string) =>
    (await db.sql<Array<{ password_hash: string }>>`SELECT password_hash FROM users WHERE id = ${userId}`)[0]!.password_hash;
  const liveSessions = async (userId: string) =>
    (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId} AND revoked = false`)[0]!.n;
  const refusal = async (promise: Promise<unknown>) => {
    const err = (await promise.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; message?: string; cause?: { code?: string } } | undefined;
    expect(err).toBeDefined();
    return { trpc: err!.code, code: err!.cause?.code, message: err!.message };
  };

  beforeEach(async () => {
    bus.reset();
    warnings.length = 0;
    sent.length = 0;
    failSend = false;
    nowMs = T0;
    auth.usePasswordResetMail(mail);
    auth.usePasswordResetTtl(RESET_TTL_SECONDS);
    // TEST fixtures, not owner settings.
    auth.usePasswordResetPolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    auth.usePasswordResetClock(() => new Date(nowMs));
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('auth password reset', () => {
    it('creates a one-time proof and leaves the hash and sessions alone until that proof succeeds', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const live = await liveSessions(user.userId);

      const accepted = await anon().auth.requestPasswordReset({ email: user.email });

      expect(accepted).toEqual({ accepted: true });
      expect(JSON.stringify(accepted)).not.toContain('accessToken');
      expect(await hashOf(user.userId)).toBe(before);
      expect(await liveSessions(user.userId)).toBe(live);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.email).toBe(user.email);
      expect(sent[0]!.code.length).toBeGreaterThan(20);
      const stored = await db.sql<Array<{ code_hash: string }>>`SELECT code_hash FROM auth_flows WHERE user_id = ${user.userId}`;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.code_hash).not.toBe(sent[0]!.code);
      expect(JSON.stringify(stored)).not.toContain(sent[0]!.code);
      // The relay claimed the job, so the code is no longer anywhere in the database.
      const outbox = await db.sql`SELECT * FROM mail_outbox`;
      expect(JSON.stringify(outbox)).not.toContain(sent[0]!.code);
      await expect(anon().auth.refresh({ refreshToken: user.refreshToken })).resolves.toMatchObject({ userId: user.userId });
    });

    it('leaves the hash unchanged when the code is wrong, and the old password still signs in', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      await anon().auth.requestPasswordReset({ email: user.email });

      const refused = await refusal(
        anon().auth.completePasswordReset({ email: user.email, code: 'not-the-code-that-was-sent', newPassword: NEW }),
      );

      expect(refused.code).toBe('auth.reset_proof_invalid');
      expect(await hashOf(user.userId)).toBe(before);
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).resolves.toMatchObject({ userId: user.userId });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).rejects.toMatchObject({
        cause: { code: 'auth.invalid_credentials' },
      });
    });

    it('changes the hash, ends the old sessions, and does not mint a session when the proof is correct', async () => {
      const user = await register();
      const second: SessionTokens = await auth.login({ identifier: user.email, password: OLD });
      expect(await liveSessions(user.userId)).toBe(2);
      const before = await hashOf(user.userId);
      await anon().auth.requestPasswordReset({ email: user.email });

      const done = await anon().auth.completePasswordReset({
        email: user.email,
        code: sent[0]!.code,
        newPassword: NEW,
      });

      expect(done).toEqual({ ok: true });
      expect(done).not.toHaveProperty('accessToken');
      expect(done).not.toHaveProperty('refreshToken');
      expect(await hashOf(user.userId)).not.toBe(before);
      expect(await liveSessions(user.userId)).toBe(0);
      await expect(anon().auth.refresh({ refreshToken: user.refreshToken })).rejects.toBeDefined();
      await expect(anon().auth.refresh({ refreshToken: second.refreshToken })).rejects.toBeDefined();
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).rejects.toMatchObject({
        cause: { code: 'auth.invalid_credentials' },
      });
      const signedIn = await anon().auth.login({ identifier: user.email, password: NEW });
      expect(signedIn.userId).toBe(user.userId);
      expect(await liveSessions(user.userId)).toBe(1);
      const audit = warnings.filter((w) => w.msg === 'auth.password_reset');
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toContain(NEW);
      expect(JSON.stringify(audit[0])).not.toContain(sent[0]!.code);
      expect(JSON.stringify(audit[0])).not.toContain(OLD);
    });

    it('does not rotate the hash a second time when the same proof or a later link is submitted again', async () => {
      const user = await register();
      await anon().auth.requestPasswordReset({ email: user.email });
      const first = sent[0]!.code;
      await anon().auth.requestPasswordReset({ email: user.email });
      const second = sent[1]!.code;
      expect(second).not.toBe(first);
      await anon().auth.completePasswordReset({ email: user.email, code: first, newPassword: NEW });
      const afterFirst = await hashOf(user.userId);

      const otherLink = await refusal(anon().auth.completePasswordReset({ email: user.email, code: second, newPassword: NEWER }));
      const again = await refusal(anon().auth.completePasswordReset({ email: user.email, code: first, newPassword: NEWER }));

      expect(otherLink.code).toBe('auth.reset_proof_invalid');
      expect(again.code).toBe('auth.reset_proof_invalid');
      expect(await hashOf(user.userId)).toBe(afterFirst);
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).resolves.toMatchObject({ userId: user.userId });
      await expect(anon().auth.login({ identifier: user.email, password: NEWER })).rejects.toMatchObject({
        cause: { code: 'auth.invalid_credentials' },
      });
    });

    it('answers an unknown email the same way as a real one, and a foreign code does not change the real hash', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const known = await anon().auth.requestPasswordReset({ email: user.email });
      const unknown = await anon().auth.requestPasswordReset({ email: 'missing@example.com' });

      expect(unknown).toEqual(known);
      expect(unknown).toEqual({ accepted: true });
      expect(sent.map((message) => message.email)).toEqual([user.email]);
      expect(await hashOf(user.userId)).toBe(before);

      const wrong = await refusal(
        anon().auth.completePasswordReset({ email: user.email, code: 'not-the-code-that-was-sent', newPassword: NEW }),
      );
      const missing = await refusal(
        anon().auth.completePasswordReset({ email: 'missing@example.com', code: sent[0]!.code, newPassword: NEW }),
      );

      expect(missing).toEqual(wrong);
      expect(missing.code).toBe('auth.reset_proof_invalid');
      expect(await hashOf(user.userId)).toBe(before);
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).resolves.toMatchObject({ userId: user.userId });
    });

    it('leaves the hash unchanged when the proof has expired, and the old password still signs in', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      await anon().auth.requestPasswordReset({ email: user.email });
      nowMs += RESET_TTL_SECONDS * 1000 + 1000;

      const refused = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW }));

      expect(refused.code).toBe('auth.reset_proof_invalid');
      expect(await hashOf(user.userId)).toBe(before);
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).resolves.toMatchObject({ userId: user.userId });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).rejects.toMatchObject({
        cause: { code: 'auth.invalid_credentials' },
      });
    });

    it('leaves the hash unchanged and mints no session when the mail reply is lost', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const live = await liveSessions(user.userId);
      failSend = true;

      const accepted = await anon().auth.requestPasswordReset({ email: user.email });

      expect(accepted).toEqual({ accepted: true });
      expect(accepted).not.toHaveProperty('accessToken');
      expect(await hashOf(user.userId)).toBe(before);
      expect(await liveSessions(user.userId)).toBe(live);
      await expect(anon().auth.refresh({ refreshToken: user.refreshToken })).resolves.toMatchObject({ userId: user.userId });
    });

    it('accepts a known and an unknown email the same way with no mail transport, and marks the jobs undeliverable', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      auth.usePasswordResetMail(undefined);

      const known = await anon().auth.requestPasswordReset({ email: user.email });
      const missing = await anon().auth.requestPasswordReset({ email: 'missing@example.com' });

      expect(known).toEqual(missing);
      expect(known).toEqual({ accepted: true });
      expect(sent).toHaveLength(0);
      const jobs = await db.sql<Array<{ status: string }>>`SELECT status FROM mail_outbox ORDER BY created_at`;
      expect(jobs.map((job) => job.status)).toEqual(['undeliverable', 'suppressed']);
      expect(await hashOf(user.userId)).toBe(before);
      await expect(anon().auth.passwordResetChannel()).resolves.toEqual({ emailDelivery: 'off' });
    });

    it('refuses a known email and an unknown email the same way when a published number is missing', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const unset: Array<Partial<Parameters<typeof auth.usePasswordResetPolicy>[0]>> = [
        { maxAttempts: undefined },
        { requestMax: undefined },
        { requestWindowSeconds: undefined },
        { subjectKey: undefined },
      ];
      for (const gap of unset) {
        auth.usePasswordResetPolicy({ ...POLICY, ...gap });
        const known = await refusal(anon().auth.requestPasswordReset({ email: user.email }));
        const missing = await refusal(anon().auth.requestPasswordReset({ email: 'missing@example.com' }));
        expect(known).toEqual(missing);
        expect(known.code).toBe('auth.reset_unwired');
      }

      auth.usePasswordResetPolicy(POLICY);
      auth.usePasswordResetTtl(undefined);
      const noTtl = await refusal(anon().auth.requestPasswordReset({ email: user.email }));
      const noTtlMissing = await refusal(anon().auth.requestPasswordReset({ email: 'missing@example.com' }));
      expect(noTtl).toEqual(noTtlMissing);
      expect(noTtl.code).toBe('auth.reset_unwired');
      expect(await hashOf(user.userId)).toBe(before);
      expect(sent).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM auth_flows`).toHaveLength(0);
    });

    it('does not change a frozen account, and a proof issued before the freeze no longer rotates the hash', async () => {
      const user = await register();
      await anon().auth.requestPasswordReset({ email: user.email });
      const before = await hashOf(user.userId);
      await auth.freezeIdentity(user.userId);

      const refused = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW }));
      expect(refused.code).toBe('auth.reset_proof_invalid');
      expect(await hashOf(user.userId)).toBe(before);

      sent.length = 0;
      const frozen = await anon().auth.requestPasswordReset({ email: user.email });
      const unknown = await anon().auth.requestPasswordReset({ email: 'missing@example.com' });
      expect(frozen).toEqual(unknown);
      expect(sent).toHaveLength(0);

      await auth.unfreezeIdentity(user.userId);
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).resolves.toMatchObject({ userId: user.userId });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).rejects.toMatchObject({
        cause: { code: 'auth.invalid_credentials' },
      });
    });

    it('does not spend the proof when the new password is refused, so a later correct password still works once', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      await anon().auth.requestPasswordReset({ email: user.email });

      const weak = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: 'short' }));
      expect(weak.code).toBe('auth.password_policy');
      expect(await hashOf(user.userId)).toBe(before);

      const same = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: OLD }));
      expect(same.code).toBe('auth.password_unchanged');
      expect(await hashOf(user.userId)).toBe(before);

      await anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW });
      expect(await hashOf(user.userId)).not.toBe(before);
      const spent = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEWER }));
      expect(spent.code).toBe('auth.reset_proof_invalid');
    });
  });
}
