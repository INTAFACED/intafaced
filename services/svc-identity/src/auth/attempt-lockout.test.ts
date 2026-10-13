import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { AuthService, AuthError } from './auth-service.js';
import { ATTEMPT_POLICY, assertNotLocked, recordSuccess, reserveAttempt } from './attempt-lockout.js';
import { RankService } from '../rank/rank-service.js';
import { matchTotpStep, totp } from './totp.js';
import { hashToken } from './passwords.js';

/**
 * Per-account sign-in lockout against real Postgres (own isolated schema).
 *
 * What these hold: online guessing of a TOTP / recovery code / password is
 * capped per ACCOUNT in the database, a locked account is refused BEFORE any
 * code is verified (so a refusal never burns a TOTP step or recovery code),
 * parallel guesses cannot out-run the counter, unknown identifiers stay
 * indistinguishable from a wrong password, and a lost TOTP key does not lock
 * the owner out of their recovery codes.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const PASSWORD = 'correct horse battery staple';

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

/** A code for the next TOTP step (enrol confirm burns the current one). */
function totpNext(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  return totp(secret, { at: new Date((counter + 1) * 30 * 1000) });
}

/** A 6-digit code that matches none of the accepted steps for this secret. */
function wrongCode(secret: string): string {
  for (let n = 0; n < 1_000_000; n++) {
    const code = String(n).padStart(6, '0');
    if (matchTotpStep(secret, code) === null) return code;
  }
  throw new Error('unreachable');
}

