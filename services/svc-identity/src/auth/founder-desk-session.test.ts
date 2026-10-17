import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService, type SessionTokens } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { totp } from './totp.js';

/**
 * Founder desk scopes on the tokens AuthService actually issues.
 *
 * Blank `IDENTITY_FOUNDER_SESSION_SCOPES` (the default this file leaves unset)
 * adds nothing. A directory that throws, or no directory at all, adds nothing.
 * `admin:treasury` is not grantable. The configured-grant cases live in
 * founder-session-scopes.pg.test.ts.
 *
 * The shared TEST_DATABASE_URL names database `test`. The suite guard only
 * accepts a name ending in `_test`, so this file uses `adminopsfix1_test` on
 * that server when it has to.
 */

const PASSWORD = 'correct horse battery staple';
const NO_FACTOR = { mfa: false, privileged: false } as const;
const DESK = ['support:ops', 'admin:read', 'admin:write', 'admin:treasury'] as const;

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
      await admin.unsafe('CREATE DATABASE adminopsfix1_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(raw);
    url.pathname = '/adminopsfix1_test';
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
  describe.skip('founder desk session scopes (Postgres unavailable)', () => {
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

  const decoded = async (accessToken: string): Promise<string[]> => {
    const principal = await verifyAccessToken(accessToken, tokenConfig);
    const scopes = [...principal.scopes];
    expect(scopes).not.toContain('admin:compliance');
    return scopes;
  };

  const register = async (service: AuthService = auth) => {
    const handle = `fd${process.pid}x${++counter}`;
    const session = await service.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    return { handle, ...session };
  };

  const enrolTotp = async (service: AuthService, userId: string) => {
    const { secret } = await service.startTotpEnrolment(userId, NO_FACTOR);
    await service.confirmTotpEnrolment(userId, NO_FACTOR, secret, totp(secret));
    return secret;
  };

  const loginMfa = (service: AuthService, handle: string, secret: string, at: number) =>
    service.login({ identifier: handle, password: PASSWORD, totpCode: totp(secret, { at: new Date(at) }) });

  const directoryOf = (answer: (userId: string) => boolean | Promise<boolean>) => ({
    isFounder: async (userId: string) => answer(userId),
  });

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
    auth = buildAuth();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('founder desk scopes on issued tokens', () => {
    it('a user the directory says is not a founder gets none of the four on an MFA login', async () => {
      auth.useFounderDirectory(directoryOf(() => false));
      const user = await register();
      const secret = await enrolTotp(auth, user.userId);
      const session = await loginMfa(auth, user.handle, secret, Date.now() + 30_000);
      const scopes = await decoded(session.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
    });

    it('a founder login without MFA gets none of the desk scopes when the config is blank', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf((id) => id === user.userId));
      const session = await auth.login({ identifier: user.handle, password: PASSWORD });
      const scopes = await decoded(session.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
    });

    it('a founder MFA login gets none of the desk scopes when the config is blank', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf((id) => id === user.userId));
      const secret = await enrolTotp(auth, user.userId);
      const session = await loginMfa(auth, user.handle, secret, Date.now() + 30_000);
      const scopes = await decoded(session.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
      expect(scopes).toEqual(expect.arrayContaining(['academy:read', 'agents:read', 'bank:read', 'token:read']));
    });

    it('a founder step-up does not receive desk scopes', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf((id) => id === user.userId));
      auth.useFounderSessionScopes({ scopes: ['admin:compliance', 'admin:write'], configValue: 'admin:compliance,admin:write' });
      const secret = await enrolTotp(auth, user.userId);
      const stepped = await auth.stepUp({
        userId: user.userId,
        sessionId: user.sessionId,
        totpCode: totp(secret, { at: new Date(Date.now() + 30_000) }),
      });
      const scopes = await decoded(stepped.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
      expect(scopes).toContain('trade:withdraw');
    });

    it('a directory whose isFounder throws adds none of the four', async () => {
      auth.useFounderDirectory({
        isFounder: async () => {
          throw new Error('founder directory unavailable');
        },
      });
      const user = await register();
      const secret = await enrolTotp(auth, user.userId);
      const session = await loginMfa(auth, user.handle, secret, Date.now() + 30_000);
      const scopes = await decoded(session.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
    });

    it('no directory — never installed — adds none of the four', async () => {
      const bare = buildAuth();
      const user = await register(bare);
      const secret = await enrolTotp(bare, user.userId);
      const session = await loginMfa(bare, user.handle, secret, Date.now() + 30_000);
      const scopes = await decoded(session.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
    });

    it('a directory cleared with undefined adds none of the four', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf(() => true));
      auth.useFounderDirectory(undefined);
      const secret = await enrolTotp(auth, user.userId);
      const session = await loginMfa(auth, user.handle, secret, Date.now() + 30_000);
      const scopes = await decoded(session.accessToken);
      for (const scope of DESK) expect(scopes).not.toContain(scope);
    });

    it('refresh of a founder session with mfa false keeps write and treasury off', async () => {
      const user = await register();
      auth.useFounderDirectory(directoryOf((id) => id === user.userId));
      const session: SessionTokens = await auth.login({ identifier: user.handle, password: PASSWORD });
      const refreshed = await auth.refresh(session.refreshToken);
      const principal = await verifyAccessToken(refreshed.accessToken, tokenConfig);
      expect(principal.mfa).toBe(false);
      const scopes = [...principal.scopes];
      for (const scope of DESK) expect(scopes).not.toContain(scope);
    });
  });
}
