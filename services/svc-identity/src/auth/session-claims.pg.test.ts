import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Access tokens name their sign-in (`fam`) and trusted device (`dev`), and both stay the same across refreshes while
 * `sid` moves to each successor session, so another service can tell a second device from the same browser after a
 * refresh (J-wallet-04 #5). Every value here is a TEST fixture.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'a long enough sign-in passphrase';

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
  describe.skip('session claims (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  // Grace 10s and recovery 120s, so the second-tab and lost-reply refreshes run too.
  const auth = new AuthService(
    db.sql,
    bus,
    new RankService(db.sql, bus),
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
    10,
    120,
  );
  auth.useLogger({ warn: () => undefined });

  let counter = 0;
  const claims = (token: string) => verifyAccessToken(token, tokenConfig);
  const row = async (sessionId: string) =>
    (
      await db.sql<Array<{ family_id: string; trusted_device_id: string | null }>>`
        SELECT family_id, trusted_device_id FROM sessions WHERE id = ${sessionId}
      `
    )[0]!;

  describe('fam and dev on identity access tokens', () => {
    it('sign-up names its family and device, and a refresh keeps both while sid moves on', async () => {
      const handle = `sc${process.pid}x${++counter}`;
      const signedUp = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
      const first = await claims(signedUp.accessToken);
      const stored = await row(signedUp.sessionId);
      expect(first.sid).toBe(signedUp.sessionId);
      expect(first.fam).toBe(stored.family_id);
      expect(stored.trusted_device_id).not.toBeNull();
      expect(first.dev).toBe(stored.trusted_device_id);

      const refreshed = await auth.refresh(signedUp.refreshToken);
      const second = await claims(refreshed.accessToken);
      expect(second.sid).not.toBe(first.sid);
      expect(second.fam).toBe(first.fam);
      expect(second.dev).toBe(first.dev);

      const again = await claims((await auth.refresh(refreshed.refreshToken)).accessToken);
      expect(again.fam).toBe(first.fam);
      expect(again.dev).toBe(first.dev);
    });

    it('a new sign-in is a new family; the same browser key keeps the device, another key does not', async () => {
      const handle = `sc${process.pid}x${++counter}`;
      const signedUp = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
      const first = await claims(signedUp.accessToken);

      const sameBrowser = await claims(
        (await auth.login({ identifier: handle, password: PASSWORD, deviceKey: signedUp.deviceKey })).accessToken,
      );
      expect(sameBrowser.fam).not.toBe(first.fam);
      expect(sameBrowser.dev).toBe(first.dev);

      const otherBrowser = await auth.login({ identifier: handle, password: PASSWORD, deviceKey: randomBytes(24).toString('base64url') });
      const other = await claims(otherBrowser.accessToken);
      expect(other.fam).not.toBe(first.fam);
      const otherDevice = (await row(otherBrowser.sessionId)).trusted_device_id;
      expect(otherDevice).not.toBeNull();
      expect(other.dev).toBe(otherDevice);
      expect(other.dev).not.toBe(first.dev);
    });

    it('a second tab inside the grace window and a lost reply recovered later both keep fam and dev', async () => {
      const handle = `sc${process.pid}x${++counter}`;
      const signedUp = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
      const first = await claims(signedUp.accessToken);
      expect(first.dev).toBeDefined();

      const rotated = await auth.refresh(signedUp.refreshToken);
      const secondTab = await auth.refresh(signedUp.refreshToken);
      expect(secondTab.sessionId).toBe(rotated.sessionId);
      const graced = await claims(secondTab.accessToken);
      expect(graced.fam).toBe(first.fam);
      expect(graced.dev).toBe(first.dev);

      await db.sql`UPDATE sessions SET rotated_at = ${new Date(Date.now() - 12_000)} WHERE id = ${signedUp.sessionId}`;
      const recovered = await auth.refresh(signedUp.refreshToken);
      expect(recovered.sessionId).toBe(rotated.sessionId);
      const late = await claims(recovered.accessToken);
      expect(late.fam).toBe(first.fam);
      expect(late.dev).toBe(first.dev);
    });
  });
}
