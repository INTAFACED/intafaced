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
import { checkLoginCode, consumeLoginCode } from './login-code.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { totp } from './totp.js';
import { createIdentityRouter } from '../router.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Sign-in by a mailed code (I-signin-sessions-19, -20; J-identity-02 #3). The same answer for every name, a code only
 * to an active account, a wrong-code lockout, single use, resend voids the old code, and the second factor still asked.
 * Every number in this file is a TEST fixture, not an owner setting.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'a long enough sign-in passphrase';
const POLICY = { codeTtlSeconds: 600, maxAttempts: 3, resendSeconds: 60, requestMax: 4, requestWindowSeconds: 3600 } as const;
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;

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
const anonContext: Context = { principal: null, service: null, region: 'DE', requestId: 'req-login-code' };

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('sign-in by code (Postgres unavailable)', () => {
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
  const router = createIdentityRouter(auth, rank, { registrationOpen: true, actionApprovals: stubActionApprovals() });
  const anon = () => router.createCaller(anonContext);

  const sent: Array<{ email: string; code: string; purpose?: string }> = [];
  let nowMs = T0;
  let counter = 0;
  const account = async () => {
    const handle = `lc${process.pid}x${++counter}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    return { handle, email: `${handle}@example.com`, userId: session.userId };
  };
  const refusal = async (promise: Promise<unknown>) => {
    const err = (await promise.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string; details?: { retryAfterSeconds?: number } } } | undefined;
    expect(err).toBeDefined();
    return { trpc: err!.code, code: err!.cause?.code, retryAfterSeconds: err!.cause?.details?.retryAfterSeconds };
  };
  const codesTo = (email: string) => sent.filter((m) => m.email === email && m.purpose === 'login-code').map((m) => m.code);
  const count = async (table: string) => (await db.sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n;
  const sessionsOf = async (userId: string) =>
    (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`)[0]!.n;

  beforeEach(async () => {
    bus.reset();
    sent.length = 0;
    nowMs = T0;
    auth.usePasswordResetMail({
      async send(message) {
        sent.push(message);
      },
    });
    auth.usePasswordResetPolicy({ subjectKey: 'test-only-flow-subject-key-0123456789abcdef' });
    auth.useLoginCodePolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
    auth.usePasswordResetClock(() => new Date(nowMs));
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('sign-in by a mailed code', () => {
    it('mails a six-digit code to the account, which opens one session once; the code is never stored in the clear', async () => {
      const who = await account();
      const before = await sessionsOf(who.userId);
      const answer = await anon().auth.loginCodeRequest({ identifier: who.handle });

      expect(answer).toEqual({ accepted: true, flowId: expect.any(String), resendAfterSeconds: 60 });
      const [code] = codesTo(who.email);
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(await db.sql`SELECT * FROM auth_flows`)).not.toContain(code);
      expect(JSON.stringify(await db.sql`SELECT * FROM mail_outbox`)).not.toContain(code);

      const session = await anon().auth.loginWithCode({ flowId: answer.flowId, code: code! });
      expect(session).toMatchObject({ accessToken: expect.any(String), userId: who.userId });
      expect(await sessionsOf(who.userId)).toBe(before + 1);

      // A used code is refused and opens nothing more.
      expect(await refusal(anon().auth.loginWithCode({ flowId: answer.flowId, code: code! }))).toMatchObject({
        trpc: 'UNAUTHORIZED',
        code: 'auth.code_invalid',
      });
      expect(await sessionsOf(who.userId)).toBe(before + 1);
    });

    it('answers an unknown name, a frozen account and a real one the same, and mails only the real one', async () => {
      const real = await account();
      const frozen = await account();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen.userId}`;
      const answers = [
        await anon().auth.loginCodeRequest({ identifier: real.email }),
        await anon().auth.loginCodeRequest({ identifier: `nobody${counter}@example.com` }),
        await anon().auth.loginCodeRequest({ identifier: frozen.email }),
      ];
      for (const a of answers) expect(Object.keys(a).sort()).toEqual(['accepted', 'flowId', 'resendAfterSeconds']);
      expect(await count('auth_flows')).toBe(3);
      expect(await count('mail_outbox')).toBe(3);
      expect(sent.map((m) => m.email)).toEqual([real.email]);
      // No guess finishes the unknown name's flow or the frozen account's, and a wrong guess counts the same.
      for (const a of answers.slice(1)) {
        expect(await refusal(anon().auth.loginWithCode({ flowId: a.flowId, code: '000000' }))).toMatchObject({ code: 'auth.code_invalid' });
      }
      expect(await sessionsOf(frozen.userId)).toBe(1);
    });

    it('locks the code after the owner count of wrong tries, with the seconds left; the right code then fails too', async () => {
      const who = await account();
      const { flowId } = await anon().auth.loginCodeRequest({ identifier: who.email });
      const [code] = codesTo(who.email);
      const wrong = code === '111111' ? '222222' : '111111';
      for (let i = 1; i < POLICY.maxAttempts; i++) {
        expect(await refusal(anon().auth.loginWithCode({ flowId, code: wrong }))).toMatchObject({ code: 'auth.code_invalid' });
      }
      expect(await refusal(anon().auth.loginWithCode({ flowId, code: wrong }))).toMatchObject({
        trpc: 'TOO_MANY_REQUESTS',
        code: 'auth.too_many_attempts',
        retryAfterSeconds: 600,
      });
      expect(await refusal(anon().auth.loginWithCode({ flowId, code: code! }))).toMatchObject({ code: 'auth.too_many_attempts' });
      expect(await refusal(anon().auth.loginCodeResend({ flowId }))).toMatchObject({ code: 'auth.too_many_attempts' });
    });

    it('refuses a resend inside the interval; after it the old code stops working and the new one signs in', async () => {
      const who = await account();
      const { flowId } = await anon().auth.loginCodeRequest({ identifier: who.email });
      expect(await refusal(anon().auth.loginCodeResend({ flowId }))).toMatchObject({ code: 'identity.resend_too_soon' });
      nowMs += 61_000;
      await anon().auth.loginCodeResend({ flowId });
      const [oldCode, newCode] = codesTo(who.email);
      expect(newCode).toMatch(/^\d{6}$/);
      if (oldCode !== newCode) {
        expect(await refusal(anon().auth.loginWithCode({ flowId, code: oldCode! }))).toMatchObject({ code: 'auth.code_invalid' });
      }
      await expect(anon().auth.loginWithCode({ flowId, code: newCode! })).resolves.toMatchObject({ userId: who.userId });
    });

    it('caps codes per name inside the window and says when to try again', async () => {
      const who = await account();
      for (let i = 0; i < POLICY.requestMax; i++) await anon().auth.loginCodeRequest({ identifier: who.email });
      expect(await refusal(anon().auth.loginCodeRequest({ identifier: who.email }))).toMatchObject({
        code: 'auth.too_many_attempts',
        retryAfterSeconds: 3600,
      });
    });

    it('counts the cap per account too, so asking by handle and by email does not double the codes', async () => {
      const who = await account();
      for (let i = 0; i < POLICY.requestMax; i++) {
        await anon().auth.loginCodeRequest({ identifier: i % 2 === 0 ? who.email : who.handle });
      }
      for (const identifier of [who.email, who.handle]) {
        expect(await refusal(anon().auth.loginCodeRequest({ identifier }))).toMatchObject({ code: 'auth.too_many_attempts' });
      }
    });

    it('a resend that lands after a code was checked stops that code from being spent', async () => {
      const who = await account();
      const { flowId } = await anon().auth.loginCodeRequest({ identifier: who.email });
      const [oldCode] = codesTo(who.email);
      const deps = {
        ...POLICY,
        sql: db.sql,
        mail: { send: async () => undefined },
        subjectKey: 'test-only-flow-subject-key-0123456789abcdef',
        now: () => new Date(nowMs),
        log: { warn: () => undefined },
      };
      const checked = await checkLoginCode(deps, { flowId, code: oldCode! });
      nowMs += 61_000;
      await anon().auth.loginCodeResend({ flowId });
      await expect(consumeLoginCode(deps, { flowId, codeHash: checked.codeHash })).rejects.toMatchObject({ code: 'auth.code_invalid' });
    });

    it('a code never signs in an account with an authenticator without it; the code stays good until it comes', async () => {
      const who = await account();
      const { secret } = await auth.startTotpEnrolment(who.userId, PASSWORD_SESSION);
      await auth.confirmTotpEnrolment(who.userId, PASSWORD_SESSION, secret, totp(secret));
      const { flowId } = await anon().auth.loginCodeRequest({ identifier: who.email });
      const [code] = codesTo(who.email);
      expect(await refusal(anon().auth.loginWithCode({ flowId, code: code! }))).toMatchObject({ code: 'auth.mfa_required' });
      // The next step's code: the current one was spent confirming the enrolment.
      const session = await anon().auth.loginWithCode({
        flowId,
        code: code!,
        totpCode: totp(secret, { at: new Date(Date.now() + 30_000) }),
      });
      expect(session).toMatchObject({ userId: who.userId });
    });

    it('refuses every name the same way while a setting is blank, and a phone number names the switched-off provider', async () => {
      const who = await account();
      expect(await refusal(anon().auth.loginCodeRequest({ identifier: '+44 7700 900123' }))).toMatchObject({
        trpc: 'PRECONDITION_FAILED',
        code: 'vendor.sms',
      });
      auth.useLoginCodePolicy({ ...POLICY, maxAttempts: undefined });
      for (const identifier of [who.email, 'nobody@example.com']) {
        expect(await refusal(anon().auth.loginCodeRequest({ identifier }))).toMatchObject({
          trpc: 'PRECONDITION_FAILED',
          code: 'auth.codes_unwired',
        });
      }
      expect(await count('auth_flows')).toBe(0);
    });
  });
}
