import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { requestMetaAls } from './auth/request-meta.js';
import { RankService } from './rank/rank-service.js';
import { createListSessionsRouter } from './list-sessions-router.js';
import { createSessionFamiliesRouter } from './session-families-router.js';
import { createSessionRevokeRouter } from './session-revoke-router.js';

/** Sign-in families against real Postgres: rotation keeps one family, and ending other devices ends only them. */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
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
const PASSWORD = 'correct horse battery staple';

if (!(await postgresAvailable(URL))) {
  describe.skip('session families (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_families',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  const routes = mergeRouters(createListSessionsRouter(db.sql), createSessionFamiliesRouter(db.sql), createSessionRevokeRouter(db.sql));
  afterAll(async () => {
    await db.drop();
  });

  let counter = 0;
  const newUser = async () => {
    const handle = `famuser${++counter}`;
    await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    return { handle, userId: (await db.sql<Array<{ id: string }>>`SELECT id FROM users WHERE handle = ${handle}`)[0]!.id };
  };
  const signIn = (handle: string, device: string, userAgent: string, ip: string) =>
    requestMetaAls.run({ ip, userAgent }, () => auth.login({ identifier: handle, password: PASSWORD, device }));
  async function as(userId: string, sessionId: string) {
    const { token } = await issueAccessToken({ userId, sessionId, scopes: [...SESSION_SCOPES], tier: 'none', mfa: true }, tokenConfig);
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
    return routes.createCaller(ctx);
  }
  const familyOf = async (sessionId: string) =>
    (await db.sql<Array<{ family_id: string }>>`SELECT family_id FROM sessions WHERE id = ${sessionId}`)[0]!.family_id;

  describe('sign-in families', () => {
    it('lists one row per device with its details, however often a token has rotated', async () => {
      const { handle, userId } = await newUser();
      const phone = await signIn(handle, 'Phone', 'Mobile/1.0', '203.0.113.7');
      const laptop = await signIn(handle, 'Laptop', 'Desktop/2.0', '198.51.100.9');
      let phoneRefresh = phone.refreshToken;
      let phoneSession = phone.sessionId;
      for (let i = 0; i < 5; i += 1) {
        const next = await auth.refresh(phoneRefresh);
        phoneRefresh = next.refreshToken;
        phoneSession = next.sessionId;
      }
      const listed = await (await as(userId, laptop.sessionId)).listSessions({ userId, limit: 50 });
      const devices = listed.sessions.filter((row) => row.device === 'Phone' || row.device === 'Laptop');
      expect(devices).toHaveLength(2);
      const onPhone = devices.find((row) => row.device === 'Phone')!;
      expect(onPhone).toMatchObject({ id: phoneSession, userAgent: 'Mobile/1.0', ip: '203.0.113.x', isCurrent: false, country: null });
      expect(onPhone.familyId).toBe(await familyOf(phone.sessionId));
      expect(devices.find((row) => row.device === 'Laptop')).toMatchObject({ isCurrent: true, ip: '198.51.100.x' });
    });

    it('signing out other devices ends their next refresh and leaves the caller working', async () => {
      const { handle, userId } = await newUser();
      const here = await signIn(handle, 'Here', 'A', '203.0.113.1');
      const other = await signIn(handle, 'Other', 'B', '203.0.113.2');
      const mine = await as(userId, here.sessionId);
      expect(await mine.revokeOtherSessions({})).toEqual({ revokedFamilies: expect.any(Number) });
      await expect(auth.refresh(other.refreshToken)).rejects.toMatchObject({ code: expect.stringMatching(/^auth\.session_/) });
      await expect(auth.refresh(here.refreshToken)).resolves.toBeTruthy();
      expect((await mine.revokeOtherSessions({})).revokedFamilies).toBe(0);
    });

    it("refuses to end the current device, and treats another account's family as not found", async () => {
      const a = await newUser();
      const b = await newUser();
      const aSession = await signIn(a.handle, 'A1', 'ua', '203.0.113.3');
      const aOther = await signIn(a.handle, 'A2', 'ua', '203.0.113.4');
      const bSession = await signIn(b.handle, 'B1', 'ua', '203.0.113.5');
      const mine = await as(a.userId, aSession.sessionId);
      await expect(mine.revokeSessionFamily({ familyId: await familyOf(aSession.sessionId) })).rejects.toMatchObject({
        message: expect.stringContaining('auth.session_current'),
      });
      await expect(mine.revokeSession({ userId: a.userId, sessionId: aSession.sessionId })).rejects.toMatchObject({
        message: expect.stringContaining('auth.session_current'),
      });
      await expect(mine.revokeSessionFamily({ familyId: await familyOf(bSession.sessionId) })).rejects.toMatchObject({
        message: 'auth.not_found',
      });
      const bStill = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${bSession.sessionId}`;
      expect(bStill[0]?.revoked).toBe(false);
      const other = await familyOf(aOther.sessionId);
      expect(await mine.revokeSessionFamily({ familyId: other })).toEqual({ familyId: other, revoked: true });
      expect(await mine.revokeSessionFamily({ familyId: other })).toEqual({ familyId: other, revoked: false });
    });

    it('pages 7 devices with a cursor and refuses a malformed cursor', async () => {
      const { handle, userId } = await newUser();
      const seats = [];
      for (let i = 0; i < 7; i += 1) seats.push(await signIn(handle, `Device ${i}`, 'ua', `203.0.113.${10 + i}`));
      const caller = await as(userId, seats[0]!.sessionId);
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await caller.listSessions({ userId, limit: 3, ...(cursor ? { cursor } : {}) });
        for (const row of page.sessions) seen.add(row.familyId);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      expect(seen.size).toBe(8);
      expect(pages).toBe(3);
      await expect(caller.listSessions({ userId, limit: 3, cursor: 'not-a-cursor' })).rejects.toBeTruthy();
    });

    it('ends every other family when the password changes', async () => {
      const { handle, userId } = await newUser();
      const here = await signIn(handle, 'Here', 'A', '203.0.113.20');
      const other = await signIn(handle, 'Other', 'B', '203.0.113.21');
      await auth.changePassword({
        userId,
        sessionId: here.sessionId,
        actor: { mfa: true, privileged: false, delegated: false } as never,
        currentPassword: PASSWORD,
        newPassword: 'a different long passphrase 99',
      });
      const live = await (await as(userId, here.sessionId)).listSessions({ userId, limit: 50 });
      expect(live.sessions.map((row) => row.id)).toContain(here.sessionId);
      expect(live.sessions.map((row) => row.id)).not.toContain(other.sessionId);
      await expect(auth.refresh(other.refreshToken)).rejects.toBeTruthy();
    });
  });
}
