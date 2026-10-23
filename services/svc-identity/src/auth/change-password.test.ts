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
import { AuthService, type SessionTokens } from './auth-service.js';
import { ATTEMPT_POLICY } from './attempt-lockout.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { createIdentityRouter } from '../router.js';
import { FounderControls, parseFounderPair } from '../controls/founder-controls.js';
import { SecurityLock } from './security-lock.js';
import { RankService } from '../rank/rank-service.js';
import { userCopy } from '../user-copy.js';
import { totp } from './totp.js';

/**
 * `auth.changePassword` against real Postgres (own isolated schema), through the real router.
 *
 * What these hold: a signed-in person can change their password only with the current one;
 * the current password cannot be brute-forced through this door (it shares login's counter);
 * an account with a second factor needs an `mfa` session; an API key or sub-account never
 * can; the new password follows register's rules and differs from the old; every OTHER
 * session is revoked and the caller's stays; entitlements are not touched.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase 2026';
const NO_FACTOR = { mfa: false, privileged: false } as const;

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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('auth.changePassword (Postgres unavailable)', () => {
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

  let counter = 0;
  const unique = () => `cp${process.pid}x${++counter}`;

  const contextOf = async (tokens: SessionTokens, extra: Partial<Context['principal'] & object> = {}): Promise<Context> => {
    const principal = await verifyAccessToken(tokens.accessToken, tokenConfig);
    return { principal: { ...principal, ...extra }, service: null, region: 'DE', requestId: 'req-1' };
  };
  const callerOf = async (tokens: SessionTokens, extra?: Partial<Context['principal'] & object>) =>
    router.createCaller(await contextOf(tokens, extra));

  const register = async () => {
    const handle = unique();
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: OLD });
    return { handle, ...session };
  };
  const enrolTotp = async (userId: string) => {
    const { secret } = await auth.startTotpEnrolment(userId, NO_FACTOR);
    await auth.confirmTotpEnrolment(userId, NO_FACTOR, secret, totp(secret));
    return secret;
  };
  const hashOf = async (userId: string) =>
    (await db.sql<Array<{ password_hash: string }>>`SELECT password_hash FROM users WHERE id = ${userId}`)[0]!.password_hash;
  const attemptRows = (userId: string) => db.sql`SELECT kind FROM auth_attempts WHERE user_id = ${userId}`;
  const revokedFlags = async (userId: string) =>
    new Map(
      (await db.sql<Array<{ id: string; revoked: boolean }>>`SELECT id, revoked FROM sessions WHERE user_id = ${userId}`).map(
        (r) => [r.id, r.revoked] as const,
      ),
    );
  /** The error a call rejects with, as `{ code, cause }`. */
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
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('auth.changePassword', () => {
    it('changes the password: old one stops working, new one signs in, the audit line is written', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const api = await callerOf(user);

      expect(await api.auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });

      expect(await hashOf(user.userId)).not.toBe(before);
      await expect(auth.login({ identifier: user.handle, password: OLD })).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
      await expect(auth.login({ identifier: user.handle, password: NEW })).resolves.toMatchObject({ userId: user.userId });
      const audit = warnings.filter((w) => w.msg === 'auth.password_changed');
      expect(audit).toHaveLength(1);
      expect(audit[0]!.obj).toMatchObject({ userId: user.userId, otherSessionsRevoked: 0 });
      expect(JSON.stringify(audit[0])).not.toContain(NEW);
      expect(JSON.stringify(audit[0])).not.toContain(OLD);
      // the password counter is cleared on success
      expect(await attemptRows(user.userId)).toHaveLength(0);
    });

    it('a customer with no second factor can change it with the current password alone', async () => {
      const user = await register();
      const api = await callerOf(user); // mfa: false
      expect(await api.auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });
    });

    it('refuses while the security lock holds, spends no password guess, and changes once the lock has ended', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const api = await callerOf(user);
      const lock = new SecurityLock(db.sql, 0);
      await lock.lock(user.userId, { kind: 'self', userId: user.userId });

      const refused = await refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: NEW }));
      // A wrong current password is refused for the lock too, before it can count as a guess.
      const guessed = await refusal(api.auth.changePassword({ currentPassword: 'not my password at all', newPassword: NEW }));

      expect(refused).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.security_locked' });
      expect(guessed).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.security_locked' });
      expect(await hashOf(user.userId)).toBe(before);
      expect(await attemptRows(user.userId)).toHaveLength(0);
      // A published wait of zero ends the lock on the request; the change then goes through.
      expect(await lock.requestUnlock(user.userId)).toMatchObject({ locked: false, changed: true });
      expect(await api.auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });
    });

    it('a lock that lands after the first check, while the change waits on the account row, still refuses it', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const api = await callerOf(user);
      let change: Promise<unknown> | undefined;
      await db.sql.begin(async (holder) => {
        const pid = (await holder<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await holder`SELECT id FROM users WHERE id = ${user.userId} FOR UPDATE`;
        change = refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: NEW }));
        // The change has passed the unlocked check and now waits on this row.
        for (let waited = 0; ; waited += 20) {
          const blocked = (
            await db.sql<Array<{ blocked: number }>>`
            SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
          )[0]!.blocked;
          if (blocked > 0) break;
          if (waited > 10_000) throw new Error('the password change never reached the row lock');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await holder`INSERT INTO account_security_locks (user_id, set_by, set_by_user_id) VALUES (${user.userId}, 'self', ${user.userId})`;
      });

      expect(await change).toMatchObject({ trpc: 'PRECONDITION_FAILED', code: 'identity.security_locked' });
      expect(await hashOf(user.userId)).toBe(before);
    });

    it('refuses a wrong current password exactly like login, and leaves the hash alone', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const api = await callerOf(user);

      const viaChange = await refusal(api.auth.changePassword({ currentPassword: 'not my password at all', newPassword: NEW }));
      const viaLogin = await refusal(
        router.createCaller({ principal: null, service: null, region: 'DE', requestId: 'r' }).auth.login({
          identifier: user.handle,
          password: 'not my password at all',
        }),
      );

      // Same code and wording as login; the HTTP class differs on purpose: login's 401 is right
      // there, but here a 401 would make the apps sign a signed-in person out over a typo.
      expect(viaLogin.trpc).toBe('UNAUTHORIZED');
      expect(viaChange).toEqual({ ...viaLogin, trpc: 'FORBIDDEN' });
      expect(viaChange.code).toBe('auth.invalid_credentials');
      expect(await hashOf(user.userId)).toBe(before);
      // a weak new password does not leak past a wrong current password
      const weakAndWrong = await refusal(api.auth.changePassword({ currentPassword: 'not my password at all', newPassword: 'x' }));
      expect(weakAndWrong.code).toBe('auth.invalid_credentials');
    });

    it('locks after the budget: the correct current password is refused once the guesses are spent', async () => {
      const user = await register();
      const api = await callerOf(user);
      for (let i = 0; i < ATTEMPT_POLICY.password.maxFailures; i++) {
        expect((await refusal(api.auth.changePassword({ currentPassword: `guess number ${i} here`, newPassword: NEW }))).code).toBe(
          'auth.invalid_credentials',
        );
      }
      const locked = await refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: NEW }));
      expect(locked).toMatchObject({ trpc: 'TOO_MANY_REQUESTS', code: 'auth.too_many_attempts' });
      await expect(auth.login({ identifier: user.handle, password: OLD })).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      expect(await hashOf(user.userId)).not.toContain(NEW);
    });

    it('needs an mfa session when the account has a TOTP factor, and does not spend the password budget refusing', async () => {
      const user = await register();
      const secret = await enrolTotp(user.userId);
      const before = await hashOf(user.userId);

      const refused = await refusal((await callerOf(user)).auth.changePassword({ currentPassword: OLD, newPassword: NEW }));
      expect(refused).toMatchObject({ trpc: 'FORBIDDEN', code: 'auth.mfa_required' });
      expect(await hashOf(user.userId)).toBe(before);
      expect(await attemptRows(user.userId)).toHaveLength(0);

      // A TOTP login carries `mfa`.
      const mfaSession = await auth.login({
        identifier: user.handle,
        password: OLD,
        totpCode: totp(secret, { at: new Date(Date.now() + 30_000) }),
      });
      expect(await (await callerOf(mfaSession)).auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });
      expect(await hashOf(user.userId)).not.toBe(before);
    });

    it('needs an mfa session when the account has a passkey', async () => {
      const user = await register();
      await db.sql`UPDATE users SET webauthn_creds = ${db.sql.json([{ credentialId: 'cred-1', publicKey: 'AQID', counter: 0 }] as never)} WHERE id = ${user.userId}`;
      const api = await callerOf(user);

      expect(await refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: NEW }))).toMatchObject({
        trpc: 'FORBIDDEN',
        code: 'auth.mfa_required',
      });
      // A step-up token (mfa claim) is enough.
      const stepped = await callerOf(user, { mfa: true });
      expect(await stepped.auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });
    });

    it('refuses an API key and a sub-account even with the right password and mfa', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const viaKey = await callerOf(user, { mfa: true, kid: '55555555-5555-4555-8555-555555555555' });
      const viaSub = await callerOf(user, { mfa: true, sub_account: '66666666-6666-4666-8666-666666666666' });

      for (const api of [viaKey, viaSub]) {
        expect(await refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: NEW }))).toMatchObject({
          trpc: 'FORBIDDEN',
          code: 'auth.mfa_required',
        });
      }
      expect(await hashOf(user.userId)).toBe(before);
      expect(await attemptRows(user.userId)).toHaveLength(0);
    });

    it('always needs an mfa session for a privileged identity, even with no second factor', async () => {
      const founder = await register();
      const before = await hashOf(founder.userId);
      const asFounder = createIdentityRouter(auth, rank, {
        registrationOpen: true,
        actionApprovals: stubActionApprovals(),
        privilegedUserIds: [founder.userId],
      });
      const contextFounder = await contextOf(founder);

      expect(
        await refusal(asFounder.createCaller(contextFounder).auth.changePassword({ currentPassword: OLD, newPassword: NEW })),
      ).toMatchObject({
        trpc: 'FORBIDDEN',
        code: 'auth.mfa_required',
      });
      // An admin-scope session is privileged the same way.
      const admin = await contextOf(founder, { scopes: ['admin:write'] });
      expect(await refusal(router.createCaller(admin).auth.changePassword({ currentPassword: OLD, newPassword: NEW }))).toMatchObject({
        trpc: 'FORBIDDEN',
        code: 'auth.mfa_required',
      });
      expect(await hashOf(founder.userId)).toBe(before);
      expect(await attemptRows(founder.userId)).toHaveLength(0);

      const stepped = await contextOf(founder, { mfa: true });
      expect(await asFounder.createCaller(stepped).auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });
    });

    it('does not count a policy or same-password refusal as a failed guess once the current password verified', async () => {
      const user = await register();
      const api = await callerOf(user);
      for (let i = 0; i < ATTEMPT_POLICY.password.maxFailures + 2; i++) {
        await refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: 'short' }));
      }
      expect(await attemptRows(user.userId)).toHaveLength(0);
      await expect(auth.login({ identifier: user.handle, password: OLD })).resolves.toMatchObject({ userId: user.userId });
    });

    it('refuses a new password equal to the current one', async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const refused = await refusal((await callerOf(user)).auth.changePassword({ currentPassword: OLD, newPassword: OLD }));
      expect(refused).toMatchObject({ trpc: 'BAD_REQUEST', code: 'auth.password_unchanged' });
      expect(await hashOf(user.userId)).toBe(before);
    });

    it("refuses a new password that breaks register's rules", async () => {
      const user = await register();
      const before = await hashOf(user.userId);
      const api = await callerOf(user);
      for (const weak of ['short', 'aaaaaaaaaaaaaaaa', 'é'.repeat(40)]) {
        expect(await refusal(api.auth.changePassword({ currentPassword: OLD, newPassword: weak }))).toMatchObject({
          trpc: 'BAD_REQUEST',
          code: 'auth.password_policy',
        });
      }
      expect(await hashOf(user.userId)).toBe(before);
    });

    it('revokes every OTHER session and keeps the current one', async () => {
      const user = await register();
      const phone = await auth.login({ identifier: user.handle, password: OLD });
      const laptop = await auth.login({ identifier: user.handle, password: OLD });
      const mine = await verifyAccessToken(user.accessToken, tokenConfig);
      const stranger = await register();

      await (await callerOf(user)).auth.changePassword({ currentPassword: OLD, newPassword: NEW });

      const flags = await revokedFlags(user.userId);
      const phoneId = (await verifyAccessToken(phone.accessToken, tokenConfig)).sid;
      const laptopId = (await verifyAccessToken(laptop.accessToken, tokenConfig)).sid;
      expect(flags.get(mine.sid)).toBe(false);
      expect(flags.get(phoneId)).toBe(true);
      expect(flags.get(laptopId)).toBe(true);
      expect(warnings.find((w) => w.msg === 'auth.password_changed')!.obj).toMatchObject({ otherSessionsRevoked: 2 });
      // the kept session still refreshes; a revoked one does not
      await expect(auth.refresh(user.refreshToken)).resolves.toMatchObject({ userId: user.userId });
      await expect(auth.refresh(phone.refreshToken)).rejects.toBeDefined();
      // another person's sessions are untouched
      expect([...(await revokedFlags(stranger.userId)).values()]).toEqual([false]);
    });

    it('does not change a founder operator entitlement or its version', async () => {
      const founder = await register();
      const secret = await enrolTotp(founder.userId);
      const other = await register();
      await enrolTotp(other.userId);
      const controls = new FounderControls(db.sql, parseFounderPair(founder.userId, other.userId));
      expect(await controls.bootstrap()).toBe(true);
      const session = await auth.login({
        identifier: founder.handle,
        password: OLD,
        totpCode: totp(secret, { at: new Date(Date.now() + 30_000) }),
      });
      const context = await contextOf(session);
      const entitlement = () =>
        db.sql`SELECT user_id, enabled, version::text AS version FROM founder_operator_entitlements ORDER BY user_id`;
      const statusBefore = await controls.operatorStatus(context);
      const rowsBefore = await entitlement();
      expect(statusBefore).toMatchObject({ status: 'enabled' });

      const api = router.createCaller(context);
      expect(await api.auth.changePassword({ currentPassword: OLD, newPassword: NEW })).toEqual({ ok: true });

      expect(await controls.operatorStatus(context)).toEqual(statusBefore);
      expect(await entitlement()).toEqual(rowsBefore);
      expect(((await db.sql`SELECT status FROM users WHERE id = ${founder.userId}`) as Array<{ status: string }>)[0]!.status).toBe(
        'active',
      );
    });
  });

  describe('copy', () => {
    it('maps the new codes in user-copy', () => {
      expect(userCopy('auth.password_unchanged')).toMatch(/different/);
      expect(userCopy('auth.password_policy')).toMatch(/12 characters.*72 bytes.*repeated/);
      expect(userCopy('auth.mfa_required')).toBe('Two-factor verification');
    });
  });
}
