import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { scopesForFounderSession, verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';
import { totp } from './totp.js';

/**
 * Configured founder-session scopes. Blank config is covered in
 * founder-desk-session.test.ts. This file sets IDENTITY_FOUNDER_SESSION_SCOPES
 * only on the AuthService under test, never in an env file.
 */

const PASSWORD = 'correct horse battery staple';
const NO_FACTOR = { mfa: false, privileged: false } as const;
const CONFIG = 'admin:compliance';
const CONFIG_HASH = createHash('sha256').update(CONFIG).digest('hex');

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

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  let target = raw;
  if (!name.endsWith('_test')) {
    const admin = postgres(raw, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe('CREATE DATABASE identbe_scopes_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(raw);
    url.pathname = '/identbe_scopes_test';
    target = url.toString();
  }
  const sql = postgres(target, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS citext');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await sql.end({ timeout: 5 });
  }
  return target;
}

const databaseUrl = await harnessUrl();

if (!databaseUrl) {
  describe.skip('founder session scopes (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: databaseUrl,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const keyMaterial = randomBytes(32).toString('base64');
  const buildAuth = () => new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, keyMaterial, undefined, undefined, 25);
  let auth = buildAuth();
  let counter = 0;

  const grant = () => auth.useFounderSessionScopes({ scopes: ['admin:compliance'], configValue: CONFIG });
  const directoryOf = (answer: (userId: string) => boolean) => ({ isFounder: async (userId: string) => answer(userId) });
  const scopesOf = async (accessToken: string) => [...(await verifyAccessToken(accessToken, tokenConfig)).scopes];

  const register = async () => {
    const handle = `fs${process.pid}x${++counter}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    return { handle, ...session };
  };
  const enrol = async (userId: string) => {
    const { secret } = await auth.startTotpEnrolment(userId, NO_FACTOR);
    await auth.confirmTotpEnrolment(userId, NO_FACTOR, secret, totp(secret));
    return secret;
  };
  const loginMfa = (handle: string, secret: string, at: number) =>
    auth.login({ identifier: handle, password: PASSWORD, totpCode: totp(secret, { at: new Date(at) }) });

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
    auth = buildAuth();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('configured founder session scopes', () => {
    it('gives a live MFA founder the configured scope and writes one audit row', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf((id) => id === user.userId));
      grant();
      const secret = await enrol(user.userId);
      const session = await loginMfa(user.handle, secret, Date.now() + 30_000);
      const scopes = await scopesOf(session.accessToken);
      expect(scopes).toContain('admin:compliance');
      expect(scopes).toEqual(expect.arrayContaining(['academy:read', 'agents:read', 'bank:read', 'token:read']));
      expect(scopes).not.toContain('admin:treasury');
      const rows = await db.sql<Array<{ scopes: string[]; config_hash: string }>>`
        SELECT scopes, config_hash FROM founder_session_scope_audit WHERE user_id = ${user.userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scopes).toEqual(['admin:compliance']);
      expect(rows[0]?.config_hash).toBe(CONFIG_HASH);
    });

    it('gives a non-founder, a non-MFA founder, a step-up and an API key nothing', async () => {
      const founder = await register();
      const other = await register();
      auth.useFounderDirectory(directoryOf((id) => id === founder.userId));
      grant();
      const plain = await auth.login({ identifier: founder.handle, password: PASSWORD });
      expect(await scopesOf(plain.accessToken)).not.toContain('admin:compliance');
      const secret = await enrol(founder.userId);

      const otherSecret = await enrol(other.userId);
      const otherSession = await loginMfa(other.handle, otherSecret, Date.now() + 30_000);
      expect(await scopesOf(otherSession.accessToken)).not.toContain('admin:compliance');
      const otherAudits = await db.sql<Array<{ audit_id: string }>>`
        SELECT audit_id FROM founder_session_scope_audit WHERE user_id = ${other.userId}
      `;
      expect(otherAudits).toHaveLength(0);

      const founderSession = await loginMfa(founder.handle, secret, Date.now() + 30_000);
      expect(await scopesOf(founderSession.accessToken)).toContain('admin:compliance');
      const held = await scopesOf(founderSession.accessToken);
      await expect(
        auth.createApiKey({ userId: founder.userId, name: 'desk', scopes: ['admin:compliance'], grantorScopes: held }),
      ).rejects.toThrow(/cannot be granted to an API key|Founder desk scopes/);
      const key = await auth.createApiKey({ userId: founder.userId, name: 'read', scopes: ['identity:read'], grantorScopes: held });
      const exchanged = await auth.exchangeApiKey(key.key);
      expect(exchanged.scopes).not.toContain('admin:compliance');
      expect(exchanged.scopes).toEqual(['identity:read']);

      expect(
        scopesForFounderSession(['identity:read'], { founder: true, mfa: true, subAccount: true, configured: ['admin:compliance'] }),
      ).not.toContain('admin:compliance');
    });

    it('drops the scope on the next refresh after the config is cleared', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf((id) => id === user.userId));
      grant();
      const secret = await enrol(user.userId);
      const session = await loginMfa(user.handle, secret, Date.now() + 30_000);
      expect(await scopesOf(session.accessToken)).toContain('admin:compliance');
      auth.useFounderSessionScopes({ scopes: [], configValue: '' });
      const refreshed = await auth.refresh(session.refreshToken);
      expect(await scopesOf(refreshed.accessToken)).not.toContain('admin:compliance');
      expect(await scopesOf(refreshed.accessToken)).toEqual(expect.arrayContaining(['academy:read', 'token:read']));
      const rows = await db.sql<Array<{ scopes: string[] }>>`
        SELECT scopes FROM founder_session_scope_audit WHERE user_id = ${user.userId} ORDER BY created_at ASC
      `;
      expect(rows.map((row) => row.scopes)).toEqual([['admin:compliance'], []]);
    });
  });
}
