/**
 * Signing in with a recovery code against Postgres (I-signin-sessions-12, J-identity-05 #1): the code is accepted once
 * and spent, and the sign-in answer says how many codes are left. An authenticator code answers no count, a spent code
 * is refused like a wrong one, and the last code answers zero.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { AuthService } from './auth-service.js';
import { totp } from './totp.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-recovery-sign-in-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('recovery-code sign-in (Postgres unavailable)', () => {
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
  const api = createIdentityRouter(auth, rank, { registrationOpen: true });
  const signedOut: Context = { principal: null, service: null, region: 'DE', requestId: 'req-recovery-sign-in' };
  const anon = () => api.createCaller(signedOut);

  let n = 0;
  /** A TEST account with an authenticator, so it holds its recovery codes. */
  async function account() {
    const handle = `rs${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const started = await auth.startTotpEnrolment(session.userId, { mfa: false, privileged: false });
    await auth.confirmTotpEnrolment(session.userId, { mfa: false, privileged: false }, started.secret, totp(started.secret));
    return { handle, userId: session.userId, secret: started.secret, codes: started.recoveryCodes };
  }
  const codesLeft = async (userId: string) =>
    (await db.sql<Array<{ n: number }>>`SELECT jsonb_array_length(recovery_code_hashes) AS n FROM users WHERE id = ${userId}`)[0]!.n;

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('sign-in with a recovery code', () => {
    it('spends the code and answers how many are left; the same code is then refused', async () => {
      const a = await account();
      const all = a.codes.length;
      expect(all).toBeGreaterThan(1);
      const first = await anon().auth.login({ identifier: a.handle, password: PASSWORD, totpCode: a.codes[0]! });
      expect(first.userId).toBe(a.userId);
      expect(first.recoveryCodesLeft).toBe(all - 1);
      expect(await codesLeft(a.userId)).toBe(all - 1);
      await expect(anon().auth.login({ identifier: a.handle, password: PASSWORD, totpCode: a.codes[0]! })).rejects.toMatchObject({
        cause: { code: 'auth.mfa_invalid' },
      });
      expect(await codesLeft(a.userId)).toBe(all - 1);
      const second = await anon().auth.login({ identifier: a.handle, password: PASSWORD, totpCode: ` ${a.codes[1]!} ` });
      expect(second.recoveryCodesLeft).toBe(all - 2);
    });

    it('answers zero for the last code', async () => {
      const a = await account();
      for (const [i, code] of a.codes.entries()) {
        const session = await auth.login({ identifier: a.handle, password: PASSWORD, totpCode: code });
        expect(session.recoveryCodesLeft).toBe(a.codes.length - 1 - i);
      }
      expect(await codesLeft(a.userId)).toBe(0);
    });

    it('an authenticator code answers no count and spends no recovery code', async () => {
      const a = await account();
      await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${a.userId}`;
      const session = await anon().auth.login({ identifier: a.handle, password: PASSWORD, totpCode: totp(a.secret) });
      expect(session.userId).toBe(a.userId);
      expect(session).not.toHaveProperty('recoveryCodesLeft');
      expect(await codesLeft(a.userId)).toBe(a.codes.length);
    });

    it('a wrong code spends nothing and answers no count', async () => {
      const a = await account();
      await expect(auth.login({ identifier: a.handle, password: PASSWORD, totpCode: 'FFFFF-00000' })).rejects.toMatchObject({
        code: 'auth.mfa_invalid',
      });
      expect(await codesLeft(a.userId)).toBe(a.codes.length);
    });

    it('on a browser that still needs approval, the refusal carries the count, since the code is already spent', async () => {
      const a = await account();
      auth.usePasswordResetPolicy({ subjectKey: 'test-only-flow-subject-key-0123456789abcdef' });
      auth.useNewDevicePolicy({ check: true, flowTtlSeconds: 600, maxAttempts: 3 });
      try {
        const refused = await auth.login({ identifier: a.handle, password: PASSWORD, totpCode: a.codes[0]! }).then(
          () => null,
          (err: unknown) => err as { code?: string; details?: { deviceAuthorisation?: { recoveryCodesLeft?: number } } },
        );
        expect(refused?.code).toBe('auth.device_authorisation_required');
        expect(refused?.details?.deviceAuthorisation?.recoveryCodesLeft).toBe(a.codes.length - 1);
        expect(await codesLeft(a.userId)).toBe(a.codes.length - 1);
        // An authenticator code on a new browser: the same refusal, with no count.
        await db.sql`UPDATE users SET totp_last_step = NULL WHERE id = ${a.userId}`;
        const byApp = await auth.login({ identifier: a.handle, password: PASSWORD, totpCode: totp(a.secret) }).then(
          () => null,
          (err: unknown) => err as { code?: string; details?: { deviceAuthorisation?: Record<string, unknown> } },
        );
        expect(byApp?.code).toBe('auth.device_authorisation_required');
        expect(byApp?.details?.deviceAuthorisation).not.toHaveProperty('recoveryCodesLeft');
      } finally {
        auth.useNewDevicePolicy({ check: false });
        auth.usePasswordResetPolicy({});
      }
    });

    it('step-up with a recovery code still spends it (one shared list)', async () => {
      const a = await account();
      const session = await auth.login({ identifier: a.handle, password: PASSWORD, totpCode: a.codes[0]! });
      const { verifyAccessToken } = await import('@intafaced/auth');
      const principal = await verifyAccessToken(session.accessToken, tokenConfig);
      await auth.stepUp({ userId: a.userId, sessionId: principal.sid, totpCode: a.codes[1]! });
      expect(await codesLeft(a.userId)).toBe(a.codes.length - 2);
    });
  });
}
