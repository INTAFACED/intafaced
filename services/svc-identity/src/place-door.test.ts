import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { AuthService } from './auth/auth-service.js';
import { PlaceDoor } from './auth/place-door.js';
import { RankService } from './rank/rank-service.js';
import { createNavigatorSessionStore } from './agents/navigator-session-store.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('place door (Postgres unavailable)', () => {
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
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  const door = new PlaceDoor(db.sql);
  await rank.seedTiers();

  let counter = 0;
  const unique = () => `p${process.pid}${++counter}`;
  const register = () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('place door — API key', () => {
    it('assertApiKeyLive refuses a revoked key without flattening scopes', async () => {
      const session = await register();
      const created = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read'],
        grantorScopes: ['trade:read', 'trade:place'],
      });
      await expect(door.assertApiKeyLive(created.id)).resolves.toEqual({ id: created.id, userId: session.userId });
      await expect(auth.revokeApiKey(session.userId, created.id)).resolves.toBe(true);
      await expect(door.getApiKeyOwnership(created.id)).resolves.toEqual({
        id: created.id,
        userId: session.userId,
        revoked: true,
      });
      await expect(door.assertApiKeyLive(created.id)).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
      const listed = await auth.listApiKeys(session.userId);
      expect(listed[0]?.scopes).toEqual(['trade:read']);
    });

    it('assertApiKeyLive refuses empty or unknown without confirming existence', async () => {
      await expect(door.assertApiKeyLive('')).rejects.toMatchObject({ code: 'auth.api_key_denied' });
      await expect(door.assertApiKeyLive('00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({
        code: 'auth.api_key_denied',
      });
      await expect(door.getApiKeyOwnership('00000000-0000-4000-8000-000000000099')).resolves.toBeNull();
    });
  });

  describe('place door — session', () => {
    it('assertSessionLive refuses after logout', async () => {
      const session = await register();
      await expect(door.assertSessionLive(session.sessionId)).resolves.toEqual({
        id: session.sessionId,
        userId: session.userId,
      });
      await auth.logout(session.refreshToken);
      await expect(door.getSessionOwnership(session.sessionId)).resolves.toEqual({
        id: session.sessionId,
        userId: session.userId,
        revoked: true,
      });
      await expect(door.assertSessionLive(session.sessionId)).rejects.toMatchObject({
        code: 'auth.session_revoked',
      });
    });

    it('assertSessionLive refuses empty or unknown without confirming existence', async () => {
      await expect(door.assertSessionLive('')).rejects.toMatchObject({ code: 'auth.session_denied' });
      await expect(door.assertSessionLive('00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({
        code: 'auth.session_denied',
      });
      await expect(door.getSessionOwnership('00000000-0000-4000-8000-000000000099')).resolves.toBeNull();
    });

    it('assertSessionLive treats an expired session as revoked', async () => {
      const session = await register();
      await db.sql`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = ${session.sessionId}`;
      await expect(door.assertSessionLive(session.sessionId)).rejects.toMatchObject({
        code: 'auth.session_revoked',
      });
    });

    it('readSession returns closed after logout even if the projection still says open', async () => {
      const session = await register();
      const store = createNavigatorSessionStore(db.sql);
      await store.publishSession({
        sessionId: session.sessionId,
        userId: session.userId,
        status: 'open',
      });
      await expect(store.readSession(session.sessionId)).resolves.toMatchObject({ status: 'open' });
      await auth.logout(session.refreshToken);
      await store.publishSession({
        sessionId: session.sessionId,
        userId: session.userId,
        status: 'open',
      });
      await expect(store.readSession(session.sessionId)).resolves.toMatchObject({
        sessionId: session.sessionId,
        userId: session.userId,
        status: 'closed',
      });
    });

    it('freezeIdentity does not leave a live navigator projection open', async () => {
      const session = await register();
      const store = createNavigatorSessionStore(db.sql);
      await store.publishSession({
        sessionId: session.sessionId,
        userId: session.userId,
        status: 'open',
      });
      await auth.freezeIdentity(session.userId);
      await expect(store.readSession(session.sessionId)).resolves.toMatchObject({ status: 'closed' });
    });
  });
}
