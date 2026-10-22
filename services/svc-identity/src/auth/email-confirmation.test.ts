import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, issueMerchantOnboardingScope, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { hashesEqual, isEmailConfirmed, publishedEmailConfirmRate, publishedEmailConfirmTtlSeconds } from './email-confirmation.js';
import { selectOnboardingUser } from './onboarding-user.js';
import { hashToken } from './passwords.js';
import { totp } from './totp.js';
import { stubActionApprovals } from './privileged-dual-control.js';
import { createIdentityRouter } from '../router.js';
import { RankService } from '../rank/rank-service.js';

/**
 * Email confirmation. 900 seconds and a budget of 2 are fixtures in this file,
 * not owner-published law.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:15491/intafaced_test';
const PASSWORD = 'correct horse battery staple';
const TTL = 900;
const T0 = Date.parse('2026-10-17T03:00:00.000Z');
const NO_FACTOR = { mfa: false, privileged: false } as const;

/** Enrol confirm burns the current step. The next sign-in uses the following step. */
function totpNext(secret: string): string {
  const step = 30;
  const counter = Math.floor(Math.floor(Date.now() / 1000) / step);
  return totp(secret, { at: new Date((counter + 1) * step * 1000) });
}

describe('email confirmation publication', () => {
  it('does not invent a lifetime or a rate budget', () => {
    expect(publishedEmailConfirmTtlSeconds(undefined)).toBeUndefined();
    expect(publishedEmailConfirmTtlSeconds(0)).toBeUndefined();
    expect(publishedEmailConfirmTtlSeconds(1.5)).toBeUndefined();
    expect(publishedEmailConfirmTtlSeconds(86_401)).toBeUndefined();
    expect(publishedEmailConfirmTtlSeconds(TTL)).toBe(TTL);
    expect(publishedEmailConfirmRate(undefined, 60)).toBeUndefined();
    expect(publishedEmailConfirmRate(2, undefined)).toBeUndefined();
    expect(publishedEmailConfirmRate(0, 60)).toBeUndefined();
    expect(publishedEmailConfirmRate(2, 60)).toEqual({ max: 2, windowSeconds: 60 });
  });

  it('treats a missing or junk stamp as not confirmed', () => {
    expect(isEmailConfirmed({})).toBe(false);
    expect(isEmailConfirmed({ email_verified_at: null })).toBe(false);
    expect(isEmailConfirmed({ email_verified_at: '' })).toBe(false);
    expect(isEmailConfirmed({ email_verified_at: 'not-a-date' })).toBe(false);
    expect(isEmailConfirmed({ email_verified_at: new Date('2026-10-17T00:00:00.000Z') })).toBe(true);
    expect(isEmailConfirmed({ email_verified_at: '2026-10-17T00:00:00.000Z' })).toBe(true);
  });

  it('compares hashes in constant time and rejects a short value', () => {
    const hash = hashToken('token-a');
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, hashToken('token-b'))).toBe(false);
    expect(hashesEqual('abcd', hash)).toBe(false);
  });
});

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
  describe.skip('auth email confirmation (Postgres unavailable)', () => {
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
  const keyMaterial = randomBytes(32).toString('base64');
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, keyMaterial, undefined, undefined, 25);
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  auth.useLogger({ warn: (obj, msg) => void warnings.push({ obj, msg }) });
  const router = createIdentityRouter(auth, rank, { registrationOpen: true, actionApprovals: stubActionApprovals() });

  const sent: Array<{ email: string; code: string; expiresAt: Date; purpose?: string }> = [];
  let failSend = false;
  let nowMs = T0;
  const mail = {
    async send(message: { email: string; code: string; expiresAt: Date; purpose?: string }) {
      sent.push(message);
      if (failSend) throw new Error('mail transport lost the reply');
    },
  };

  let counter = 0;
  const unique = () => `ec${process.pid}x${++counter}`;
  const register = async () => {
    const handle = unique();
    const email = `${handle}@example.com`;
    const session = await auth.register({ handle, email, password: PASSWORD });
    return { handle, email, ...session };
  };
  const asUser = async (accessToken: string) => {
    const principal = await verifyAccessToken(accessToken, tokenConfig);
    const ctx: Context = { principal, service: null, region: 'DE', requestId: 'req-confirm' };
    return router.createCaller(ctx);
  };
  const verifiedAt = async (userId: string) =>
    (await db.sql<Array<{ email_verified_at: Date | null }>>`SELECT email_verified_at FROM users WHERE id = ${userId}`)[0]
      ?.email_verified_at ?? null;
  const refusal = async (promise: Promise<unknown>) => {
    const err = (await promise.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; message?: string; cause?: { code?: string; details?: { retryAfterSeconds?: number } } } | undefined;
    expect(err).toBeDefined();
    return { trpc: err!.code, code: err!.cause?.code, message: err!.message, retryAfterSeconds: err!.cause?.details?.retryAfterSeconds };
  };

  beforeEach(async () => {
    bus.reset();
    warnings.length = 0;
    sent.length = 0;
    failSend = false;
    nowMs = T0;
    auth.useEmailConfirmation({ mail, ttlSeconds: TTL, rateMax: 5, rateWindowSeconds: 3600 });
    auth.useEmailConfirmationClock(() => new Date(nowMs));
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('auth email confirmation', () => {
    it('mails one hashed single-use token and identity.me reports emailVerified', async () => {
      const user = await register();
      const api = await asUser(user.accessToken);
      expect(await api.me()).toEqual({ userId: user.userId, handle: user.handle, emailVerified: false });

      const accepted = await api.auth.requestEmailConfirmation();
      expect(accepted).toEqual({ accepted: true });
      expect(JSON.stringify(accepted)).not.toContain(sent[0]?.code ?? 'missing-code');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ email: user.email, purpose: 'email-confirm' });
      const stored = await db.sql<Array<{ code_hash: string; email_hash: string }>>`
        SELECT code_hash, email_hash FROM email_confirmation_proofs WHERE user_id = ${user.userId}
      `;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.code_hash).toBe(hashToken(sent[0]!.code));
      expect(stored[0]!.code_hash).not.toBe(sent[0]!.code);
      expect(JSON.stringify(stored)).not.toContain(sent[0]!.code);

      const claimed: Array<{ userId: string; email: string }> = [];
      auth.useMerchantEmailInviteClaimer({
        async claim(input) {
          claimed.push(input);
        },
      });
      try {
        await api.auth.confirmEmail({ token: sent[0]!.code });
        expect(claimed).toEqual([{ userId: user.userId, email: user.email }]);
      } finally {
        auth.useMerchantEmailInviteClaimer(undefined);
      }
      expect(await verifiedAt(user.userId)).not.toBeNull();
      expect(await api.me()).toMatchObject({ emailVerified: true });
      const audit = await db.sql<Array<{ event: string; reason: string }>>`
        SELECT event, reason FROM email_confirmation_audit WHERE user_id = ${user.userId} ORDER BY event
      `;
      expect(audit).toEqual([
        { event: 'confirmed', reason: 'confirmed' },
        { event: 'requested', reason: 'issued' },
      ]);
      expect(JSON.stringify(audit)).not.toContain(sent[0]!.code);
      const columns = await db.sql<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'email_confirmation_audit' AND table_schema = current_schema()
      `;
      const names = columns.map((c) => c.column_name);
      expect(names).not.toContain('token');
      expect(names).not.toContain('code');
      expect(names).not.toContain('link');
    });

    it('refuses an expired, reused, rebound, or other-user token the same way', async () => {
      const user = await register();
      const other = await register();
      const api = await asUser(user.accessToken);
      await api.auth.requestEmailConfirmation();
      const token = sent[0]!.code;

      nowMs = T0 + (TTL + 1) * 1000;
      const expired = await refusal(api.auth.confirmEmail({ token }));
      expect(expired).toMatchObject({ trpc: 'BAD_REQUEST', code: 'auth.email_confirm_invalid' });
      expect(await verifiedAt(user.userId)).toBeNull();
      expect(JSON.stringify(expired)).not.toContain(token);

      nowMs = T0;
      sent.length = 0;
      await api.auth.requestEmailConfirmation();
      const live = sent[0]!.code;
      await api.auth.confirmEmail({ token: live });
      const again = await refusal(api.auth.confirmEmail({ token: live }));
      expect(again.code).toBe('auth.email_confirm_invalid');
      expect(await verifiedAt(other.userId)).toBeNull();

      sent.length = 0;
      const fresh = await register();
      const freshApi = await asUser(fresh.accessToken);
      await freshApi.auth.requestEmailConfirmation();
      const rebound = sent[0]!.code;
      await db.sql`
        UPDATE email_confirmation_proofs
        SET email_hash = ${hashToken('other@example.com')}
        WHERE user_id = ${fresh.userId} AND consumed_at IS NULL
      `;
      const mismatch = await refusal(freshApi.auth.confirmEmail({ token: rebound }));
      expect(mismatch.code).toBe('auth.email_confirm_invalid');
      expect(await verifiedAt(fresh.userId)).toBeNull();
      const reasons = await db.sql<Array<{ reason: string }>>`
        SELECT reason FROM email_confirmation_audit WHERE user_id = ${fresh.userId} AND event = 'refused'
      `;
      expect(reasons.map((r) => r.reason)).toContain('mismatch');
      expect(JSON.stringify(reasons)).not.toContain(rebound);
    });

    it('clears email_verified_at when the email changes and the old link cannot confirm the new address', async () => {
      const user = await register();
      const api = await asUser(user.accessToken);
      await api.auth.requestEmailConfirmation();
      await api.auth.confirmEmail({ token: sent[0]!.code });
      expect(await verifiedAt(user.userId)).not.toBeNull();

      await db.sql`UPDATE users SET email = ${'moved-' + user.email} WHERE id = ${user.userId}`;
      expect(await verifiedAt(user.userId)).toBeNull();

      sent.length = 0;
      await api.auth.requestEmailConfirmation();
      const rebound = sent[0]!.code;
      await db.sql`UPDATE users SET email = ${'again-' + user.email} WHERE id = ${user.userId}`;
      const open = await db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM email_confirmation_proofs
        WHERE user_id = ${user.userId} AND consumed_at IS NULL
      `;
      expect(open[0]!.n).toBe(0);
      const reused = await refusal(api.auth.confirmEmail({ token: rebound }));
      expect(reused.code).toBe('auth.email_confirm_invalid');
      expect(await verifiedAt(user.userId)).toBeNull();
      expect((await api.me()).emailVerified).toBe(false);
      expect(JSON.stringify(reused)).not.toContain(rebound);
    });

    it('rate-limits a signed-in caller and does not mail past the budget', async () => {
      const user = await register();
      auth.useEmailConfirmation({ mail, ttlSeconds: TTL, rateMax: 2, rateWindowSeconds: 3600 });
      const api = await asUser(user.accessToken);
      await api.auth.requestEmailConfirmation();
      await api.auth.requestEmailConfirmation();
      const limited = await refusal(api.auth.requestEmailConfirmation());
      expect(limited).toMatchObject({ trpc: 'TOO_MANY_REQUESTS', code: 'auth.email_confirm_rate_limited' });
      // The wait is the time until the oldest request leaves the hour.
      expect(limited.retryAfterSeconds).toBe(3600);
      expect(sent).toHaveLength(2);
      const proofs = await db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM email_confirmation_proofs WHERE user_id = ${user.userId}
      `;
      expect(proofs[0]!.n).toBe(2);
    });

    it('says the real wait after the owner lowers the budget: until enough requests leave the window', async () => {
      const user = await register();
      auth.useEmailConfirmation({ mail, ttlSeconds: TTL, rateMax: 3, rateWindowSeconds: 3600 });
      const api = await asUser(user.accessToken);
      for (const offset of [0, 100, 200]) {
        nowMs = T0 + offset * 1000;
        await api.auth.requestEmailConfirmation();
      }
      auth.useEmailConfirmation({ mail, ttlSeconds: TTL, rateMax: 2, rateWindowSeconds: 3600 });
      const limited = await refusal(api.auth.requestEmailConfirmation());
      // Two of three must leave before one more fits: the request at +100 s leaves at +3700 s, 3500 s from now.
      expect(limited).toMatchObject({ code: 'auth.email_confirm_rate_limited', retryAfterSeconds: 3500 });

      nowMs = T0 + 3_701_000;
      await expect(api.auth.requestEmailConfirmation()).resolves.toEqual({ accepted: true });
    });

    it('refuses when mail, lifetime, or the rate budget is unpublished, for every caller the same way', async () => {
      const user = await register();
      const api = await asUser(user.accessToken);
      auth.useEmailConfirmation({ mail: undefined, ttlSeconds: TTL, rateMax: 2, rateWindowSeconds: 60 });
      const noMail = await refusal(api.auth.requestEmailConfirmation());
      auth.useEmailConfirmation({ mail, ttlSeconds: undefined, rateMax: 2, rateWindowSeconds: 60 });
      const noTtl = await refusal(api.auth.requestEmailConfirmation());
      auth.useEmailConfirmation({ mail, ttlSeconds: TTL, rateMax: undefined, rateWindowSeconds: 60 });
      const noRate = await refusal(api.auth.requestEmailConfirmation());
      expect(noMail.code).toBe('auth.email_confirm_unwired');
      expect(noTtl.code).toBe(noMail.code);
      expect(noRate.code).toBe(noMail.code);
      expect(sent).toHaveLength(0);
      const proofs = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM email_confirmation_proofs`;
      expect(proofs[0]!.n).toBe(0);
    });

    it('answers a missing, frozen, or already-confirmed account with the same accepted body and no new link', async () => {
      const user = await register();
      const api = await asUser(user.accessToken);
      await api.auth.requestEmailConfirmation();
      await api.auth.confirmEmail({ token: sent[0]!.code });
      sent.length = 0;
      const again = await api.auth.requestEmailConfirmation();
      expect(again).toEqual({ accepted: true });
      expect(sent).toHaveLength(0);

      const frozen = await register();
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen.userId}`;
      const frozenApi = await asUser(frozen.accessToken);
      const frozenAccepted = await frozenApi.auth.requestEmailConfirmation();
      expect(frozenAccepted).toEqual({ accepted: true });
      const missing = await auth.requestEmailConfirmation({ userId: '99999999-9999-4999-8999-999999999999' });
      expect(missing).toEqual(frozenAccepted);
      const frozenProofs = await db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM email_confirmation_proofs WHERE user_id = ${frozen.userId}
      `;
      expect(frozenProofs[0]!.n).toBe(0);
    });

    it('keeps the proof when delivery throws and does not log the token', async () => {
      const user = await register();
      failSend = true;
      const api = await asUser(user.accessToken);
      await expect(api.auth.requestEmailConfirmation()).resolves.toEqual({ accepted: true });
      expect(sent).toHaveLength(1);
      const stored = await db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM email_confirmation_proofs WHERE user_id = ${user.userId}
      `;
      expect(stored[0]!.n).toBe(1);
      expect(JSON.stringify(warnings)).not.toContain(sent[0]!.code);
    });

    it('withholds pay:onboard until the real confirmation, then drops it when the email changes', async () => {
      const user = await register();
      const { secret } = await auth.startTotpEnrolment(user.userId, NO_FACTOR);
      await auth.confirmTotpEnrolment(user.userId, NO_FACTOR, secret, totp(secret));
      auth.useOwnerPayScopeSource(async (userId) => {
        const row = await selectOnboardingUser(db.sql, userId);
        if (!row) return [];
        return issueMerchantOnboardingScope({ user: row, merchant: null });
      });
      const scopesOf = async (accessToken: string) => (await verifyAccessToken(accessToken, tokenConfig)).scopes;
      try {
        expect(await selectOnboardingUser(db.sql, user.userId)).toMatchObject({
          accountStatus: 'active',
          emailVerified: false,
          secondFactorEnrolled: true,
        });
        const logged = await auth.login({ identifier: user.email, password: PASSWORD, totpCode: totpNext(secret) });
        expect(await scopesOf(logged.accessToken)).not.toContain('pay:onboard');

        const api = await asUser(logged.accessToken);
        await api.auth.requestEmailConfirmation();
        await api.auth.confirmEmail({ token: sent[0]!.code });
        expect(await selectOnboardingUser(db.sql, user.userId)).toMatchObject({ emailVerified: true });

        const refreshed = await auth.refresh(logged.refreshToken);
        const granted = await scopesOf(refreshed.accessToken);
        expect(granted).toContain('pay:onboard');
        expect(granted).not.toContain('pay:read');
        expect(granted).not.toContain('pay:write');
        expect(granted).not.toContain('pay:refund');
        expect(granted).not.toContain('pay:payout');

        await db.sql`UPDATE users SET email = ${'moved-' + user.email} WHERE id = ${user.userId}`;
        expect(await selectOnboardingUser(db.sql, user.userId)).toMatchObject({ emailVerified: false });
        const afterMove = await auth.refresh(refreshed.refreshToken);
        expect(await scopesOf(afterMove.accessToken)).not.toContain('pay:onboard');
        expect((await api.me()).emailVerified).toBe(false);
      } finally {
        auth.useOwnerPayScopeSource(null);
      }
    });

    it('refuses an API key', async () => {
      const user = await register();
      const { token } = await issueAccessToken(
        {
          userId: user.userId,
          sessionId: '44444444-4444-4444-8444-444444444444',
          scopes: ['identity:read'],
          tier: 'none',
          mfa: false,
          apiKeyId: '55555555-5555-4555-8555-555555555555',
        },
        tokenConfig,
      );
      const principal = await verifyAccessToken(token, tokenConfig);
      const api = router.createCaller({ principal, service: null, region: 'DE', requestId: 'req-key' });
      await expect(api.auth.requestEmailConfirmation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(sent).toHaveLength(0);
    });
  });
}
