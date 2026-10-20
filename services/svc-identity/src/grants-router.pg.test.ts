import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { RankService } from './rank/rank-service.js';
import { createGrantsRouter } from './grants-router.js';

/** Connected apps against real Postgres: the user scoping and the revoke row update are SQL. */

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

if (!(await postgresAvailable(URL))) {
  describe.skip('connected apps (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_grants',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  const router = createGrantsRouter(db.sql);
  afterAll(async () => {
    await db.drop();
  });

  async function signUp(handle: string) {
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  }
  async function as(userId: string) {
    const { token } = await issueAccessToken(
      { userId, sessionId: '44444444-4444-4444-8444-444444444444', scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
      tokenConfig,
    );
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
    return router.createCaller(ctx);
  }
  const key = (userId: string, name: string, domainWhitelist?: string[]) =>
    auth.createApiKey({ userId, name, scopes: ['identity:read'], grantorScopes: [...SESSION_SCOPES], domainWhitelist });

  describe('connected apps and API access', () => {
    it("lists only the caller's live keys, says no OAuth grant can exist, and stops a revoked key", async () => {
      const me = await signUp('grantsme');
      const other = await signUp('grantsother');
      const first = await key(me, 'bot one', ['https://bot.example']);
      const second = await key(me, 'bot two');
      await key(other, 'not mine');
      const mine = await as(me);

      const listed = await mine.grants.list({ limit: 10 });
      expect(listed.apps.map((app) => app.name).sort()).toEqual(['bot one', 'bot two']);
      expect(listed.apps.find((app) => app.name === 'bot one')).toMatchObject({
        kind: 'api-key',
        originAllowlist: ['https://bot.example'],
      });
      expect(listed.oauth).toEqual({ grants: [], available: false, reason: 'no-third-party-app-can-be-authorised' });

      expect(await mine.grants.revoke({ keyId: first.id })).toEqual({ keyId: first.id, revoked: true, alreadyRevoked: false });
      expect((await mine.grants.list({ limit: 10 })).apps.map((app) => app.id)).toEqual([second.id]);
      await expect(auth.exchangeApiKey(first.key)).rejects.toBeTruthy();

      expect(await mine.grants.revoke({ keyId: first.id })).toEqual({ keyId: first.id, revoked: true, alreadyRevoked: true });
    });

    it("refuses another account's key and an unknown key the same way, and leaves the key live", async () => {
      const me = await signUp('grantsme2');
      const other = await signUp('grantsother2');
      const theirs = await key(other, 'theirs');
      const mine = await as(me);
      await expect(mine.grants.revoke({ keyId: theirs.id })).rejects.toMatchObject({ message: 'auth.not_found' });
      await expect(mine.grants.revoke({ keyId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({
        message: 'auth.not_found',
      });
      expect((await (await as(other)).grants.list({ limit: 10 })).apps).toHaveLength(1);
    });

    it('shows the honest empty state for an account with no keys', async () => {
      const me = await signUp('grantsnone');
      expect(await (await as(me)).grants.list({ limit: 10 })).toMatchObject({ apps: [], oauth: { available: false } });
    });
  });
}
