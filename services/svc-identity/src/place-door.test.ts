import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { AuthService } from './auth/auth-service.js';
import { bindApiKeyAccount } from './auth/bind-api-key-account.js';
import { bindApiKeyIpAllowlist } from './auth/auth-service-ip.js';
import { bindApiKeyOriginAllowlist } from './auth/auth-service-origin.js';
import { bindApiKeyProductScope } from './auth/auth-service-product.js';
import { PlaceDoor } from './auth/place-door.js';
import { RankService } from './rank/rank-service.js';
import { createNavigatorSessionStore } from './agents/navigator-session-store.js';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { API_KEY_OWNERSHIP_PATH, registerApiKeyOwnershipRoute } from './auth/api-key-ownership-route.js';

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
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 25);
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
        productScopes: [],
        originAllowlist: [],
        domainWhitelist: [],
        ipAllowlist: [],
      });
      await expect(door.assertApiKeyLive(created.id)).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
      const listed = await auth.listApiKeys(session.userId, 200);
      expect(listed[0]?.scopes).toEqual(['trade:read']);
    });

    it('assertApiKeyLive refuses empty or unknown without confirming existence', async () => {
      await expect(door.assertApiKeyLive('')).rejects.toMatchObject({ code: 'auth.api_key_denied' });
      await expect(door.assertApiKeyLive('00000000-0000-4000-8000-000000000099')).rejects.toMatchObject({
        code: 'auth.api_key_denied',
      });
      await expect(door.getApiKeyOwnership('00000000-0000-4000-8000-000000000099')).resolves.toBeNull();
    });

    it('ownership snapshot publishes stored binds; empty lists stay empty; no invented product/origin/account/clock; no scopes', async () => {
      const session = await register();
      const created = await auth.createApiKey({
        userId: session.userId,
        name: 'bot',
        scopes: ['trade:read'],
        grantorScopes: ['trade:read', 'trade:place'],
      });
      const open = await door.getApiKeyOwnership(created.id);
      expect(open).toEqual({
        id: created.id,
        userId: session.userId,
        revoked: false,
        productScopes: [],
        originAllowlist: [],
        domainWhitelist: [],
        ipAllowlist: [],
      });
      expect(open && 'accountId' in open).toBe(false);
      expect(open && 'expiresAt' in open).toBe(false);
      expect(open && 'scopes' in open).toBe(false);
      expect(open?.productScopes).not.toContain('trade');
      expect(open?.originAllowlist).not.toContain('localhost');

      const acc = await auth.createSubAccount(session.userId, 'mm', 'bot');
      const future = new Date(Date.now() + 86_400_000);
      const boundKey = await auth.createApiKey({
        userId: session.userId,
        name: 'bound',
        scopes: ['trade:read'],
        grantorScopes: ['trade:read', 'trade:place'],
        domainWhitelist: ['app.example.com'],
        expiresAt: future,
      });
      await bindApiKeyIpAllowlist(db.sql, session.userId, boundKey.id, ['203.0.113.10']);
      await bindApiKeyOriginAllowlist(db.sql, session.userId, boundKey.id, ['app.example.com']);
      await bindApiKeyProductScope(db.sql, session.userId, boundKey.id, ['trade'], ['trade:read', 'trade:place']);
      await bindApiKeyAccount(db.sql, session.userId, boundKey.id, acc.id);

      const snap = await door.getApiKeyOwnership(boundKey.id);
      expect(snap).toMatchObject({
        id: boundKey.id,
        userId: session.userId,
        revoked: false,
        productScopes: ['trade'],
        originAllowlist: ['app.example.com'],
        domainWhitelist: ['app.example.com'],
        ipAllowlist: ['203.0.113.10'],
        accountId: acc.id,
      });
      expect(snap?.expiresAt).toBeInstanceOf(Date);
      expect(snap?.expiresAt?.getTime()).toBe(future.getTime());
      expect(snap && 'scopes' in snap).toBe(false);

      await db.sql`UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = ${boundKey.id}`;
      const expired = await door.getApiKeyOwnership(boundKey.id);
      expect(expired?.revoked).toBe(true);
      expect(expired?.expiresAt).toBeInstanceOf(Date);
      expect(expired?.accountId).toBe(acc.id);
    });

    it('GET /internal/api-keys/:keyId returns the snapshot on the wire', async () => {
      const session = await register();
      const secret = 'an-identity-test-internal-secret-long-enough-for-hmac';
      const wsSecret = 'an-identity-private-read-secret-long-enough-for-hmac';
      const created = await auth.createApiKey({
        userId: session.userId,
        name: 'wire',
        scopes: ['trade:read'],
        grantorScopes: ['trade:read'],
        domainWhitelist: ['partner.example'],
      });
      await bindApiKeyIpAllowlist(db.sql, session.userId, created.id, ['2001:db8::1']);
      await bindApiKeyProductScope(db.sql, session.userId, created.id, ['trade'], ['trade:read']);
      const app = Fastify({ logger: false });
      registerApiKeyOwnershipRoute(app, { door, internalSecret: secret, privateAuthoritySecret: wsSecret });
      await app.ready();
      const res = await app.inject({
        method: 'GET',
        url: `${API_KEY_OWNERSHIP_PATH}/${created.id}`,
        headers: serviceAuthHeadersForBody('svc-ws', wsSecret, ''),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        id: created.id,
        userId: session.userId,
        revoked: false,
        productScopes: ['trade'],
        originAllowlist: ['partner.example'],
        domainWhitelist: ['partner.example'],
        ipAllowlist: ['2001:db8::1'],
      });
      expect(body).not.toHaveProperty('accountId');
      expect(body).not.toHaveProperty('expiresAt');
      expect(body).not.toHaveProperty('scopes');
      const missing = await app.inject({
        method: 'GET',
        url: `${API_KEY_OWNERSHIP_PATH}/00000000-0000-4000-8000-000000000099`,
        headers: serviceAuthHeadersForBody('svc-ws', wsSecret, ''),
      });
      expect(missing.statusCode).toBe(404);
      await app.close();
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
      await expect(
        store.publishSession({
          sessionId: session.sessionId,
          userId: session.userId,
          status: 'open',
        }),
      ).rejects.toMatchObject({ code: 'session_authority_denied' });
      // Inject a legacy stale projection; the production publisher refuses it.
      await db.sql`UPDATE navigator_session_projections SET status = 'open' WHERE session_id = ${session.sessionId}`;
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
