import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { securityLockSchema, type Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { SecurityStepUpError, type SecurityStepUp } from './security-step-up.js';
import { assertNotSecurityLocked, parseSecurityLockUnlockWait, SecurityLock } from './security-lock.js';
import { createSecurityLockRouter } from '../security-lock-router.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-security-lock-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

describe('parseSecurityLockUnlockWait', () => {
  it('leaves blank unset, keeps a published zero, and refuses anything that is not whole seconds up to 30 days', () => {
    expect(parseSecurityLockUnlockWait(undefined)).toBeUndefined();
    expect(parseSecurityLockUnlockWait('  ')).toBeUndefined();
    expect(parseSecurityLockUnlockWait('0')).toBe(0);
    expect(parseSecurityLockUnlockWait('86400')).toBe(86400);
    expect(() => parseSecurityLockUnlockWait('1.5')).toThrow(/whole seconds/);
    expect(() => parseSecurityLockUnlockWait('-1')).toThrow(/whole seconds/);
    expect(() => parseSecurityLockUnlockWait(String(31 * 24 * 3600))).toThrow(/30 days/);
  });
});

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('security lock (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_security_lock',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  afterAll(async () => {
    await db.drop();
  });
  let n = 0;
  const person = async () => {
    const handle = `sl${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const self = (userId: string) => ({ kind: 'self' as const, userId });
  const rows = (userId: string) =>
    db.sql<Array<{ state: string; unlocks_at: Date | null }>>`
      SELECT state, unlocks_at FROM account_security_locks WHERE user_id = ${userId} ORDER BY locked_at`;

  describe('security lock', () => {
    it('locks at once, answers the same on a repeat, and holds for enforcement', async () => {
      const userId = await person();
      const lock = new SecurityLock(db.sql, 3600);
      expect(await lock.read(userId)).toMatchObject({ locked: false, setBy: null });
      const first = await lock.lock(userId, self(userId));
      expect(first).toMatchObject({ userId, locked: true, setBy: 'self', unlocksAt: null, changed: true });
      expect(securityLockSchema.parse(await lock.read(userId))).toMatchObject({ locked: true });
      expect(await lock.lock(userId, self(userId))).toMatchObject({ locked: true, changed: false, lockedAt: first.lockedAt });
      await expect(assertNotSecurityLocked(db.sql, userId)).rejects.toMatchObject({ code: 'identity.security_locked', unlocksAt: null });
      expect(await rows(userId)).toHaveLength(1);
    });

    it('fixes the unlock time once: asking again, or a shorter owner wait later, never moves it earlier', async () => {
      const userId = await person();
      await new SecurityLock(db.sql, 3600).lock(userId, self(userId));
      const asked = await new SecurityLock(db.sql, 3600).requestUnlock(userId);
      expect(asked).toMatchObject({ locked: true, changed: true });
      const unlocksAt = Date.parse(asked.unlocksAt!);
      expect(unlocksAt - Date.parse(asked.unlockRequestedAt!)).toBe(3600_000);
      const again = await new SecurityLock(db.sql, 0).requestUnlock(userId);
      expect(again).toMatchObject({ locked: true, changed: false, unlocksAt: asked.unlocksAt });
      await expect(assertNotSecurityLocked(db.sql, userId)).rejects.toMatchObject({ code: 'identity.security_locked' });
      expect((await rows(userId))[0]!.unlocks_at!.getTime()).toBe(unlocksAt);
    });

    it('an unlock that waited on the account row is timed from when it got the row, never from before', async () => {
      const userId = await person();
      const lock = new SecurityLock(db.sql, 3600);
      await lock.lock(userId, self(userId));
      let asking: ReturnType<SecurityLock['requestUnlock']> | undefined;
      let released = new Date(0);
      await db.sql.begin(async (holder) => {
        const [{ pid }] = await holder<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        await holder`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        asking = lock.requestUnlock(userId);
        for (let waited = 0; ; waited += 20) {
          const [{ blocked }] = await db.sql<Array<{ blocked: number }>>`
            SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
          if (blocked > 0) break;
          if (waited > 10_000) throw new Error('the unlock request never reached the row lock');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        released = (await holder<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`)[0]!.at;
      });

      const asked = await asking!;
      expect(Date.parse(asked.unlockRequestedAt!)).toBeGreaterThanOrEqual(released.getTime());
      expect(Date.parse(asked.unlocksAt!) - Date.parse(asked.unlockRequestedAt!)).toBe(3600_000);
    });

    it('locking again while an unlock waits withdraws the request, and the lock holds with no end time', async () => {
      const userId = await person();
      const lock = new SecurityLock(db.sql, 3600);
      await lock.lock(userId, self(userId));
      await lock.requestUnlock(userId);
      expect(await lock.lock(userId, self(userId))).toMatchObject({
        locked: true,
        changed: true,
        unlocksAt: null,
        unlockRequestedAt: null,
      });
      expect(await rows(userId)).toEqual([{ state: 'locked', unlocks_at: null }]);
    });

    it('ends when the unlock time passes; locking afterwards opens a new lock and closes the old one', async () => {
      const userId = await person();
      const lock = new SecurityLock(db.sql, 0);
      await lock.lock(userId, self(userId));
      expect(await lock.requestUnlock(userId)).toMatchObject({ locked: false, changed: true });
      expect(await lock.read(userId)).toMatchObject({ locked: false });
      await expect(assertNotSecurityLocked(db.sql, userId)).resolves.toBeUndefined();
      expect(await lock.requestUnlock(userId)).toMatchObject({ locked: false, changed: false });
      expect(await lock.lock(userId, self(userId))).toMatchObject({ locked: true, changed: true });
      expect((await rows(userId)).map((r) => r.state)).toEqual(['ended', 'locked']);
    });

    it('refuses an unlock request while the owner wait is unset, and the lock holds; locking needs no wait', async () => {
      const userId = await person();
      const lock = new SecurityLock(db.sql, undefined);
      expect(await lock.lock(userId, self(userId))).toMatchObject({ locked: true });
      expect(() => lock.assertUnlockConfigured()).toThrow(expect.objectContaining({ code: 'identity.security_lock_unlock_wait_unset' }));
      await expect(lock.requestUnlock(userId)).rejects.toMatchObject({ code: 'identity.security_lock_unlock_wait_unset' });
      expect(await lock.read(userId)).toMatchObject({ locked: true, unlocksAt: null });
    });

    it('answers null for an unknown user and refuses to lock one', async () => {
      const lock = new SecurityLock(db.sql, 60);
      const ghost = '00000000-0000-4000-8000-000000000000';
      expect(await lock.read(ghost)).toBeNull();
      await expect(lock.lock(ghost, self(ghost))).rejects.toMatchObject({ code: 'identity.security_lock_not_found' });
    });
  });

  describe('securityLock router', () => {
    const spent: string[] = [];
    const stepUp = {
      async require(_principal: unknown, scope: string, fields: Record<string, string>, approvalId?: string | null) {
        if (!approvalId) throw new SecurityStepUpError('identity.step_up_required');
        if (spent.includes(approvalId)) throw new SecurityStepUpError('identity.step_up_used');
        expect(scope).toBe('identity.step_up.security_lock_unlock');
        expect(Object.keys(fields)).toEqual(['clientRequestId']);
        spent.push(approvalId);
      },
    } as unknown as SecurityStepUp;
    const callerFor = (userId: string, lock: SecurityLock, extra: Record<string, unknown> = {}) =>
      createSecurityLockRouter(lock, stepUp).createCaller({
        principal: { userId, sid: 'sid-1', scopes: ['identity:read', 'identity:write'], mfa: false, ...extra },
        service: null,
        region: 'DE',
        requestId: 'req-lock',
      } as unknown as Context);
    const codeOf = async (p: Promise<unknown>) =>
      ((await p.then(
        () => null,
        (e: unknown) => e,
      )) as { code?: string; cause?: { code?: string } } | null) ?? null;

    it('locks with no step-up, asks for one to unlock, spends it once, and spends none on a request that changes nothing', async () => {
      const userId = await person();
      const api = callerFor(userId, new SecurityLock(db.sql, 3600));
      expect(await api.securityLock.set()).toMatchObject({ locked: true, changed: true });
      const missing = await codeOf(api.securityLock.requestUnlock({ clientRequestId: 'r1' }));
      expect(missing).toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'identity.step_up_required' } });
      const asked = await api.securityLock.requestUnlock({ clientRequestId: 'r1', stepUpApprovalId: 'a1' });
      expect(asked).toMatchObject({ locked: true, changed: true });
      expect(asked.unlocksAt).not.toBeNull();
      // Already waiting: the same answer, and no new approval is asked for or spent.
      expect(await api.securityLock.requestUnlock({ clientRequestId: 'r2' })).toMatchObject({ changed: false, unlocksAt: asked.unlocksAt });
      expect(spent.filter((id) => id === 'a1')).toHaveLength(1);
      expect(await api.securityLock.read()).toMatchObject({ locked: true, unlocksAt: asked.unlocksAt });
    });

    it('refuses an API key and a sub-account, to lock and to unlock', async () => {
      const userId = await person();
      for (const extra of [{ kid: 'key-1' }, { sub_account: 'sub-1' }]) {
        const api = callerFor(userId, new SecurityLock(db.sql, 3600), extra);
        expect(await codeOf(api.securityLock.set())).toMatchObject({ code: 'FORBIDDEN' });
        expect(await codeOf(api.securityLock.requestUnlock({ clientRequestId: 'r', stepUpApprovalId: 'x' }))).toMatchObject({
          code: 'FORBIDDEN',
        });
      }
      expect(await new SecurityLock(db.sql, 3600).read(userId)).toMatchObject({ locked: false });
    });

    it('refuses an unlock with the owner wait unset before any approval is spent', async () => {
      const userId = await person();
      const api = callerFor(userId, new SecurityLock(db.sql, undefined));
      await api.securityLock.set();
      const before = spent.length;
      const refused = await codeOf(api.securityLock.requestUnlock({ clientRequestId: 'r', stepUpApprovalId: 'never-spent' }));
      expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'identity.security_lock_unlock_wait_unset' } });
      expect(spent.length).toBe(before);
    });
  });
}
