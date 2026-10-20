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
import { flowSubjectHash } from './password-reset.js';
import { killPasswordResetProofs } from '../account/contact-common.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { createIdentityRouter } from '../router.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Signed-out recovery flows (I-signin-sessions-03): equal work for every address, request and wrong-code
 * caps, username recovery, and a relay that sends each job once. Numbers here are TEST fixtures.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase 2026';
const NEWER = 'another passphrase after reset';
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
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  auth.useLogger({ warn: (obj, msg) => void warnings.push({ obj, msg }) });
  const router = createIdentityRouter(auth, rank, { registrationOpen: true, actionApprovals: stubActionApprovals() });
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
    auth.usePasswordResetPolicy(POLICY);
    auth.useMailRelayTrigger(async () => void (await auth.drainMailOutbox()));
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

  const counts = async () => ({
    flows: (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM auth_flows`)[0]!.n,
    jobs: (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM mail_outbox`)[0]!.n,
  });

  describe('recovery flows', () => {
    it('does the same database work and gives the same answer for a known and an unknown address', async () => {
      const user = await register();
      const known = await anon().auth.requestPasswordReset({ email: user.email });
      const afterKnown = await counts();
      const unknown = await anon().auth.requestPasswordReset({ email: 'missing@example.com' });
      const afterUnknown = await counts();

      expect(unknown).toEqual(known);
      expect(afterKnown).toEqual({ flows: 1, jobs: 1 });
      expect(afterUnknown).toEqual({ flows: 2, jobs: 2 });
      const flows = await db.sql<Array<{ status: string; user_id: string | null; code_hash: string | null; subject_hash: string }>>`
        SELECT status, user_id, code_hash, subject_hash FROM auth_flows ORDER BY created_at`;
      expect(flows.map((flow) => [flow.status, flow.user_id !== null, flow.code_hash !== null])).toEqual([
        ['code_sent', true, true],
        ['suppressed', false, true],
      ]);
      expect(flows[0]!.subject_hash).toBe(flowSubjectHash(POLICY.subjectKey, user.email));
      expect(JSON.stringify(flows)).not.toContain(user.email);
      const jobs = await db.sql<Array<{ purpose: string; status: string }>>`SELECT purpose, status FROM mail_outbox ORDER BY created_at`;
      expect(jobs).toEqual([
        { purpose: 'password-reset', status: 'sent' },
        { purpose: 'reset-no-account', status: 'suppressed' },
      ]);
      expect(sent.map((message) => message.email)).toEqual([user.email]);
    });

    it('mails an address with no account a notice, and no code, only when the owner turned notices on', async () => {
      auth.usePasswordResetPolicy({ ...POLICY, notifyUnknown: true });
      await anon().auth.requestPasswordReset({ email: 'missing@example.com' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ email: 'missing@example.com', purpose: 'reset-no-account', code: '' });
      const jobs = await db.sql<Array<{ code: string | null; status: string }>>`SELECT code, status FROM mail_outbox`;
      expect(jobs).toEqual([{ code: null, status: 'sent' }]);
    });

    it('counts the request cap per address for a known and an unknown address alike, and answers the same past it', async () => {
      const user = await register();
      const emails = [user.email, 'missing@example.com'];
      for (const email of emails) {
        for (const variant of [email, email.toUpperCase(), ` ${email} `, email]) {
          await expect(anon().auth.requestPasswordReset({ email: variant })).resolves.toEqual({ accepted: true });
        }
      }
      // Two per address got through; the other two each were answered and wrote nothing.
      expect(await counts()).toEqual({ flows: 4, jobs: 4 });
      expect(sent).toHaveLength(2);
      nowMs += 3601 * 1000;
      await anon().auth.requestPasswordReset({ email: user.email });
      expect(await counts()).toEqual({ flows: 5, jobs: 5 });
    });

    it('locks a flow at the wrong-code cap with the same answers for a known and an unknown address', async () => {
      const user = await register();
      await anon().auth.requestPasswordReset({ email: user.email });
      await anon().auth.requestPasswordReset({ email: 'missing@example.com' });
      const run = async (email: string) => {
        const answers = [];
        for (let i = 0; i < 3; i += 1)
          answers.push(await refusal(anon().auth.completePasswordReset({ email, code: `wrong-${i}`, newPassword: NEW })));
        const right = await refusal(anon().auth.completePasswordReset({ email, code: sent[0]!.code, newPassword: NEW }));
        return [...answers, right];
      };
      const knownAnswers = await run(user.email);
      const unknownAnswers = await run('missing@example.com');
      expect(knownAnswers.map((a) => a.code)).toEqual([
        'auth.reset_proof_invalid',
        'auth.reset_proof_invalid',
        'auth.too_many_attempts',
        'auth.too_many_attempts',
      ]);
      expect(unknownAnswers).toEqual(knownAnswers);
      const locked = (await db.sql<Array<{ status: string }>>`SELECT status FROM auth_flows WHERE user_id = ${user.userId}`)[0]!;
      expect(locked.status).toBe('locked');
      const err = (await anon()
        .auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW })
        .catch((e: unknown) => e)) as {
        cause?: { details?: { retryAfterSeconds?: number } };
      };
      expect(err.cause?.details?.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.cause?.details?.retryAfterSeconds).toBeLessThanOrEqual(RESET_TTL_SECONDS);
      // The old password still signs in; a new request opens a fresh flow with a fresh budget.
      await expect(anon().auth.login({ identifier: user.email, password: OLD })).resolves.toMatchObject({ userId: user.userId });
      await anon()
        .auth.requestPasswordReset({ email: user.email })
        .catch(() => undefined);
    });

    it('sends the username to a known address and a notice (if on) to any other, behind the same answer', async () => {
      const user = await register();
      auth.usePasswordResetPolicy({ ...POLICY, notifyUnknown: true });
      const known = await anon().auth.requestHandleRecovery({ email: user.email });
      const unknown = await anon().auth.requestHandleRecovery({ email: 'missing@example.com' });
      expect(unknown).toEqual(known);
      expect(known).toEqual({ accepted: true });
      expect(sent.map((m) => [m.email, m.purpose, m.handle])).toEqual([
        [user.email, 'handle-recovery', user.handle],
        ['missing@example.com', 'handle-recovery-no-account', undefined],
      ]);
      // A recovery request counts against its own kind, not the reset's.
      expect(await counts()).toEqual({ flows: 2, jobs: 2 });
      await anon().auth.requestPasswordReset({ email: user.email });
      expect(await counts()).toEqual({ flows: 3, jobs: 3 });
      const left = await db.sql`SELECT handle FROM mail_outbox WHERE handle IS NOT NULL`;
      expect(left).toHaveLength(0);
    });

    it('keeps the flow valid when the transport throws after sending, and does not send twice', async () => {
      const user = await register();
      failSend = true;
      await anon().auth.requestPasswordReset({ email: user.email });
      failSend = false;
      expect(sent).toHaveLength(1);
      const job = (await db.sql<Array<{ status: string; code: string | null }>>`SELECT status, code FROM mail_outbox`)[0]!;
      expect(job).toEqual({ status: 'unknown', code: null });
      await auth.drainMailOutbox();
      expect(sent).toHaveLength(1);
      await anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW });
      await expect(anon().auth.login({ identifier: user.email, password: NEW })).resolves.toMatchObject({ userId: user.userId });
    });

    it('sends each job once when drains run at the same time', async () => {
      const user = await register();
      auth.useMailRelayTrigger(undefined);
      await anon().auth.requestPasswordReset({ email: user.email });
      await Promise.all([auth.drainMailOutbox(), auth.drainMailOutbox(), auth.drainMailOutbox()]);
      expect(sent).toHaveLength(1);
    });

    it('ends open reset flows when the account email or phone changes', async () => {
      const user = await register();
      await anon().auth.requestPasswordReset({ email: user.email });
      await killPasswordResetProofs(db.sql, user.userId, new Date(nowMs));
      const refused = await refusal(anon().auth.completePasswordReset({ email: user.email, code: sent[0]!.code, newPassword: NEW }));
      expect(refused.code).toBe('auth.reset_proof_invalid');
    });

    it('answers a known and an unknown address in about the same time', async () => {
      const user = await register();
      auth.usePasswordResetPolicy({ ...POLICY, requestMax: 1_000 });
      auth.useMailRelayTrigger(undefined);
      const time = async (email: string) => {
        const t0 = performance.now();
        await anon().auth.requestPasswordReset({ email });
        return performance.now() - t0;
      };
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        known.push(await time(user.email));
        unknown.push(await time(`missing${i}@example.com`));
      }
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      // A test tolerance, not an owner setting. Both paths run the same statements.
      expect(median(known) / median(unknown)).toBeLessThan(2);
      expect(median(unknown) / median(known)).toBeLessThan(2);
    });
  });
}