/** Await a promise that MUST reject with an AuthError; fails the test if it resolves or rejects with anything else. */
async function authRejection(promise: Promise<unknown>): Promise<AuthError> {
  const outcome = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(outcome).toBeInstanceOf(AuthError);
  return outcome as AuthError;
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('attempt lockout (Postgres unavailable)', () => {
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
  await rank.seedTiers();

  let counter = 0;
  const unique = () => `lk${process.pid}x${++counter}`;

  const register = async () => {
    const handle = unique();
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    return { handle, ...session };
  };
  const enrolTotp = async (userId: string) => {
    const { secret, recoveryCodes } = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
    await auth.confirmTotpEnrolment(userId, PASSWORD_SESSION, secret, totp(secret));
    return { secret, recoveryCodes };
  };
  const attempts = (userId: string) =>
    db.sql<
      Array<{ kind: string; failures: number; locked_until: Date | null }>
    >`SELECT kind, failures, locked_until FROM auth_attempts WHERE user_id = ${userId} ORDER BY kind`;
  const expireLock = async (userId: string, kind: 'password' | 'mfa') => {
    await db.sql`UPDATE auth_attempts SET locked_until = now() - interval '1 second' WHERE user_id = ${userId} AND kind = ${kind}`;
  };
  const wrongPasswordTimes = async (handle: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await expect(auth.login({ identifier: handle, password: 'wrong password entirely' })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    }
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

  describe('policy numbers', () => {
    it('are the documented ones', () => {
      expect(ATTEMPT_POLICY.password).toEqual({
        maxFailures: 10,
        windowSeconds: 900,
        lockSeconds: 900,
        maxConsecutiveFailures: null,
        longLockSeconds: 86_400,
      });
      expect(ATTEMPT_POLICY.mfa).toEqual({
        maxFailures: 5,
        windowSeconds: 600,
        lockSeconds: 900,
        maxConsecutiveFailures: 20,
        longLockSeconds: 86_400,
      });
    });
  });

  describe('reserveAttempt (injected clock)', () => {
    it('counts, locks on the maxFailures-th attempt, refuses the next, and reopens after the lock', async () => {
      const { userId } = await register();
      const t0 = new Date('2030-01-01T00:00:00Z');
      for (let i = 0; i < 5; i++) await reserveAttempt(db.sql, userId, 'mfa', new Date(t0.getTime() + i * 1000));
      const [row] = await attempts(userId);
      expect(row).toMatchObject({ kind: 'mfa', failures: 5 });
      expect(row!.locked_until).not.toBeNull();

      const during = new Date(t0.getTime() + 60_000);
      const err = await authRejection(reserveAttempt(db.sql, userId, 'mfa', during));
      expect(err).toMatchObject({ code: 'auth.too_many_attempts' });
      expect(err.details?.retryAfterSeconds).toBeGreaterThan(0);
      expect(err.details?.retryAfterSeconds).toBeLessThanOrEqual(900);
      // The message names no count, threshold or kind.
      expect(err.message).not.toMatch(/\d/);
      // Refused attempts do not count.
      expect((await attempts(userId))[0]!.failures).toBe(5);
      await expect(assertNotLocked(db.sql, userId, 'mfa', during)).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      await expect(assertNotLocked(db.sql, userId, 'password', during)).resolves.toBeUndefined();

      const after = new Date(t0.getTime() + 4_000 + 901_000);
      await expect(reserveAttempt(db.sql, userId, 'mfa', after)).resolves.toEqual({ lockedForSeconds: null });
      expect(await attempts(userId)).toMatchObject([{ kind: 'mfa', failures: 1, locked_until: null }]);
    });

    it('starts a new window when the old one is stale', async () => {
      const { userId } = await register();
      const t0 = new Date('2030-01-01T00:00:00Z');
      for (let i = 0; i < 4; i++) await reserveAttempt(db.sql, userId, 'mfa', t0);
      await reserveAttempt(db.sql, userId, 'mfa', new Date(t0.getTime() + 601_000));
      expect(await attempts(userId)).toMatchObject([{ failures: 1, locked_until: null }]);
    });

    it('reports lockedForSeconds only on the attempt that sets the lock', async () => {
      const { userId } = await register();
      const t0 = new Date('2030-01-01T00:00:00Z');
      const seen: Array<number | null> = [];
      for (let i = 0; i < 5; i++) seen.push((await reserveAttempt(db.sql, userId, 'mfa', t0)).lockedForSeconds);
      expect(seen).toEqual([null, null, null, null, 900]);
    });

    it('defaults to the database clock', async () => {
      const { userId } = await register();
      await reserveAttempt(db.sql, userId, 'mfa');
      const rows = await db.sql<Array<{ d: number }>>`
        SELECT abs(extract(epoch FROM (window_started_at - now())))::float AS d FROM auth_attempts WHERE user_id = ${userId}`;
      expect(rows[0]!.d).toBeLessThan(5);
    });

    it('recordSuccess clears only the named kinds', async () => {
      const { userId } = await register();
      await reserveAttempt(db.sql, userId, 'mfa');
      await reserveAttempt(db.sql, userId, 'password');
      await recordSuccess(db.sql, userId, 'mfa');
      expect((await attempts(userId)).map((r) => r.kind)).toEqual(['password']);
    });
  });

  describe('long-run cap on consecutive failures', () => {
    const MIN = 60_000;
    /** `perWindow` attempts, then a jump past the window so the window counter resets. */
    const runAcrossWindows = async (
      userId: string,
      kind: 'mfa' | 'password',
      total: number,
      perWindow: number,
      windowMs: number,
      startMs = new Date('2030-01-01T00:00:00Z').getTime(),
    ) => {
      let at = startMs;
      let last: Awaited<ReturnType<typeof reserveAttempt>> = { lockedForSeconds: null };
      for (let i = 1; i <= total; i++) {
        last = await reserveAttempt(db.sql, userId, kind, new Date(at));
        if (i % perWindow === 0) at += windowMs + MIN;
        else at += 1000;
      }
      return { last, at };
    };

    it('mfa: 4 guesses per window never trips the window lock, but the 20th consecutive failure locks for 24 h', async () => {
      const { userId } = await register();
      const { last: before } = await runAcrossWindows(userId, 'mfa', 19, 4, 600_000);
      expect(before.lockedForSeconds).toBeNull();
      expect((await attempts(userId))[0]).toMatchObject({ kind: 'mfa', locked_until: null });
      const rows19 = await db.sql<
        Array<{ c: number; f: number }>
      >`SELECT consecutive_failures AS c, failures AS f FROM auth_attempts WHERE user_id = ${userId}`;
      expect(rows19[0]).toEqual({ c: 19, f: 3 }); // window reset several times; consecutive never did

      // The 20th attempt (verified as the last permitted guess) sets the long lock.
      const t20 = new Date('2031-01-01T00:00:00Z');
      const twentieth = await reserveAttempt(db.sql, userId, 'mfa', t20);
      expect(twentieth.lockedForSeconds).toBe(86_400);

      // Refused during the lock, and the lock is NOT extended by refused attempts.
      const lockedUntil = (await attempts(userId))[0]!.locked_until!;
      for (const dt of [MIN, 60 * MIN, 23 * 60 * MIN]) {
        await expect(reserveAttempt(db.sql, userId, 'mfa', new Date(t20.getTime() + dt))).rejects.toMatchObject({
          code: 'auth.too_many_attempts',
        });
      }
      expect((await attempts(userId))[0]!.locked_until!.getTime()).toBe(lockedUntil.getTime());
      const err = await authRejection(reserveAttempt(db.sql, userId, 'mfa', new Date(t20.getTime() + 23 * 60 * MIN)));
      expect(err.details?.retryAfterSeconds).toBe(3600);

      // After 24 h one more wrong guess is allowed through and re-locks for 24 h.
      const t21 = new Date(t20.getTime() + 86_401_000);
      expect((await reserveAttempt(db.sql, userId, 'mfa', t21)).lockedForSeconds).toBe(86_400);
    });

    it('a success resets the consecutive counter', async () => {
      const { userId } = await register();
      await runAcrossWindows(userId, 'mfa', 19, 4, 600_000);
      await recordSuccess(db.sql, userId, 'mfa');
      expect(await attempts(userId)).toEqual([]);
      const { last } = await runAcrossWindows(userId, 'mfa', 19, 4, 600_000);
      expect(last.lockedForSeconds).toBeNull();
    });

    it('password has NO long lock: 150 consecutive failures across windows only ever hit the 15-minute lock', async () => {
      const { userId } = await register();
      const { at } = await runAcrossWindows(userId, 'password', 9, 9, 900_000);
      // Keep failing across many windows; no attempt may report anything but the short lock.
      let next = at;
      const locks = new Set<number | null>();
      for (let w = 0; w < 16; w++) {
        const { last, at: end } = await runAcrossWindows(userId, 'password', 9, 9, 900_000, next);
        locks.add(last.lockedForSeconds);
        next = end;
      }
      expect([...locks]).toEqual([null]);
      const rows = await db.sql<Array<{ c: number; locked_until: Date | null }>>`
        SELECT consecutive_failures AS c, locked_until FROM auth_attempts WHERE user_id = ${userId}`;
      expect(rows[0]!.c).toBeGreaterThan(100);
      expect(rows[0]!.locked_until).toBeNull();
      // Window threshold (10th failure in one window) still locks for 15 minutes.
      const t = new Date(next + 1000);
      let lastSeconds: number | null = null;
      for (let i = 0; i < 10; i++) lastSeconds = (await reserveAttempt(db.sql, userId, 'password', t)).lockedForSeconds;
      expect(lastSeconds).toBe(900);
    });

    it('mfa counter never moves from password reservations', async () => {
      const { userId } = await register();
      await runAcrossWindows(userId, 'password', 20, 9, 900_000);
      expect((await attempts(userId)).map((r) => r.kind)).toEqual(['password']);
    });
  });

  describe('lock logging', () => {
    it('warns identity.account_locked once, when the lock is set, with no more than user id, kind and duration', async () => {
      const { userId, sessionId } = await register();
      const { secret } = await enrolTotp(userId);
      for (let i = 0; i < 5; i++) await auth.stepUp({ userId, sessionId, totpCode: wrongCode(secret) }).catch(() => undefined);
      await auth.stepUp({ userId, sessionId, totpCode: wrongCode(secret) }).catch(() => undefined); // refused: no new log
      const locked = warnings.filter((w) => w.msg === 'identity.account_locked');
      expect(locked).toHaveLength(1);
      expect(locked[0]!.obj).toEqual({ userId, kind: 'mfa', lockedForSeconds: 900 });
    });
  });

  describe('password lockout at login', () => {
    it('locks after 10 wrong passwords, refuses the correct one during the lock, accepts it after expiry', async () => {
      const { handle, userId } = await register();
      await wrongPasswordTimes(handle, 10);
      expect(await attempts(userId)).toMatchObject([{ kind: 'password', failures: 10 }]);

      await expect(auth.login({ identifier: handle, password: 'wrong password entirely' })).rejects.toMatchObject({
        code: 'auth.too_many_attempts',
      });
      await expect(auth.login({ identifier: handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.too_many_attempts' });

      await expireLock(userId, 'password');
      await expect(auth.login({ identifier: handle, password: PASSWORD })).resolves.toMatchObject({ userId });
      expect(await attempts(userId)).toEqual([]);
    });

    it('does not lock on the 9th wrong password', async () => {
      const { handle } = await register();
      await wrongPasswordTimes(handle, 9);
      await expect(auth.login({ identifier: handle, password: PASSWORD })).resolves.toBeTruthy();
    });

    it('answers an unknown identifier exactly like a wrong password, forever, and stores nothing', async () => {
      const { handle } = await register();
      const wrong = await authRejection(auth.login({ identifier: handle, password: 'nope nope nope nope' }));
      for (let i = 0; i < 15; i++) {
        const unknown = await authRejection(auth.login({ identifier: `nobody-${i}`, password: 'nope nope nope nope' }));
        expect(unknown).toMatchObject({ code: wrong.code, message: wrong.message });
      }
      const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM auth_attempts`;
      expect(rows[0]!.n).toBe('1'); // only the real account's own failure
    });

    it('a successful login clears the counter', async () => {
      const { handle, userId } = await register();
      await wrongPasswordTimes(handle, 3);
      expect(await attempts(userId)).toMatchObject([{ failures: 3 }]);
      await auth.login({ identifier: handle, password: PASSWORD });
      expect(await attempts(userId)).toEqual([]);
    });

    it('the counter row is removed with its user (ON DELETE CASCADE)', async () => {
      const rows = await db.sql<Array<{ confdeltype: string }>>`
        SELECT c.confdeltype FROM pg_constraint c
        WHERE c.conrelid = 'auth_attempts'::regclass AND c.contype = 'f'`;
      expect(rows).toEqual([{ confdeltype: 'c' }]);
    });
  });

  describe('mfa lockout at login', () => {
    it('locks after 5 wrong codes; a correct code during the lock is refused and consumes neither a TOTP step nor a recovery code', async () => {
      const { handle, userId } = await register();
      const { secret, recoveryCodes } = await enrolTotp(userId);
      const bad = wrongCode(secret);
      for (let i = 0; i < 5; i++) {
        await expect(auth.login({ identifier: handle, password: PASSWORD, totpCode: bad })).rejects.toMatchObject({
          code: 'auth.mfa_invalid',
        });
      }
      const good = totpNext(secret);
      await expect(auth.login({ identifier: handle, password: PASSWORD, totpCode: good })).rejects.toMatchObject({
        code: 'auth.too_many_attempts',
      });
      await expect(auth.login({ identifier: handle, password: PASSWORD, totpCode: recoveryCodes[0]! })).rejects.toMatchObject({
        code: 'auth.too_many_attempts',
      });
      const user = await db.sql<Array<{ totp_last_step: string | null; recovery_code_hashes: unknown }>>`
        SELECT totp_last_step, recovery_code_hashes FROM users WHERE id = ${userId}`;
      const hashes = user[0]!.recovery_code_hashes as string[];
      expect(hashes).toContain(hashToken(recoveryCodes[0]!));
      expect(hashes).toHaveLength(recoveryCodes.length);

      // Counters are separate: the correct password cleared the password counter; only mfa holds the lock.
      expect((await attempts(userId)).map((r) => r.kind)).toEqual(['mfa']);

      await expireLock(userId, 'mfa');
      // Same code now works: its step was never consumed while locked.
      const session = await auth.login({ identifier: handle, password: PASSWORD, totpCode: good });
      expect(session.userId).toBe(userId);
      expect(await attempts(userId)).toEqual([]);
    });

    it('a wrong password never moves the mfa counter', async () => {
      const { handle, userId } = await register();
      await enrolTotp(userId);
      await wrongPasswordTimes(handle, 3);
      expect((await attempts(userId)).map((r) => r.kind)).toEqual(['password']);
    });

    it('a correct password clears the password counter at once; the code step then clears the mfa counter', async () => {
      const { handle, userId } = await register();
      const { secret } = await enrolTotp(userId);
      await expect(auth.login({ identifier: handle, password: 'wrong password entirely' })).rejects.toBeInstanceOf(AuthError);
      await expect(auth.login({ identifier: handle, password: PASSWORD, totpCode: wrongCode(secret) })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
      expect((await attempts(userId)).map((r) => r.kind)).toEqual(['mfa']);
      await auth.login({ identifier: handle, password: PASSWORD, totpCode: totpNext(secret) });
      expect(await attempts(userId)).toEqual([]);
    });
  });

  describe('regression: the TOTP owner is not trapped after a password lock', () => {
    it('correct password with no code, then with the code, both work after the password lock expires; the correct password resets the counter', async () => {
      const { handle, userId } = await register();
      const { secret } = await enrolTotp(userId);
      await wrongPasswordTimes(handle, 10);
      await expect(auth.login({ identifier: handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      // The worst legacy state: a huge consecutive count with the lock just expired.
      await db.sql`UPDATE auth_attempts SET consecutive_failures = 101, locked_until = now() - interval '1 second' WHERE user_id = ${userId} AND kind = 'password'`;

      // Step 1 of the normal flow: password only. Told the code is needed, and NOT re-locked.
      await expect(auth.login({ identifier: handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      expect((await attempts(userId)).filter((r) => r.kind === 'password')).toEqual([]);
      // Step 2: password plus code.
      const session = await auth.login({ identifier: handle, password: PASSWORD, totpCode: totpNext(secret) });
      expect(session.userId).toBe(userId);
      expect(await attempts(userId)).toEqual([]);
    });

    it('repeating the password-only first step never accumulates against the owner', async () => {
      const { handle, userId } = await register();
      await enrolTotp(userId);
      // Each call hashes a password (argon2), so keep the count above the 10-failure threshold but small, and give CI headroom.
      for (let i = 0; i < 12; i++) {
        await expect(auth.login({ identifier: handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.mfa_required' });
      }
      expect(await attempts(userId)).toEqual([]);
    }, 60_000);
  });

  describe('step-up mirrors login', () => {
    it('20 parallel wrong guesses verify at most 5, lock the account, and a valid code is then refused unconsumed', async () => {
      const { userId, sessionId } = await register();
      const { secret } = await enrolTotp(userId);
      const bad = wrongCode(secret);
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => auth.stepUp({ userId, sessionId, totpCode: bad })));
      const codes = results.map((r) => (r.status === 'rejected' ? (r.reason as AuthError).code : 'fulfilled'));
      expect(codes.filter((c) => c === 'auth.mfa_invalid')).toHaveLength(5); // verifications performed
      expect(codes.filter((c) => c === 'auth.too_many_attempts')).toHaveLength(15);
      expect(await attempts(userId)).toMatchObject([{ kind: 'mfa', failures: 5 }]);

      const good = totpNext(secret);
      await expect(auth.stepUp({ userId, sessionId, totpCode: good })).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      await expireLock(userId, 'mfa');
      const elevated = await auth.stepUp({ userId, sessionId, totpCode: good });
      expect(elevated.scopes).toContain('trade:withdraw');
      expect(await attempts(userId)).toEqual([]);
    });

    it('a recovery code is refused (and kept) while locked', async () => {
      const { userId, sessionId } = await register();
      const { secret, recoveryCodes } = await enrolTotp(userId);
      for (let i = 0; i < 5; i++) {
        await expect(auth.stepUp({ userId, sessionId, totpCode: wrongCode(secret) })).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
      }
      await expect(auth.stepUp({ userId, sessionId, totpCode: recoveryCodes[0]! })).rejects.toMatchObject({
        code: 'auth.too_many_attempts',
      });
      await expireLock(userId, 'mfa');
      await expect(auth.stepUp({ userId, sessionId, totpCode: recoveryCodes[0]! })).resolves.toBeTruthy();
    });

    it('exhausting the password counter does not lock step-up of an already signed-in user', async () => {
      const { handle, userId, sessionId } = await register();
      const { secret } = await enrolTotp(userId);
      await wrongPasswordTimes(handle, 10);
      await expect(auth.login({ identifier: handle, password: PASSWORD })).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      await expect(auth.stepUp({ userId, sessionId, totpCode: totpNext(secret) })).resolves.toBeTruthy();
    });
  });

  describe('undecryptable TOTP secret', () => {
    const corrupt = async (userId: string) => {
      await db.sql`UPDATE users SET totp_secret = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ${userId}`;
    };

    it('a valid recovery code still logs in, with one structured warn and no secret material', async () => {
      const { handle, userId } = await register();
      const { recoveryCodes } = await enrolTotp(userId);
      await corrupt(userId);
      const session = await auth.login({ identifier: handle, password: PASSWORD, totpCode: recoveryCodes[0]! });
      expect(session.userId).toBe(userId);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.msg).toBe('identity.totp_secret_undecryptable');
      expect(warnings[0]!.obj).toEqual({ userId });
    });

    it('a wrong code is still auth.mfa_invalid, same as with a healthy secret', async () => {
      const { handle, userId, sessionId } = await register();
      await enrolTotp(userId);
      await corrupt(userId);
      await expect(auth.login({ identifier: handle, password: PASSWORD, totpCode: '123456' })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
      await expect(auth.stepUp({ userId, sessionId, totpCode: '123456' })).rejects.toMatchObject({ code: 'auth.mfa_invalid' });
    });

    it('step-up with a recovery code works too', async () => {
      const { userId, sessionId } = await register();
      const { recoveryCodes } = await enrolTotp(userId);
      await corrupt(userId);
      await expect(auth.stepUp({ userId, sessionId, totpCode: recoveryCodes[1]! })).resolves.toBeTruthy();
    });
  });
}
