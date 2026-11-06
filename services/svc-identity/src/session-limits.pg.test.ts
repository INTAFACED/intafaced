import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { RankService } from './rank/rank-service.js';
import {
  createSessionSettingsRouter,
  effectiveIdleSeconds,
  ownIdleRange,
  parseSessionLimits,
  SESSION_SETTING_OUT_OF_RANGE,
} from './auth/session-limits.js';

/**
 * I-signin-sessions-06, J-identity-06 #4: idle sign-out (the shorter of the owner's and the person's own) and the
 * signed-in device limit (a sign-in beyond it ends the oldest device).
 */
describe('session limit settings', () => {
  it('reads blank as unset and stops the start on a value that is not a whole number above zero', () => {
    expect(parseSessionLimits({})).toEqual({ idleSeconds: null, maxConcurrent: null });
    expect(parseSessionLimits({ SESSION_IDLE_SECONDS: ' ', SESSION_MAX_CONCURRENT: '' })).toEqual({
      idleSeconds: null,
      maxConcurrent: null,
    });
    expect(parseSessionLimits({ SESSION_IDLE_SECONDS: '3600', SESSION_MAX_CONCURRENT: '3' })).toEqual({
      idleSeconds: 3600,
      maxConcurrent: 3,
    });
    for (const bad of ['0', '-1', '1.5', 'off', '1e3']) {
      expect(() => parseSessionLimits({ SESSION_IDLE_SECONDS: bad })).toThrow(/SESSION_IDLE_SECONDS/);
      expect(() => parseSessionLimits({ SESSION_MAX_CONCURRENT: bad })).toThrow(/SESSION_MAX_CONCURRENT/);
    }
  });

  it('applies the shorter of the owner’s and the person’s own idle time', () => {
    expect(effectiveIdleSeconds(null, null)).toBeNull();
    expect(effectiveIdleSeconds(3600, null)).toBe(3600);
    expect(effectiveIdleSeconds(null, 1200)).toBe(1200);
    expect(effectiveIdleSeconds(3600, 1200)).toBe(1200);
    expect(effectiveIdleSeconds(1200, 3600)).toBe(1200);
  });

  it('lets a person choose from one access token’s life up to the owner’s, or the absolute lifetime when the owner set none', () => {
    const tokens = { accessTtlSeconds: 900, refreshTtlSeconds: 2_592_000 };
    expect(ownIdleRange({ idleSeconds: 3600, maxConcurrent: null }, tokens)).toEqual({ min: 900, max: 3600 });
    expect(ownIdleRange({ idleSeconds: null, maxConcurrent: null }, tokens)).toEqual({ min: 900, max: 2_592_000 });
  });
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-session-limits-pg-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const PASSWORD = 'correct horse battery staple';

if (!(await postgresAvailable(URL))) {
  describe.skip('session limits (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_session_limits',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const limits = { idleSeconds: 3600, maxConcurrent: 3 };
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  auth.setSessionLimits(limits);
  afterAll(async () => {
    await db.drop();
  });
  let counter = 0;
  const account = async () => {
    const handle = `limits${process.pid}x${++counter}`;
    await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const [user] = await db.sql<Array<{ id: string }>>`SELECT id FROM users WHERE handle = ${handle}`;
    return { handle, userId: user!.id };
  };
  const login = (handle: string) => auth.login({ identifier: handle, password: PASSWORD, device: 'Phone' });
  const idleFor = (sessionId: string, minutes: number) =>
    db.sql`UPDATE sessions SET created_at = created_at - make_interval(mins => ${minutes}) WHERE id = ${sessionId}`;
  const liveFamilies = async (userId: string) =>
    (
      await db.sql<Array<{ family_id: string }>>`
        SELECT family_id FROM sessions WHERE user_id = ${userId} AND revoked = false GROUP BY family_id ORDER BY min(created_at)`
    ).map((row) => row.family_id);
  const familyOf = async (sessionId: string) =>
    (await db.sql<Array<{ family_id: string }>>`SELECT family_id FROM sessions WHERE id = ${sessionId}`)[0]!.family_id;
  const settingsRouter = createSessionSettingsRouter(db.sql, limits, tokenConfig);
  const caller = async (userId: string, sessionId: string) => {
    const { token } = await issueAccessToken(
      { userId, sessionId, scopes: ['identity:read', 'identity:write'], tier: 'none', mfa: false },
      tokenConfig,
    );
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
    return settingsRouter.createCaller(ctx);
  };

  describe('idle sign-out (I-signin-sessions-06)', () => {
    it('refuses a refresh past the owner’s idle time with auth.session_idle and ends that sign-in', async () => {
      const { handle } = await account();
      const first = await login(handle);
      await idleFor(first.sessionId, 61);
      await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ code: 'auth.session_idle' });
      const [row] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${first.sessionId}`;
      expect(row!.revoked).toBe(true);
    });

    it('lets a refresh inside the owner’s idle time through, and a shorter own time then applies', async () => {
      const { handle, userId } = await account();
      const first = await login(handle);
      await idleFor(first.sessionId, 25);
      const next = await auth.refresh(first.refreshToken);
      const settings = await (await caller(userId, next.sessionId)).setIdleSignout({ seconds: 20 * 60 });
      expect(settings.appliedIdleSeconds).toBe(1200);
      expect(settings.own.idleSeconds).toBe(1200);
      await idleFor(next.sessionId, 21);
      await expect(auth.refresh(next.refreshToken)).rejects.toMatchObject({ code: 'auth.session_idle' });
    });

    it('refuses an own time longer than the owner’s or shorter than an access token’s life, and changes nothing', async () => {
      const { handle, userId } = await account();
      const first = await login(handle);
      const me = await caller(userId, first.sessionId);
      await me.setIdleSignout({ seconds: 1800 });
      for (const seconds of [3601, 899]) {
        await expect(me.setIdleSignout({ seconds })).rejects.toThrow(SESSION_SETTING_OUT_OF_RANGE);
      }
      expect((await me.sessionSettings({})).own.idleSeconds).toBe(1800);
      // Clearing goes back to the owner's.
      expect((await me.setIdleSignout({ seconds: null })).appliedIdleSeconds).toBe(3600);
    });
  });

  describe('signed-in device limit (I-signin-sessions-06)', () => {
    it('ends the oldest device at the fourth sign-in, and only that one', async () => {
      const { handle, userId } = await account();
      const first = await login(handle);
      await login(handle);
      await login(handle);
      const three = await liveFamilies(userId);
      expect(three).toHaveLength(3);
      expect(three[0]).toBe(await familyOf(first.sessionId));
      const fourth = await login(handle);
      const after = await liveFamilies(userId);
      expect(after).toEqual([...three.slice(1), await familyOf(fourth.sessionId)]);
      await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ code: 'auth.session_invalid' });
    });

    it('keeps refreshes of one device one sign-in: rotating never counts as another device', async () => {
      const { handle, userId } = await account();
      let tip = await login(handle);
      for (let i = 0; i < 4; i += 1) tip = await auth.refresh(tip.refreshToken);
      await login(handle);
      await login(handle);
      expect(await liveFamilies(userId)).toHaveLength(3);
      expect(await liveFamilies(userId)).toContain(await familyOf(tip.sessionId));
    });

    it('holds the limit when sign-ins race: the users row lock makes them take turns', async () => {
      const { handle, userId } = await account();
      await Promise.all(Array.from({ length: 6 }, () => login(handle)));
      expect(await liveFamilies(userId)).toHaveLength(3);
    });
  });
}
