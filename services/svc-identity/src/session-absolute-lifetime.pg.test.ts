import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { RankService } from './rank/rank-service.js';

/**
 * I-signin-sessions-06 (ENGINE X-8): a sign-in family has an absolute lifetime measured from its first login.
 * Rotation never pushes the expiry later, so a family that keeps refreshing still ends.
 */
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const TTL_SECONDS = 3600;
const tokenConfig = {
  secret: 'an-identity-session-lifetime-pg-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: TTL_SECONDS,
};
const PASSWORD = 'correct horse battery staple';

if (!(await postgresAvailable(URL))) {
  describe.skip('session absolute lifetime (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_lifetime',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  afterAll(async () => {
    await db.drop();
  });
  let counter = 0;
  const signIn = async () => {
    const handle = `lifetime${process.pid}x${++counter}`;
    await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    return auth.login({ identifier: handle, password: PASSWORD, device: 'Phone' });
  };
  const expiryOf = async (sessionId: string) =>
    (await db.sql<Array<{ expires_at: Date; family_id: string }>>`SELECT expires_at, family_id FROM sessions WHERE id = ${sessionId}`)[0]!;

  describe('session family absolute lifetime (I-signin-sessions-06)', () => {
    it('keeps the first login expiry across every rotation', async () => {
      const first = await signIn();
      const start = await expiryOf(first.sessionId);
      let token = first.refreshToken;
      let sessionId = first.sessionId;
      for (let i = 0; i < 3; i += 1) {
        const next = await auth.refresh(token);
        token = next.refreshToken;
        sessionId = next.sessionId;
        const row = await expiryOf(sessionId);
        expect(row.family_id).toBe(start.family_id);
        expect(row.expires_at.getTime()).toBe(start.expires_at.getTime());
      }
    });

    it('refuses a family past its first-login lifetime even though it was refreshed in time', async () => {
      const first = await signIn();
      // The family started TTL ago and has been rotated since: the live row inherits the first login's expiry.
      const next = await auth.refresh(first.refreshToken);
      await db.sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${next.sessionId}`;
      await expect(auth.refresh(next.refreshToken)).rejects.toMatchObject({ code: 'auth.session_invalid' });
      const [row] = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${next.sessionId}`;
      expect(row!.revoked).toBe(true);
    });

    it('a shorter configured TTL still bounds a rotation of an older, longer-lived row', async () => {
      const first = await signIn();
      // A row issued under a longer TTL than today's setting: the rotation takes the shorter of the two.
      await db.sql`UPDATE sessions SET expires_at = now() + interval '30 days' WHERE id = ${first.sessionId}`;
      const before = Date.now();
      const next = await auth.refresh(first.refreshToken);
      const row = await expiryOf(next.sessionId);
      expect(row.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + TTL_SECONDS * 1000);
      expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + TTL_SECONDS * 1000 - 1000);
    });
  });
}
