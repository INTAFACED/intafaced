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
import { createIdentityRouter } from './router.js';

/**
 * Payee search against real Postgres. Consent defaults off. Exact match only.
 * Frozen and a missing consent are the same miss as an unknown address.
 */

/** The shared env names database `test`. The harness only accepts a name ending in `_test`. `intafaced_test` is that database on the same server. */
function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const ADMIN_URL = dedicatedTestUrl(process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test');
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-payee-pg-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(ADMIN_URL);

if (!available) {
  describe.skip('payee search (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_payee',
    url: ADMIN_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  const router = createIdentityRouter(auth, rank, { registrationOpen: true });

  afterAll(async () => {
    await db.drop();
  });

  async function signUp(handle: string) {
    const session = await auth.register({
      handle,
      email: `${handle}@example.com`,
      password: 'correct horse battery staple',
      region: 'DE',
    });
    return session.userId;
  }

  async function as(userId: string) {
    const { token } = await issueAccessToken(
      { userId, sessionId: '44444444-4444-4444-8444-444444444444', scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
      tokenConfig,
    );
    const ctx: Context = { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
    return router.createCaller(ctx);
  }

  describe('identity.users.searchPayees (real Postgres)', () => {
    it('misses until the person opts in, then returns the handle and not the email', async () => {
      const sender = await signUp('Pay_Sender');
      const friend = await signUp('Pay_Friend');
      const api = await as(sender);
      const miss = await api.users.searchPayees({ email: 'pay_friend@example.com' });
      expect(miss).toEqual({ found: false });
      const friendApi = await as(friend);
      expect(await friendApi.users.setPayeeSearchConsent({ emailConsent: true })).toEqual({
        emailConsent: true,
        phoneConsent: false,
        phoneOnFile: false,
      });
      const hit = await api.users.searchPayees({ email: 'PAY_FRIEND@example.com' });
      expect(hit).toEqual({ found: true, userId: friend, handle: 'Pay_Friend', self: false });
      expect(hit).not.toHaveProperty('email');
    });

    it('matches an exact phone only with consent, and a frozen account is the same miss', async () => {
      const sender = await signUp('Phone_Sender');
      const friend = await signUp('Phone_Friend');
      const api = await as(sender);
      const friendApi = await as(friend);
      await friendApi.users.setPayeeSearchConsent({ phone: '+14155550100' });
      expect(await api.users.searchPayees({ phone: '+14155550100' })).toEqual({ found: false });
      await friendApi.users.setPayeeSearchConsent({ phoneConsent: true });
      expect(await api.users.searchPayees({ phone: '+14155550100' })).toEqual({
        found: true,
        userId: friend,
        handle: 'Phone_Friend',
        self: false,
      });
      expect(await api.users.searchPayees({ phone: '+14155550101' })).toEqual({ found: false });
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${friend}`;
      expect(await api.users.searchPayees({ phone: '+14155550100' })).toEqual({ found: false });
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM payee_search_audit WHERE user_id = ${friend}
      `;
      expect(audit.map((row) => row.event)).toContain('phone_set');
      const raw = JSON.stringify(audit);
      expect(raw).not.toContain('+14155550100');
    });
  });
}
