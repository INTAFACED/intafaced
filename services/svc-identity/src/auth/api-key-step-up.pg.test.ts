/**
 * Creating, widening, or rotating an API key needs a fresh second factor.
 *
 * A session alone must not mint a key. A TOTP code from this minute does.
 * A proof older than five minutes does not. Tightening an IP list and
 * revoking a key do not ask for a factor. A sub-account or an API key cannot mint.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createApiKeyIpRouter } from '../api-key-ip-router.js';
import { createApiKeyProductRouter } from '../api-key-product-router.js';
import { createApiKeyRotateRouter } from '../api-key-rotate-router.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { createIdentityRouter } from '../router.js';
import { AuthService } from './auth-service.js';
import { totp } from './totp.js';
import { RankService } from '../rank/rank-service.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.length > 0 && !name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const tokenConfig = {
  secret: 'an-identity-api-key-step-up-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

function totpAhead(secret: string, stepsAhead: number): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + stepsAhead) * step * 1000) });
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('api key step-up (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, randomBytes(32).toString('base64'), undefined, undefined, 25);
  await rank.seedTiers();

  let n = 0;
  const unique = () => `ks${process.pid}${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function register() {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  }

  async function enrolTotp(userId: string) {
    const started = await auth.startTotpEnrolment(userId, PASSWORD_SESSION);
    await auth.confirmTotpEnrolment(userId, PASSWORD_SESSION, started.secret, totp(started.secret));
    return started;
  }

  async function door(accessToken: string) {
    const principal = await verifyAccessToken(accessToken, tokenConfig);
    const ctx = { principal, service: null, region: 'DE', requestId: 'keystepup' };
    return {
      principal,
      api: createIdentityRouter(auth, rank, { registrationOpen: true }).createCaller(ctx),
      ip: createApiKeyIpRouter(db.sql, auth).createCaller(ctx),
      product: createApiKeyProductRouter(db.sql, auth).createCaller(ctx),
      rotate: createApiKeyRotateRouter(db.sql, auth).createCaller(ctx),
    };
  }

  async function liveKeys(userId: string): Promise<string> {
    const rows = await db.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM api_keys WHERE user_id = ${userId} AND revoked = false
    `;
    return rows[0]?.n ?? '0';
  }

  describe('api key fresh factor', () => {
    it('refuses create without a fresh factor and mints nothing', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const { api } = await door(session.accessToken);
      const err = await api.apiKeys.create({ name: 'bot', scopes: ['trade:read'] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((err as Error).message).toMatch(/auth\.step_up_required/);
      expect((err as Error).message).toBe("Confirm it's you with a passkey or authenticator code. [auth.step_up_required]");
      expect(await liveKeys(session.userId)).toBe('0');
    });

    it('creates a trade key from a fresh authenticator code and audits the mint', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const { api } = await door(session.accessToken);
      const created = await api.apiKeys.create({
        name: 'bot',
        scopes: ['trade:read'],
        factorProof: { totpCode: totpAhead(secret, 1) },
      });
      expect(created.scopes).toEqual(['trade:read']);
      expect(created.key.length).toBeGreaterThan(8);
      expect(await liveKeys(session.userId)).toBe('1');
      const audit = await db.sql<Array<{ factor: string; scopes: string[] }>>`
        SELECT factor, scopes FROM api_key_create_audit WHERE key_id = ${created.id}
      `;
      expect(audit).toEqual([{ factor: 'totp', scopes: ['trade:read'] }]);
    });

    it('refuses a factor proof older than five minutes and mints nothing', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const proofId = randomUUID();
      await db.sql`
        INSERT INTO pay_step_up_proofs (proof_id, user_id, session_id, method, verified_at, expires_at)
        VALUES (
          ${proofId},
          ${session.userId},
          ${session.sessionId},
          'totp',
          ${new Date(Date.now() - 6 * 60 * 1000)},
          ${new Date(Date.now() - 60 * 1000)}
        )
      `;
      const { api } = await door(session.accessToken);
      const err = await api.apiKeys.create({ name: 'bot', scopes: ['trade:read'], factorProof: { proofId } }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((err as Error).message).toBe('That confirmation expired. Confirm again. [auth.step_up_expired]');
      expect(await liveKeys(session.userId)).toBe('0');
    });

    it('refuses allowlist widening without a fresh factor and leaves the list', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const { api, ip } = await door(session.accessToken);
      const created = await api.apiKeys.create({
        name: 'bot',
        scopes: ['trade:read'],
        factorProof: { totpCode: totpAhead(secret, 1) },
      });
      await ip.bindApiKeyIpAllowlist({ keyId: created.id, ips: ['203.0.113.10'] });
      const err = await ip.bindApiKeyIpAllowlist({ keyId: created.id, ips: ['203.0.113.10', '203.0.113.11'] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((err as Error).message).toMatch(/auth\.step_up_required/);
      const rows = await db.sql<Array<{ ip_allowlist: string[] }>>`
        SELECT ip_allowlist FROM api_keys WHERE id = ${created.id}
      `;
      expect(rows[0]?.ip_allowlist).toEqual(['203.0.113.10']);
    });

    it('revokes a key without a fresh factor', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const { api } = await door(session.accessToken);
      const created = await api.apiKeys.create({
        name: 'bot',
        scopes: ['trade:read'],
        factorProof: { totpCode: totpAhead(secret, 1) },
      });
      await expect(api.apiKeys.revoke({ keyId: created.id })).resolves.toEqual({ revoked: true });
      expect(await liveKeys(session.userId)).toBe('0');
    });

    it('refuses a sub-account and an API key, and mints nothing', async () => {
      const session = await register();
      await enrolTotp(session.userId);
      const sub = await issueAccessToken(
        {
          userId: session.userId,
          sessionId: session.sessionId,
          scopes: ['identity:write', 'trade:read'],
          tier: 'none',
          mfa: true,
          subAccountId: randomUUID(),
        },
        tokenConfig,
      );
      const key = await issueAccessToken(
        {
          userId: session.userId,
          sessionId: session.sessionId,
          scopes: ['identity:write', 'trade:read'],
          tier: 'none',
          mfa: true,
          apiKeyId: randomUUID(),
        },
        tokenConfig,
      );
      const subDoor = await door(sub.token);
      const keyDoor = await door(key.token);
      const subErr = await subDoor.api.apiKeys.create({ name: 'bot', scopes: ['trade:read'] }).catch((e: unknown) => e);
      const keyErr = await keyDoor.api.apiKeys.create({ name: 'bot', scopes: ['trade:read'] }).catch((e: unknown) => e);
      expect(subErr).toMatchObject({ code: 'FORBIDDEN' });
      expect((subErr as Error).message).toMatch(/cannot create keys/);
      expect(keyErr).toMatchObject({ code: 'FORBIDDEN' });
      expect((keyErr as Error).message).toMatch(/cannot grant further/);
      expect(await liveKeys(session.userId)).toBe('0');
    });

    it('refuses a product scope change without a fresh factor', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const { api, product } = await door(session.accessToken);
      const created = await api.apiKeys.create({
        name: 'bot',
        scopes: ['trade:read'],
        factorProof: { totpCode: totpAhead(secret, 1) },
      });
      const err = await product.bindApiKeyProductScope({ keyId: created.id, products: ['trade'] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((err as Error).message).toMatch(/auth\.step_up_required/);
      const rows = await db.sql<Array<{ product_scopes: string[] }>>`
        SELECT product_scopes FROM api_keys WHERE id = ${created.id}
      `;
      expect(rows[0]?.product_scopes).toEqual([]);
    });

    it('refuses rotating a key secret without a fresh factor', async () => {
      const session = await register();
      const { secret } = await enrolTotp(session.userId);
      const { api, rotate } = await door(session.accessToken);
      const created = await api.apiKeys.create({
        name: 'bot',
        scopes: ['trade:read'],
        factorProof: { totpCode: totpAhead(secret, 1) },
      });
      const err = await rotate.rotateApiKey({ keyId: created.id }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect((err as Error).message).toMatch(/auth\.step_up_required/);
      const rows = await db.sql<Array<{ id: string }>>`
        SELECT id FROM api_keys WHERE user_id = ${session.userId} AND revoked = false
      `;
      expect(rows.map((row) => row.id)).toEqual([created.id]);
    });
  });
}
