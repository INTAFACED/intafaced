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
      await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${friend}`;
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
      await db.sql`UPDATE users SET phone_verified_at = now() WHERE id = ${friend}`;
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

    it('does not find an unconfirmed email even when consent was forced on', async () => {
      const sender = await signUp('Mail_Sender');
      const hidden = await signUp('Hidden_Mail');
      const api = await as(sender);
      await db.sql`UPDATE users SET payee_email_consent = true WHERE id = ${hidden}`;
      expect(await api.users.searchPayees({ email: 'hidden_mail@example.com' })).toEqual({ found: false });
      await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${hidden}`;
      expect(await api.users.searchPayees({ email: 'hidden_mail@example.com' })).toEqual({
        found: true,
        userId: hidden,
        handle: 'Hidden_Mail',
        self: false,
      });
    });

    it('refuses email consent while the email is unconfirmed and writes nothing', async () => {
      const user = await signUp('Unconfirmed_Mail');
      const api = await as(user);
      await expect(api.users.setPayeeSearchConsent({ emailConsent: true })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'auth.payee_email_unconfirmed' },
      });
      const row = await db.sql<Array<{ payee_email_consent: boolean }>>`
        SELECT payee_email_consent FROM users WHERE id = ${user}
      `;
      expect(row[0]?.payee_email_consent).toBe(false);
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM payee_search_audit WHERE user_id = ${user}
      `;
      expect(audit).toEqual([]);
    });

    it('does not find a phone that has not been verified', async () => {
      const sender = await signUp('Unverified_Sender');
      const hidden = await signUp('Unverified_Phone');
      const api = await as(sender);
      const hiddenApi = await as(hidden);
      await hiddenApi.users.setPayeeSearchConsent({ phone: '+14155550199' });
      await db.sql`UPDATE users SET payee_phone_consent = true WHERE id = ${hidden}`;
      expect(await api.users.searchPayees({ phone: '+14155550199' })).toEqual({ found: false });
    });

    it('refuses phone consent while the phone is unverified', async () => {
      const user = await signUp('Phone_Unverified');
      const api = await as(user);
      await api.users.setPayeeSearchConsent({ phone: '+14155550188' });
      await expect(api.users.setPayeeSearchConsent({ phoneConsent: true })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: { code: 'auth.payee_phone_unverified' },
      });
    });

    it('lets two accounts store the same phone', async () => {
      const first = await as(await signUp('Phone_Twin_A'));
      const second = await as(await signUp('Phone_Twin_B'));
      await expect(first.users.setPayeeSearchConsent({ phone: '+14155550177' })).resolves.toMatchObject({ phoneOnFile: true });
      await expect(second.users.setPayeeSearchConsent({ phone: '+14155550177' })).resolves.toMatchObject({ phoneOnFile: true });
    });

    it('clears a phone when the caller sends null', async () => {
      const user = await signUp('Phone_Clear');
      const api = await as(user);
      await api.users.setPayeeSearchConsent({ phone: '+14155550166' });
      expect(await api.users.setPayeeSearchConsent({ phone: null })).toEqual({
        emailConsent: false,
        phoneConsent: false,
        phoneOnFile: false,
      });
      const audit = await db.sql<Array<{ event: string }>>`
        SELECT event FROM payee_search_audit WHERE user_id = ${user}
      `;
      expect(audit.map((row) => row.event)).toContain('phone_cleared');
    });
  });
}
