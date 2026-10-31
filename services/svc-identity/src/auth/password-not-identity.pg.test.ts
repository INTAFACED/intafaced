import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { MAIL_RETRY_CAP, MAIL_RETRY_FIRST_WAIT_MS, flowSubjectHash } from './password-reset.js';
import { killPasswordResetProofs } from '../account/contact-common.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { createIdentityRouter } from '../router.js';
import { parseBreachedPasswords, useBreachedPasswords } from './passwords.js';
import { RankService } from '../rank/rank-service.js';

/**
 * I-signin-sessions-04: a password that is the account's handle, email or email local part is refused at
 * register, change and reset with `auth.password_policy`, and nothing changes. Numbers here are TEST fixtures.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase 2026';
const RESET_TTL_SECONDS = 900;
const POLICY = {
  maxAttempts: 3,
  requestMax: 2,
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
  const router = createIdentityRouter(auth, rank, { registrationOpen: true, directRegister: true, actionApprovals: stubActionApprovals() });
  const anon = () => router.createCaller(anonContext);

  const sent: Array<{ email: string; code: string; expiresAt: Date; purpose?: string; handle?: string }> = [];
  let failSend = false;
  let nowMs = T0;
  const mail = {
    async send(message: { email: string; code: string; expiresAt: Date; purpose?: string; handle?: string }) {
      sent.push(message);
      if (failSend) throw new Error('mail transport lost the reply');
    },
  };

  let counter = 0;
  const unique = () => `pi${process.pid}x${++counter}`;

  const register = async () => {
    const handle = unique();
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: OLD });
    return { handle, email, ...session };
  };
  const hashOf = async (userId: string) =>
    (await db.sql<Array<{ password_hash: string }>>`SELECT password_hash FROM users WHERE id = ${userId}`)[0]!.password_hash;
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
    sent.length = 0;
    failSend = false;
    nowMs = T0;
    auth.usePasswordResetMail(mail);
    auth.usePasswordResetTtl(RESET_TTL_SECONDS);
    auth.usePasswordResetPolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    // TEST fixtures, not owner settings.
    auth.usePasswordResetPolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    auth.usePasswordResetClock(() => new Date(nowMs));
    useBreachedPasswords(null);
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    useBreachedPasswords(null);
    await db.drop();
  });

  describe('password is not the account name (I-signin-sessions-04)', () => {
    it('refuses register with the handle, the email or its local part, and writes no user', async () => {
      for (const pick of ['handle', 'email', 'local'] as const) {
        const handle = `${unique()}longname`;
        const email = `${handle}.mail@example.com`;
        const password = pick === 'handle' ? handle.toUpperCase() : pick === 'email' ? ` ${email} ` : `${handle}.mail`;
        const refused = await refusal(anon().auth.register({ handle, email, password }));
        expect(refused).toMatchObject({ trpc: 'BAD_REQUEST', code: 'auth.password_policy' });
        expect(await db.sql`SELECT id FROM users WHERE handle = ${handle}`).toHaveLength(0);
      }
      // A password that merely contains the handle is allowed: only equality is refused.
      const handle = `${unique()}okname`;
      await expect(auth.register({ handle, email: `${handle}@example.com`, password: `${handle} plus more words` })).resolves.toMatchObject(
        {
          userId: expect.any(String),
        },
      );
    });

    it('refuses a too-short password at register with the typed auth.password_policy, not a raw WeakPasswordError', async () => {
      const handle = `short${Date.now()}`;
      await expect(auth.register({ handle, email: `${handle}@example.com`, password: 'abc', region: 'DE' })).rejects.toMatchObject({
        code: 'auth.password_policy',
      });
      expect(await db.sql`SELECT count(*)::int AS n FROM users WHERE handle = ${handle}`).toEqual([{ n: 0 }]);
    });

    it('refuses a change to the email address and keeps the old password', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      await expect(
        auth.changePassword({
          userId: user.userId,
          sessionId: user.sessionId,
          actor: { delegated: false, privileged: false, mfa: false },
          currentPassword: OLD,
          newPassword: user.email.toUpperCase(),
        }),
      ).rejects.toMatchObject({ code: 'auth.password_policy' });
      expect(await hashOf(user.userId)).toBe(before);
    });

    it('refuses a reset to the email and keeps the flow and the old password', async () => {
      const user = await register();
      await anon().auth.requestPasswordReset({ email: user.email });
      expect(sent).toHaveLength(1);
      const refused = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: user.email }));
      expect(refused.code).toBe('auth.password_policy');
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).resolves.toMatchObject({ userId: user.userId });
      // The same code still completes with an acceptable password.
      await anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).resolves.toMatchObject({ userId: user.userId });
    });
  });

  describe("the owner's breached-password list (I-signin-sessions-04)", () => {
    const BREACHED = 'TEST-breached-password-0001';
    // SHA-1 of BREACHED, as a published list carries it. A TEST fixture, not an owner list.
    const LIST = '# TEST list\n638F34801EC5D76EE0162EDF72DBAA147110536D:1\n';

    it('screens nothing until the owner sets a list', async () => {
      const handle = unique();
      await expect(auth.register({ handle, email: `${handle}@example.com`, password: BREACHED })).resolves.toMatchObject({
        userId: expect.any(String),
      });
    });

    it('refuses a listed password at register, change and reset by name, and changes nothing', async () => {
      useBreachedPasswords(parseBreachedPasswords(LIST));
      const handle = unique();
      expect(await refusal(anon().auth.register({ handle, email: `${handle}@example.com`, password: BREACHED }))).toMatchObject({
        trpc: 'BAD_REQUEST',
        code: 'auth.password_breached',
        message: expect.stringContaining('known from a data breach'),
      });
      expect(await db.sql`SELECT id FROM users WHERE handle = ${handle}`).toHaveLength(0);

      const user = await register();
      const before = await hashOf(user.userId);
      await expect(
        auth.changePassword({
          userId: user.userId,
          sessionId: user.sessionId,
          actor: { delegated: false, privileged: false, mfa: false },
          currentPassword: OLD,
          newPassword: BREACHED,
        }),
      ).rejects.toMatchObject({ code: 'auth.password_breached' });
      expect(await hashOf(user.userId)).toBe(before);

      await anon().auth.requestPasswordReset({ email: user.email });
      const code = sent.at(-1)!.code;
      expect((await refusal(anon().auth.completePasswordReset({ email: user.email, code, newPassword: BREACHED }))).code).toBe(
        'auth.password_breached',
      );
      // The refusal spends nothing: the same code completes with a password that is not listed.
      await anon().auth.completePasswordReset({ email: user.email, code, newPassword: NEW });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).resolves.toMatchObject({ userId: user.userId });
    });

    it('still signs in an account whose current password was listed later; only new passwords are screened', async () => {
      const handle = unique();
      const email = `${handle}@example.com`;
      const made = await auth.register({ handle, email, password: BREACHED });
      useBreachedPasswords(parseBreachedPasswords(LIST));
      await expect(anon().auth.login({ identifier: email, password: BREACHED })).resolves.toMatchObject({ userId: made.userId });
    });
  });

  describe('the "your password was changed" notice (I-signin-sessions-08)', () => {
    const notices = (email: string) => sent.filter((m) => m.email === email && m.purpose === 'password-changed');
    const proved = async (userId: string) => db.sql`UPDATE users SET email_verified_at = ${new Date(T0)} WHERE id = ${userId}`;

    it('mails the proved address once on a change and once on a reset, with no code', async () => {
      const user = await register();
      await proved(user.userId);
      await auth.changePassword({
        userId: user.userId,
        sessionId: user.sessionId,
        actor: { delegated: false, privileged: false, mfa: false },
        currentPassword: OLD,
        newPassword: NEW,
      });
      expect(notices(user.email)).toEqual([expect.objectContaining({ code: '', purpose: 'password-changed', userId: user.userId })]);

      await anon().auth.requestPasswordReset({ email: user.email });
      const code = sent.filter((m) => m.purpose === 'password-reset').at(-1)!.code;
      await anon().auth.completePasswordReset({ email: user.email, code, newPassword: `${NEW} again` });
      expect(notices(user.email)).toHaveLength(2);
      expect(await db.sql`SELECT status FROM mail_outbox WHERE purpose = 'password-changed' AND user_id = ${user.userId}`).toEqual([
        { status: 'sent' },
        { status: 'sent' },
      ]);
      // Each is also a sign-in factor change for the inbox (J-identity-03 #6), with no second mail: the notice above is it.
      expect(
        await db.sql`SELECT change, notice_key FROM security_factor_events WHERE user_id = ${user.userId} ORDER BY created_at`,
      ).toEqual([
        { change: 'password_changed', notice_key: `factor-changed:${user.userId}:1` },
        { change: 'password_changed', notice_key: `factor-changed:${user.userId}:2` },
      ]);
      expect(await db.sql`SELECT id FROM mail_outbox WHERE purpose = 'factor-changed' AND user_id = ${user.userId}`).toHaveLength(0);
    });

    it('sends nothing for a refused change, and nothing to an address that was never proved', async () => {
      const user = await register();
      await proved(user.userId);
      await expect(
        auth.changePassword({
          userId: user.userId,
          sessionId: user.sessionId,
          actor: { delegated: false, privileged: false, mfa: false },
          currentPassword: OLD,
          newPassword: user.email,
        }),
      ).rejects.toMatchObject({ code: 'auth.password_policy' });
      expect(notices(user.email)).toHaveLength(0);

      const unproved = await register();
      await auth.changePassword({
        userId: unproved.userId,
        sessionId: unproved.sessionId,
        actor: { delegated: false, privileged: false, mfa: false },
        currentPassword: OLD,
        newPassword: NEW,
      });
      expect(notices(unproved.email)).toHaveLength(0);
      // The refused change queued nothing for the inbox either; the unproved account's change still did, as the inbox
      // needs no proved address.
      expect(await db.sql`SELECT id FROM security_factor_events WHERE user_id = ${user.userId}`).toHaveLength(0);
      expect(await db.sql`SELECT change FROM security_factor_events WHERE user_id = ${unproved.userId}`).toEqual([
        { change: 'password_changed' },
      ]);
    });

    it('keeps the change when the mail transport fails, and the next relay tries the notice again', async () => {
      const user = await register();
      await proved(user.userId);
      failSend = true;
      await auth.changePassword({
        userId: user.userId,
        sessionId: user.sessionId,
        actor: { delegated: false, privileged: false, mfa: false },
        currentPassword: OLD,
        newPassword: NEW,
      });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).resolves.toMatchObject({ userId: user.userId });
      expect(notices(user.email)).toHaveLength(1);
      failSend = false;
      nowMs += MAIL_RETRY_FIRST_WAIT_MS;
      await auth.drainMailOutbox();
      expect(notices(user.email)).toHaveLength(2);
      expect(await db.sql`SELECT status FROM mail_outbox WHERE purpose = 'password-changed' AND user_id = ${user.userId}`).toEqual([
        { status: 'sent' },
      ]);
    });

    it('retries a notice that keeps failing on a doubling wait, never ahead of fresh mail, and gives up at the cap', async () => {
      const user = await register();
      await proved(user.userId);
      auth.useMailRelayTrigger(undefined);
      failSend = true;
      await auth.changePassword({
        userId: user.userId,
        sessionId: user.sessionId,
        actor: { delegated: false, privileged: false, mfa: false },
        currentPassword: OLD,
        newPassword: NEW,
      });
      await auth.drainMailOutbox();
      expect(notices(user.email)).toHaveLength(1);

      // Before its wait is over, relays send fresh mail and leave the notice alone.
      const other = await register();
      await proved(other.userId);
      failSend = false;
      await anon().auth.requestPasswordReset({ email: other.email });
      await auth.drainMailOutbox();
      await auth.drainMailOutbox();
      expect(sent.filter((m) => m.email === other.email).map((m) => m.purpose)).toEqual(['password-reset']);
      expect(notices(user.email)).toHaveLength(1);

      // Each failed send doubles the wait; a relay inside it sends nothing, one after it tries again.
      failSend = true;
      for (let failed = 1; failed < MAIL_RETRY_CAP; failed += 1) {
        const wait = MAIL_RETRY_FIRST_WAIT_MS * 2 ** (failed - 1);
        nowMs += wait - 1_000;
        await auth.drainMailOutbox();
        expect(notices(user.email)).toHaveLength(failed);
        nowMs += 1_000;
        await auth.drainMailOutbox();
        expect(notices(user.email)).toHaveLength(failed + 1);
      }
      // At the cap it stays `unknown`, however long the relay runs.
      nowMs += 30 * 24 * 3_600_000;
      await auth.drainMailOutbox();
      expect(notices(user.email)).toHaveLength(MAIL_RETRY_CAP);
      expect(
        await db.sql`SELECT status, failed_sends FROM mail_outbox WHERE purpose = 'password-changed' AND user_id = ${user.userId}`,
      ).toEqual([{ status: 'unknown', failed_sends: MAIL_RETRY_CAP }]);
    });

    it('still reaches the address proved at the change when the address changes or the account is frozen first', async () => {
      const user = await register();
      await proved(user.userId);
      auth.useMailRelayTrigger(undefined);
      await anon().auth.requestPasswordReset({ email: user.email });
      await auth.drainMailOutbox();
      const code = sent.filter((m) => m.purpose === 'password-reset').at(-1)!.code;
      await anon().auth.completePasswordReset({ email: user.email, code, newPassword: NEW });
      await db.sql`UPDATE users SET email = ${`moved-${user.email}`}, status = 'frozen' WHERE id = ${user.userId}`;
      await auth.drainMailOutbox();
      expect(notices(user.email)).toHaveLength(1);
    });
  });
}
