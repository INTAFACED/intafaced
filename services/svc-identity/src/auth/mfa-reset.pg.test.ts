/**
 * The locked-out second-factor reset against Postgres (I-signin-sessions-12; J-identity-05 #2, #3): the password again,
 * a code to the proved address, the owner's wait on the database clock, a notice to every contact, a stop from any
 * signed-in session, and completion at the next password sign-in that removes the authenticator app and ends every
 * session in one transaction. A blank wait refuses before the password is even counted.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { createMfaResetRouter } from '../mfa-reset-router.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService, type SessionTokens } from './auth-service.js';
import { relayMailOutbox } from './password-reset.js';
import { totp } from './totp.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-mfa-reset-test-secret-long-enough-x',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('mfa reset (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );
  auth.useLogger({ warn: () => undefined });
  const api = createMfaResetRouter(auth);
  const lock = (userId: string) =>
    db.sql`INSERT INTO account_security_locks (user_id, set_by, set_by_user_id) VALUES (${userId}, 'self', ${userId})`;
  const resetState = async (userId: string) =>
    (await db.sql<Array<{ state: string }>>`SELECT state FROM mfa_resets WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`)[0]
      ?.state;
  const anon = () => api.createCaller({ principal: null, service: null, region: 'DE', requestId: 'req-mfa-reset' } as Context);
  const callerOf = async (tokens: SessionTokens) => {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return api.createCaller({ principal, service: null, region: 'DE', requestId: 'req-mfa-reset' } as Context);
  };

  let n = 0;
  /** A TEST account with a proved address, an authenticator app, its recovery codes and one live session. */
  async function account() {
    const handle = `mr${process.pid}x${++n}`;
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD, region: 'DE' });
    await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
    const started = await auth.startTotpEnrolment(session.userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(session.userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    return { handle, email, userId: session.userId, session, secret: started.secret };
  }
  const mails = async (userId: string, purpose: string) =>
    db.sql<Array<{ code: string | null; recipient: string; expires_at: Date }>>`
      SELECT code, recipient, expires_at FROM mail_outbox WHERE user_id = ${userId} AND purpose = ${purpose} ORDER BY created_at`;
  const codeOf = async (userId: string) => (await mails(userId, 'mfa-reset-code')).at(-1)!.code!;
  const userRow = async (userId: string) =>
    (
      await db.sql<Array<{ totp_secret: string | null; codes: number }>>`
        SELECT totp_secret, jsonb_array_length(recovery_code_hashes) AS codes FROM users WHERE id = ${userId}`
    )[0]!;
  const liveSessions = async (userId: string) =>
    (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId} AND revoked = false`)[0]!.n;
  const refusal = async (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: unknown) => ((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code) as string,
    );
  async function waiting(a: { handle: string; userId: string }) {
    const started = await anon().mfaReset.start({ identifier: a.handle, password: PASSWORD });
    if (started.state !== 'code_sent') throw new Error('expected a code');
    return anon().mfaReset.confirm({ resetId: started.resetId, code: await codeOf(a.userId) });
  }

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
    auth.usePasswordResetMail({ async send() {} });
    auth.usePasswordResetPolicy({ subjectKey: 'test-only-flow-subject-key-0123456789abcdef' });
    auth.useLoginCodePolicy({ codeTtlSeconds: 600, maxAttempts: 3 });
    auth.useMfaResetWait(3600);
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('starting', () => {
    it('refuses with the wait blank, before the password is counted, and nothing is written', async () => {
      const a = await account();
      auth.useMfaResetWait(undefined);
      expect(await refusal(anon().mfaReset.start({ identifier: a.handle, password: 'wrong password entirely' }))).toBe(
        'identity.mfa_reset_unconfigured',
      );
      const [attempts] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM auth_attempts WHERE user_id = ${a.userId}`;
      expect(attempts!.n).toBe(0);
      expect(await db.sql`SELECT 1 FROM mfa_resets`).toHaveLength(0);
    });

    it('refuses a wrong password the same way sign-in does, and mails nothing', async () => {
      const a = await account();
      expect(await refusal(anon().mfaReset.start({ identifier: a.handle, password: 'wrong password entirely' }))).toBe(
        'auth.invalid_credentials',
      );
      expect(await refusal(anon().mfaReset.start({ identifier: 'nobody-at-all', password: PASSWORD }))).toBe('auth.invalid_credentials');
      expect(await mails(a.userId, 'mfa-reset-code')).toHaveLength(0);
    });

    it('needs an authenticator to reset and a proved address to send the code to', async () => {
      const handle = `mr${process.pid}x${++n}`;
      const plain = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
      await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${plain.userId}`;
      expect(await refusal(anon().mfaReset.start({ identifier: handle, password: PASSWORD }))).toBe('identity.mfa_reset_not_enrolled');
      const a = await account();
      await db.sql`UPDATE users SET email_verified_at = NULL WHERE id = ${a.userId}`;
      expect(await refusal(anon().mfaReset.start({ identifier: a.handle, password: PASSWORD }))).toBe(
        'identity.mfa_reset_no_proved_address',
      );
    });

    it('refuses while the security lock holds, and mails nothing', async () => {
      const a = await account();
      await lock(a.userId);
      expect(await refusal(anon().mfaReset.start({ identifier: a.handle, password: PASSWORD }))).toBe('identity.security_locked');
      expect(await mails(a.userId, 'mfa-reset-code')).toHaveLength(0);
    });

    it('mails a code to the proved address and names it masked', async () => {
      const a = await account();
      const started = await anon().mfaReset.start({ identifier: a.email, password: PASSWORD });
      expect(started).toMatchObject({ state: 'code_sent', email: `m***@example.com` });
      const [mail] = await mails(a.userId, 'mfa-reset-code');
      expect(mail!.recipient).toBe(a.email);
      expect(mail!.code).toMatch(/^\d{6}$/);
      // The code is not stored in the clear on the reset.
      const [row] = await db.sql<Array<{ code_hash: string }>>`SELECT code_hash FROM mfa_resets`;
      expect(row!.code_hash).not.toContain(mail!.code!);
    });

    it('a new start replaces the open code, up to the owner count of codes per lifetime', async () => {
      const a = await account();
      const first = await anon().mfaReset.start({ identifier: a.handle, password: PASSWORD });
      const firstCode = await codeOf(a.userId);
      await anon().mfaReset.start({ identifier: a.handle, password: PASSWORD });
      expect(await refusal(anon().mfaReset.confirm({ resetId: first.resetId, code: firstCode }))).toBe('auth.code_expired');
      await anon().mfaReset.start({ identifier: a.handle, password: PASSWORD });
      expect(await refusal(anon().mfaReset.start({ identifier: a.handle, password: PASSWORD }))).toBe('auth.too_many_attempts');
    });
  });

  describe('the code and the wait', () => {
    it('wrong codes count and the owner count locks the reset, even against the right code', async () => {
      const a = await account();
      const started = await anon().mfaReset.start({ identifier: a.handle, password: PASSWORD });
      const code = await codeOf(a.userId);
      const wrong = code === '000000' ? '111111' : '000000';
      expect(await refusal(anon().mfaReset.confirm({ resetId: started.resetId, code: wrong }))).toBe('auth.code_invalid');
      expect(await refusal(anon().mfaReset.confirm({ resetId: started.resetId, code: wrong }))).toBe('auth.code_invalid');
      expect(await refusal(anon().mfaReset.confirm({ resetId: started.resetId, code: wrong }))).toBe('auth.too_many_attempts');
      expect(await refusal(anon().mfaReset.confirm({ resetId: started.resetId, code }))).toBe('auth.too_many_attempts');
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
    });

    it('the right code starts the wait on the database clock and tells every contact; asking again changes nothing', async () => {
      const a = await account();
      const before = Date.now();
      const view = await waiting(a);
      expect(view.state).toBe('waiting');
      if (view.state !== 'waiting') return;
      const completes = Date.parse(view.completesAt);
      expect(completes - before).toBeGreaterThanOrEqual(3600_000 - 5_000);
      expect(completes - Date.now()).toBeLessThanOrEqual(3600_000 + 5_000);
      expect(view.told).toEqual({ email: 'm***@example.com', sms: null });
      const [notice] = await mails(a.userId, 'mfa-reset-started');
      expect(notice!.recipient).toBe(a.email);
      expect(notice!.expires_at.toISOString()).toBe(view.completesAt);
      // Again: the same time, and no second notice, whether by the code or by a new start.
      expect(await anon().mfaReset.confirm({ resetId: view.resetId, code: '123456' })).toEqual(view);
      auth.useMfaResetWait(60);
      expect(await anon().mfaReset.start({ identifier: a.handle, password: PASSWORD })).toEqual(view);
      expect(await mails(a.userId, 'mfa-reset-started')).toHaveLength(1);
      expect(await (await callerOf(a.session)).mfaReset.status()).toEqual({
        waiting: { resetId: view.resetId, waitingSince: expect.any(String), completesAt: view.completesAt },
      });
    });

    it('a proved phone is named as not texted: this build has no texting rail', async () => {
      const a = await account();
      await db.sql`UPDATE users SET phone = '+14155552671', phone_verified_at = now() WHERE id = ${a.userId}`;
      const view = await waiting(a);
      expect(view.state === 'waiting' && view.told.sms).toBe('vendor.sms');
    });

    it('before the wait ends, sign-in still asks for the second step and the authenticator stays', async () => {
      const a = await account();
      await waiting(a);
      await expect(auth.login({ identifier: a.handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
    });
  });

  describe('stopping it from a signed-in session', () => {
    it('stops the waiting reset, mails a notice, and the wait never completes', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      const own = await callerOf(a.session);
      expect(await own.mfaReset.cancel()).toEqual({ cancelled: true });
      expect(await mails(a.userId, 'mfa-reset-cancelled')).toHaveLength(1);
      expect(await own.mfaReset.status()).toEqual({ waiting: null });
      // The wait had passed, but the stopped reset completes nothing.
      await expect(auth.login({ identifier: a.handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
      // Stopping twice is not an error.
      expect(await own.mfaReset.cancel()).toEqual({ cancelled: false });
    });

    it('an API key or a sub-account is refused in words and stops nothing', async () => {
      const a = await account();
      await waiting(a);
      const principal = await verifyAccessToken(a.session.accessToken, tokenConfig);
      const keyed = api.createCaller({
        principal: { ...principal, kid: 'k-test' },
        service: null,
        region: 'DE',
        requestId: 'r',
      } as Context);
      expect(await refusal(keyed.mfaReset.cancel())).toBe('identity.delegated_refused');
      expect(await resetState(a.userId)).toBe('waiting');
    });

    it('a sign-in that passes the second step with the app stops it, with the notice, even after the wait', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      // The code enrolment used is spent; let this window's code count again, as a later window's would.
      await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${a.userId}`;
      await auth.login({ identifier: a.handle, password: PASSWORD, totpCode: totp(a.secret) });
      expect(await resetState(a.userId)).toBe('cancelled');
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
      expect(await mails(a.userId, 'mfa-reset-cancelled')).toHaveLength(1);
      expect(await mails(a.userId, 'mfa-reset-completed')).toHaveLength(0);
    });

    it("another account's session stops nothing", async () => {
      const a = await account();
      const b = await account();
      await waiting(a);
      expect(await (await callerOf(b.session)).mfaReset.cancel()).toEqual({ cancelled: false });
      expect((await (await callerOf(a.session)).mfaReset.status()).waiting).not.toBeNull();
    });
  });

  describe('completing after the wait', () => {
    it('the next password sign-in removes the app and its codes and ends every session, and says so by mail', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      expect(await liveSessions(a.userId)).toBe(1);
      const session = await auth.login({ identifier: a.handle, password: PASSWORD });
      expect(session.userId).toBe(a.userId);
      expect(await userRow(a.userId)).toEqual({ totp_secret: null, codes: 0 });
      // The old session ended; only the one just opened is live.
      expect(await liveSessions(a.userId)).toBe(1);
      const [live] = await db.sql<Array<{ id: string }>>`SELECT id FROM sessions WHERE user_id = ${a.userId} AND revoked = false`;
      expect(live!.id).toBe(session.sessionId);
      expect(await mails(a.userId, 'mfa-reset-completed')).toHaveLength(1);
      // The inbox hears the app went (I-signin-sessions-08); the completed notice is its only mail.
      const changes = await db.sql<Array<{ change: string }>>`SELECT change FROM security_factor_events WHERE user_id = ${a.userId}`;
      expect(changes.map((c) => c.change)).toEqual(['totp_added', 'totp_removed']);
      expect(await mails(a.userId, 'factor-changed')).toHaveLength(1);
      const [row] = await db.sql<Array<{ state: string }>>`SELECT state FROM mfa_resets WHERE user_id = ${a.userId}`;
      expect(row!.state).toBe('completed');
    });

    it('a wrong password completes nothing', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      await expect(auth.login({ identifier: a.handle, password: 'wrong password entirely' })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
    });

    it('the security lock holds it: nothing completes while the lock is on', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      await lock(a.userId);
      await expect(auth.login({ identifier: a.handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
      expect(await resetState(a.userId)).toBe('waiting');
    });

    it('an app set up again during the wait ends the reset and stays', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      // As a replace does: a new secret with a new set-up time.
      await db.sql`UPDATE users SET totp_enrolled_at = now() + interval '1 second' WHERE id = ${a.userId}`;
      expect(await (await callerOf(a.session)).mfaReset.status()).toEqual({ waiting: null });
      await expect(auth.login({ identifier: a.handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
      expect(await resetState(a.userId)).toBe('expired');
      expect(await liveSessions(a.userId)).toBe(1);
    });

    it('a frozen account completes nothing', async () => {
      const a = await account();
      auth.useMfaResetWait(0);
      await waiting(a);
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${a.userId}`;
      await expect(auth.login({ identifier: a.handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.account_frozen' });
      expect((await userRow(a.userId)).totp_secret).not.toBeNull();
    });
  });

  describe('the notices on the relay', () => {
    it('a started notice whose send threw goes back for another try, and a freeze does not withdraw it', async () => {
      const a = await account();
      await waiting(a);
      await db.sql`UPDATE mail_outbox SET status = 'sent' WHERE user_id = ${a.userId} AND purpose <> 'mfa-reset-started'`;
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${a.userId}`;
      const deps = {
        sql: db.sql,
        mail: {
          async send() {
            throw new Error('TEST provider down');
          },
        },
        ttlSeconds: 600,
        now: () => new Date(),
        log: { warn: () => undefined },
      };
      expect(await relayMailOutbox(deps)).toMatchObject({ unknown: 1 });
      const [row] = await db.sql<Array<{ status: string; failed_sends: number }>>`
        SELECT status, failed_sends FROM mail_outbox WHERE user_id = ${a.userId} AND purpose = 'mfa-reset-started'`;
      expect(row).toEqual({ status: 'pending', failed_sends: 1 });
    });
  });
}
