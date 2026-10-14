import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { AuthService } from './auth-service.js';
import { ATTEMPT_POLICY } from './attempt-lockout.js';
import { RankService } from '../rank/rank-service.js';
import { createRecoveryRedeemRouter } from '../recovery-redeem-router.js';
import { totp } from './totp.js';
import { hashToken } from './passwords.js';
import { openLiveSessionAfterRecoveryCode } from './redeem-recovery-session.js';
import { enrollPasskeyAfterRecoveryCode } from './redeem-recovery-enroll.js';
import { mintApiKeyAfterRecoveryCode } from './redeem-recovery-mint.js';
import { rotateApiKeyAfterRecoveryCode } from './redeem-recovery-rotate.js';
import { revokeApiKeyAfterRecoveryCode } from './redeem-recovery-revoke-key.js';
import { revokeAllApiKeysAfterRecoveryCode } from './redeem-recovery-revoke-keys.js';
import { revokeOtherSessionsAfterRecoveryCode } from './redeem-recovery-revoke-sessions.js';

/**
 * Every recovery-code redemption path against real Postgres (own isolated schema).
 *
 * What these hold: a code is spent exactly once even when many redeems race for
 * it; every redemption is counted against the account's `mfa` attempt budget
 * BEFORE the code is read (so a locked account never even looks at a correct
 * code); a success clears the budget; a failed action hands the code back; the
 * session must be the caller's own; and the two routed procedures work end to end.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const PASSWORD = 'correct horse battery staple';
const PASSWORD_SESSION = { mfa: false, privileged: false } as const;
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
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
const GRANTOR = [...SESSION_SCOPES];
const WRONG = 'FFFFF-00000';

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('recovery-code redemption (Postgres unavailable)', () => {
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
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );
  await rank.seedTiers();

  let counter = 0;
  /** A user with TOTP enrolled (so it holds 10 recovery codes) and one live session. */
  const account = async () => {
    const handle = `rr${process.pid}x${++counter}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD });
    const { secret, recoveryCodes } = await auth.startTotpEnrolment(session.userId, PASSWORD_SESSION);
    await auth.confirmTotpEnrolment(session.userId, PASSWORD_SESSION, secret, totp(secret));
    const principal = await verifyAccessToken(session.accessToken, tokenConfig);
    return { userId: session.userId, sessionId: principal.sid, codes: recoveryCodes };
  };
  const hashesOf = async (userId: string) =>
    (await db.sql<Array<{ h: string[] }>>`SELECT recovery_code_hashes AS h FROM users WHERE id = ${userId}`)[0]!.h;
  const mfaRow = async (userId: string) =>
    (
      await db.sql<
        Array<{ failures: number; locked_until: Date | null }>
      >`SELECT failures, locked_until FROM auth_attempts WHERE user_id = ${userId} AND kind = 'mfa'`
    )[0];
  const keyCount = async (userId: string) =>
    Number((await db.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM api_keys WHERE user_id = ${userId}`)[0]!.n);
  const mint = (a: { userId: string; sessionId: string }, code: string) =>
    mintApiKeyAfterRecoveryCode(auth, db.sql, {
      userId: a.userId,
      sessionId: a.sessionId,
      code,
      name: 'desk',
      scopes: ['identity:read'],
      grantorScopes: GRANTOR,
    });
  const settle = (promises: Array<Promise<unknown>>) => Promise.allSettled(promises);

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('a code is spent exactly once', () => {
    it('four parallel mints with one code create exactly one key', async () => {
      const a = await account();
      const results = await settle([0, 1, 2, 3].map(() => mint(a, a.codes[0]!)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected')
          expect(['auth.recovery_invalid', 'auth.recovery_spent']).toContain((r.reason as { code: string }).code);
      }
      expect(await keyCount(a.userId)).toBe(1);
      expect(await hashesOf(a.userId)).toHaveLength(9);
      expect(await hashesOf(a.userId)).not.toContain(hashToken(a.codes[0]!));
    });

    it('four parallel session redeems with one code succeed once', async () => {
      const a = await account();
      const results = await settle(
        [0, 1, 2, 3].map(() => openLiveSessionAfterRecoveryCode(db.sql, { userId: a.userId, sessionId: a.sessionId, code: a.codes[0]! })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await hashesOf(a.userId)).toHaveLength(9);
    });

    it('a used code is refused the second time, and the other codes still work', async () => {
      const a = await account();
      await mint(a, a.codes[0]!);
      await expect(mint(a, a.codes[0]!)).rejects.toMatchObject({ code: 'auth.recovery_invalid' });
      await expect(mint(a, a.codes[1]!)).resolves.toMatchObject({ prefix: expect.any(String) });
      expect(await keyCount(a.userId)).toBe(2);
    });

    it('answers recovery_spent once no code is left', async () => {
      const a = await account();
      await db.sql`UPDATE users SET recovery_code_hashes = '[]'::jsonb WHERE id = ${a.userId}`;
      await expect(mint(a, a.codes[0]!)).rejects.toMatchObject({ code: 'auth.recovery_spent' });
    });

    it('refuses a missing code without counting an attempt', async () => {
      const a = await account();
      await expect(mint(a, '   ')).rejects.toMatchObject({ code: 'auth.recovery_missing' });
      expect(await mfaRow(a.userId)).toBeUndefined();
    });

    it('a code redeemed at sign-in step-up is also gone for the recovery modules (one shared list)', async () => {
      const a = await account();
      await auth.stepUp({ userId: a.userId, sessionId: a.sessionId, totpCode: a.codes[0]! });
      await expect(mint(a, a.codes[0]!)).rejects.toMatchObject({ code: 'auth.recovery_invalid' });
    });
  });

  describe('tryRedeemRecoveryCode (login / step-up fallback) is atomic too', () => {
    it('four parallel step-ups with one recovery code succeed once', async () => {
      const a = await account();
      const results = await settle(
        [0, 1, 2, 3].map(() => auth.stepUp({ userId: a.userId, sessionId: a.sessionId, totpCode: a.codes[0]! })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await hashesOf(a.userId)).toHaveLength(9);
    });
  });

  describe('lockout', () => {
    it('locks after the policy number of wrong codes and then refuses even the right one, unspent', async () => {
      const a = await account();
      for (let i = 0; i < ATTEMPT_POLICY.mfa.maxFailures; i++) {
        await expect(mint(a, WRONG)).rejects.toMatchObject({ code: 'auth.recovery_invalid' });
      }
      await expect(mint(a, a.codes[0]!)).rejects.toMatchObject({ code: 'auth.too_many_attempts' });
      expect(await keyCount(a.userId)).toBe(0);
      expect(await hashesOf(a.userId)).toContain(hashToken(a.codes[0]!));
    });

    it('shares the budget with login step-up: wrong step-up codes lock the recovery modules', async () => {
      const a = await account();
      for (let i = 0; i < ATTEMPT_POLICY.mfa.maxFailures; i++) {
        await expect(auth.stepUp({ userId: a.userId, sessionId: a.sessionId, totpCode: WRONG })).rejects.toMatchObject({
          code: 'auth.mfa_invalid',
        });
      }
      await expect(revokeAllApiKeysAfterRecoveryCode(db.sql, { userId: a.userId, code: a.codes[0]! })).rejects.toMatchObject({
        code: 'auth.too_many_attempts',
      });
    });

    it('a success clears the attempts', async () => {
      const a = await account();
      await expect(mint(a, WRONG)).rejects.toMatchObject({ code: 'auth.recovery_invalid' });
      await expect(mint(a, WRONG)).rejects.toMatchObject({ code: 'auth.recovery_invalid' });
      expect((await mfaRow(a.userId))?.failures).toBe(2);
      await mint(a, a.codes[0]!);
      expect(await mfaRow(a.userId)).toBeUndefined();
    });
  });

  describe('a failed action hands the code back', () => {
    it('rotating an unknown key leaves the code spendable', async () => {
      const a = await account();
      await expect(
        rotateApiKeyAfterRecoveryCode(auth, db.sql, {
          userId: a.userId,
          sessionId: a.sessionId,
          keyId: randomUUID(),
          code: a.codes[0]!,
          grantorScopes: GRANTOR,
        }),
      ).rejects.toMatchObject({ code: 'auth.not_found' });
      expect(await hashesOf(a.userId)).toContain(hashToken(a.codes[0]!));
      await expect(mint(a, a.codes[0]!)).resolves.toBeTruthy();
    });

    it('revoking an unknown key leaves the code spendable', async () => {
      const a = await account();
      await expect(
        revokeApiKeyAfterRecoveryCode(auth, db.sql, { userId: a.userId, sessionId: a.sessionId, keyId: randomUUID(), code: a.codes[0]! }),
      ).rejects.toMatchObject({ code: 'auth.not_found' });
      expect(await hashesOf(a.userId)).toHaveLength(10);
    });
  });

  describe('the session must be the caller own, live session', () => {
    it('refuses another user session before touching the code or the budget', async () => {
      const a = await account();
      const b = await account();
      await expect(mint({ userId: a.userId, sessionId: b.sessionId }, a.codes[0]!)).rejects.toMatchObject({ code: 'auth.session_denied' });
      expect(await mfaRow(a.userId)).toBeUndefined();
      expect(await hashesOf(a.userId)).toHaveLength(10);
    });

    it('refuses a revoked session', async () => {
      const a = await account();
      await db.sql`UPDATE sessions SET revoked = true WHERE id = ${a.sessionId}`;
      await expect(mint(a, a.codes[0]!)).rejects.toMatchObject({ code: 'auth.session_revoked' });
      expect(await hashesOf(a.userId)).toHaveLength(10);
    });
  });

  describe('each module, happy path', () => {
    it('session: returns the existing live session and burns the code', async () => {
      const a = await account();
      await expect(
        openLiveSessionAfterRecoveryCode(db.sql, { userId: a.userId, sessionId: a.sessionId, code: a.codes[0]! }),
      ).resolves.toEqual({ id: a.sessionId, userId: a.userId });
      expect(await hashesOf(a.userId)).toHaveLength(9);
    });

    it('enroll: appends the credential and burns the code', async () => {
      const a = await account();
      const cred = { credentialId: 'cred-1', publicKey: 'pk', counter: 0, createdAt: new Date().toISOString() };
      await expect(enrollPasskeyAfterRecoveryCode(db.sql, { userId: a.userId, code: a.codes[0]!, cred })).resolves.toEqual({
        credentialId: 'cred-1',
      });
      const rows = await db.sql<
        Array<{ c: Array<{ credentialId: string }> }>
      >`SELECT webauthn_creds AS c FROM users WHERE id = ${a.userId}`;
      expect(rows[0]!.c.map((c) => c.credentialId)).toContain('cred-1');
      expect(await hashesOf(a.userId)).toHaveLength(9);
    });

    it('mint, rotate, revoke-key, revoke-keys', async () => {
      const a = await account();
      const minted = await mint(a, a.codes[0]!);
      expect(minted.sessionId).toBe(a.sessionId);
      const rotated = await rotateApiKeyAfterRecoveryCode(auth, db.sql, {
        userId: a.userId,
        sessionId: a.sessionId,
        keyId: minted.id,
        code: a.codes[1]!,
        grantorScopes: GRANTOR,
      });
      expect(rotated.revokedKeyId).toBe(minted.id);
      await expect(
        revokeApiKeyAfterRecoveryCode(auth, db.sql, { userId: a.userId, sessionId: a.sessionId, keyId: rotated.id, code: a.codes[2]! }),
      ).resolves.toEqual({ revokedKeyId: rotated.id, sessionId: a.sessionId });
      await mint(a, a.codes[3]!);
      await expect(revokeAllApiKeysAfterRecoveryCode(db.sql, { userId: a.userId, code: a.codes[4]! })).resolves.toEqual({
        userId: a.userId,
        revoked: 1,
      });
      expect(await hashesOf(a.userId)).toHaveLength(5);
    });

    it('revoke-sessions: keeps the recovered session, closes the rest', async () => {
      const a = await account();
      const other = await auth.login({
        identifier: (await db.sql<Array<{ handle: string }>>`SELECT handle FROM users WHERE id = ${a.userId}`)[0]!.handle,
        password: PASSWORD,
        totpCode: a.codes[9]!,
      });
      expect(other.userId).toBe(a.userId);
      const out = await revokeOtherSessionsAfterRecoveryCode(db.sql, { userId: a.userId, sessionId: a.sessionId, code: a.codes[0]! });
      expect(out).toMatchObject({ sessionId: a.sessionId, revoked: 1 });
      const live = await db.sql<Array<{ id: string }>>`SELECT id FROM sessions WHERE user_id = ${a.userId} AND revoked = false`;
      expect(live.map((s) => s.id)).toEqual([a.sessionId]);
    });
  });

  describe('routed procedures end to end', () => {
    const api = createRecoveryRedeemRouter(db.sql, auth);
    const ctx = async (a: { userId: string; sessionId: string }, opts: { apiKeyId?: string } = {}): Promise<Context> => {
      const { token } = await issueAccessToken(
        {
          userId: a.userId,
          sessionId: a.sessionId,
          scopes: [...SESSION_SCOPES],
          tier: 'none',
          mfa: false,
          ...(opts.apiKeyId ? { apiKeyId: opts.apiKeyId } : {}),
        },
        tokenConfig,
      );
      return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'req-1' };
    };
    const caller = async (a: { userId: string; sessionId: string }, opts?: { apiKeyId?: string }) => api.createCaller(await ctx(a, opts));
    const mintInput = (code: string) => ({ recoveryCode: code, name: 'desk', scopes: ['identity:read'] });

    it('mintApiKeyWithRecoveryCode mints a key, spends the code, clears the budget', async () => {
      const a = await account();
      const c = await caller(a);
      await expect(c.mintApiKeyWithRecoveryCode(mintInput(WRONG))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      const out = await c.mintApiKeyWithRecoveryCode(mintInput(a.codes[0]!));
      expect(out.key).toMatch(/^if/);
      expect(await keyCount(a.userId)).toBe(1);
      expect(await hashesOf(a.userId)).toHaveLength(9);
      expect(await mfaRow(a.userId)).toBeUndefined();
    });

    it('rotateApiKeyWithRecoveryCode rotates and a replay of the code is refused', async () => {
      const a = await account();
      const c = await caller(a);
      const first = await c.mintApiKeyWithRecoveryCode(mintInput(a.codes[0]!));
      const rotated = await c.rotateApiKeyWithRecoveryCode({ recoveryCode: a.codes[1]!, keyId: first.id });
      expect(rotated.revokedKeyId).toBe(first.id);
      await expect(c.rotateApiKeyWithRecoveryCode({ recoveryCode: a.codes[1]!, keyId: rotated.id })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      await expect(c.rotateApiKeyWithRecoveryCode({ recoveryCode: a.codes[2]!, keyId: randomUUID() })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('parallel route calls with one code succeed once', async () => {
      const a = await account();
      const c = await caller(a);
      const results = await settle([0, 1, 2, 3].map(() => c.mintApiKeyWithRecoveryCode(mintInput(a.codes[0]!))));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await keyCount(a.userId)).toBe(1);
    });

    it('answers TOO_MANY_REQUESTS once locked', async () => {
      const a = await account();
      const c = await caller(a);
      for (let i = 0; i < ATTEMPT_POLICY.mfa.maxFailures; i++) {
        await expect(c.mintApiKeyWithRecoveryCode(mintInput(WRONG))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
      await expect(c.mintApiKeyWithRecoveryCode(mintInput(a.codes[0]!))).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(await hashesOf(a.userId)).toHaveLength(10);
    });

    it('refuses an API-key principal and does not touch the code', async () => {
      const a = await account();
      const c = await caller(a, { apiKeyId: randomUUID() });
      await expect(c.mintApiKeyWithRecoveryCode(mintInput(a.codes[0]!))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(c.rotateApiKeyWithRecoveryCode({ recoveryCode: a.codes[0]!, keyId: randomUUID() })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await hashesOf(a.userId)).toHaveLength(10);
      expect(await mfaRow(a.userId)).toBeUndefined();
    });

    it('rejects a malformed recovery code at the door', async () => {
      const a = await account();
      const c = await caller(a);
      await expect(c.mintApiKeyWithRecoveryCode(mintInput('not-a-code'))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
}
