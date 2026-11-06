import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseStaffTestRoster, STAFF_TEST_ROLE_NAMES, staffTestClaim, verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from './auth-service.js';
import { totp } from './totp.js';

/**
 * TEST staff sessions (OWNER 44): with the labelled TEST roster from the identity owner-values profile, each TEST
 * member's confirmed-email, second-factor session gets its role's TEST scopes and `staffTestStatus` names the role.
 * With no roster (production) nobody gets a staff scope and every role reads null.
 */

const PASSWORD = 'correct horse battery staple';
const NO_FACTOR = { mfa: false, privileged: false } as const;
const profile = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../tooling/profiles/test-owner-values/identity.json'), 'utf8'),
) as { values: Record<string, { value: string }> };
const ROSTER = parseStaffTestRoster(profile.values.IDENTITY_STAFF_TEST_ROSTER!.value, 'test')!;
const STAFF_SCOPES = ['admin:read', 'admin:write', 'admin:compliance', 'market:ops', 'support:ops', 'support:lookup', 'campaigns:ops'];

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
      await admin.unsafe('CREATE DATABASE identstaff_test_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(raw);
    url.pathname = '/identstaff_test_test';
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
  describe.skip('TEST staff sessions (Postgres unavailable)', () => {
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
  let counter = 0;

  /** A TEST staff account: `email`, its email confirmed (or not), and a confirmed authenticator. */
  async function staffAccount(auth: AuthService, email: string, confirmed = true) {
    const handle = `st${process.pid}x${++counter}`;
    const session = await auth.register({ handle, email, password: PASSWORD });
    if (confirmed) await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
    const { secret } = await auth.startTotpEnrolment(session.userId, NO_FACTOR);
    await auth.confirmTotpEnrolment(session.userId, NO_FACTOR, secret, totp(secret));
    return { handle, userId: session.userId, secret };
  }
  const login = (auth: AuthService, handle: string, secret?: string) =>
    auth.login({
      identifier: handle,
      password: PASSWORD,
      ...(secret ? { totpCode: totp(secret, { at: new Date(Date.now() + 30_000) }) } : {}),
    });
  const scopesOf = async (accessToken: string) => [...(await verifyAccessToken(accessToken, tokenConfig)).scopes];

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('the test stack admits each TEST role', () => {
    it.each(STAFF_TEST_ROLE_NAMES)('%s: a second-factor session gets exactly its TEST scopes, and its role reads back', async (role) => {
      const auth = buildAuth();
      auth.useStaffTestRoster(ROSTER);
      const who = await staffAccount(auth, `local-test-staff-${role}@local-test.invalid`);
      const session = await login(auth, who.handle, who.secret);
      const scopes = await scopesOf(session.accessToken);
      const granted = scopes.filter((s) => STAFF_SCOPES.includes(s));
      expect(granted.sort()).toEqual([...ROSTER.roles[role].sessionScopes].sort());
      expect(scopes).not.toContain('admin:treasury');
      expect(await auth.staffTestRole(who.userId)).toBe(role);
      // The role's TEST mapping rides on the token as the local staff permissions claim, on sign-in and on refresh.
      const claim = staffTestClaim(ROSTER, role)!;
      for (const token of [session.accessToken, (await auth.refresh(session.refreshToken)).accessToken]) {
        const principal = await verifyAccessToken(token, tokenConfig);
        expect(principal.staffEnv).toBe('local');
        expect(principal.staffPermissions).toEqual(claim.staffPermissions);
      }
    });

    it('gives a TEST member no staff scope and no claim on a session without a second factor', async () => {
      const auth = buildAuth();
      auth.useStaffTestRoster(ROSTER);
      const handle = `nf${process.pid}x${++counter}`;
      const { userId } = await auth.register({ handle, email: 'local-test-staff-finance@local-test.invalid', password: PASSWORD });
      await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId}`;
      expect(await auth.staffTestRole(userId)).toBe('finance');
      const principal = await verifyAccessToken((await login(auth, handle)).accessToken, tokenConfig);
      expect(principal.mfa).toBe(false);
      expect(principal.staffPermissions).toBeUndefined();
      expect(principal.scopes.filter((s) => STAFF_SCOPES.includes(s))).toEqual([]);
    });

    it('gives no staff scope to an unconfirmed email, or to someone not on the roster', async () => {
      const auth = buildAuth();
      auth.useStaffTestRoster(ROSTER);
      const unconfirmed = await staffAccount(auth, 'local-test-staff-support@local-test.invalid', false);
      expect(await auth.staffTestRole(unconfirmed.userId)).toBeNull();
      const scopes = await scopesOf((await login(auth, unconfirmed.handle, unconfirmed.secret)).accessToken);
      expect(scopes.filter((s) => STAFF_SCOPES.includes(s))).toEqual([]);
      const stranger = await staffAccount(auth, `stranger${counter}@local-test.invalid`);
      expect(await auth.staffTestRole(stranger.userId)).toBeNull();
      expect(
        (await scopesOf((await login(auth, stranger.handle, stranger.secret)).accessToken)).filter((s) => STAFF_SCOPES.includes(s)),
      ).toEqual([]);
    });
  });

  describe('production (no roster) admits no TEST role', () => {
    it.each(STAFF_TEST_ROLE_NAMES)('%s: no staff scope and no role', async (role) => {
      const auth = buildAuth();
      auth.useStaffTestRoster(undefined);
      const who = await staffAccount(auth, `local-test-staff-${role}@local-test.invalid`);
      const session = await login(auth, who.handle, who.secret);
      const scopes = await scopesOf(session.accessToken);
      expect(scopes.filter((s) => STAFF_SCOPES.includes(s))).toEqual([]);
      expect((await verifyAccessToken(session.accessToken, tokenConfig)).staffPermissions).toBeUndefined();
      expect(await auth.staffTestRole(who.userId)).toBeNull();
    });
  });
}
