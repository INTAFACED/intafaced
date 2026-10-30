import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { createHandleRouter } from './handle-router.js';
import { HandleSettingsService } from './handle-settings.js';
import { createPayQrRouter } from './pay-qr-router.js';
import { PayQrService } from './pay-qr.js';

/**
 * Signed pay QR (PP-send-request-11) against real Postgres: a scan finds the payee by account id when their handle
 * cannot be found, a tampered code and a blank key refuse with their own codes, and the payee's record reads the same
 * after every refusal.
 */

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const ADMIN_URL = dedicatedTestUrl(process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test');
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-pay-qr-pg-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const KEY = 'a-pay-qr-pg-test-key-that-is-long-enough';

const available = await postgresAvailable(ADMIN_URL);

if (!available) {
  describe.skip('pay QR (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_pay_qr',
    url: ADMIN_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig);
  const router = mergeRouters(
    createIdentityRouter(auth, rank, { registrationOpen: true }),
    createHandleRouter(new HandleSettingsService(db.sql, 2)),
    createPayQrRouter(new PayQrService(db.sql, KEY)),
  );
  const blankKey = createPayQrRouter(new PayQrService(db.sql, null));

  afterAll(async () => {
    await db.drop();
  });

  async function signUp(handle: string) {
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return { userId: session.userId, sessionId: session.sessionId };
  }

  async function ctxOf(who: { userId: string; sessionId: string }): Promise<Context> {
    const { token } = await issueAccessToken(
      { userId: who.userId, sessionId: who.sessionId, scopes: [...SESSION_SCOPES], tier: 'none', mfa: true },
      tokenConfig,
    );
    return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
  }

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: { code?: string; cause?: { code?: string } }) => ({ trpc: err.code, code: err.cause?.code }),
    );

  const record = (userId: string) => db.sql`SELECT * FROM users WHERE id = ${userId}`;

  describe('qr.resolve', () => {
    it('pays the account a scanned code names even when its handle cannot be found', async () => {
      const payee = await signUp('qr_payee');
      const payer = await signUp('qr_payer');
      const payeeApi = router.createCaller(await ctxOf(payee));
      const payerApi = router.createCaller(await ctxOf(payer));
      const { payload } = await payeeApi.qr.mine();
      expect(payload).toContain(payee.userId);
      expect(payload).not.toContain('qr_payee');

      await payeeApi.handle.setDiscoverable({ discoverable: false });
      expect(await payerApi.users.resolveHandle({ handle: 'qr_payee' })).toMatchObject({ found: false });
      expect(await payerApi.qr.resolve({ payload })).toEqual({ userId: payee.userId, handle: 'qr_payee', self: false });
      expect(await payeeApi.qr.resolve({ payload })).toMatchObject({ self: true });

      // A handle change retires the old code without naming the new handle; the new code pays the same account.
      await payeeApi.handle.change({ handle: 'qr_payee_renamed', fromHandle: 'qr_payee' });
      expect(await refusal(payerApi.qr.resolve({ payload }))).toEqual({ trpc: 'BAD_REQUEST', code: 'identity.qr_invalid' });
      const renamed = (await payeeApi.qr.mine()).payload;
      expect(renamed).not.toBe(payload);
      expect(await payerApi.qr.resolve({ payload: renamed })).toEqual({ userId: payee.userId, handle: 'qr_payee_renamed', self: false });
    });

    it('refuses a tampered code and a blank key with their own codes, and the record reads the same after each', async () => {
      const payee = await signUp('qr_steady');
      const payer = await signUp('qr_scanner');
      const payerCtx = await ctxOf(payer);
      const { payload } = await router.createCaller(await ctxOf(payee)).qr.mine();
      const before = await record(payee.userId);
      const [v, , tag, sig] = payload.split('.') as [string, string, string, string];

      expect(await refusal(router.createCaller(payerCtx).qr.resolve({ payload: `${v}.${payer.userId}.${tag}.${sig}` }))).toEqual({
        trpc: 'BAD_REQUEST',
        code: 'identity.qr_invalid',
      });
      expect(await record(payee.userId)).toEqual(before);

      expect(await refusal(router.createCaller(payerCtx).qr.resolve({ payload: `${payload.slice(0, -2)}AA` }))).toMatchObject({
        code: 'identity.qr_invalid',
      });
      expect(await record(payee.userId)).toEqual(before);

      expect(await refusal(blankKey.createCaller(payerCtx).qr.resolve({ payload }))).toEqual({
        trpc: 'PRECONDITION_FAILED',
        code: 'identity.qr_key_unset',
      });
      expect(await refusal(blankKey.createCaller(await ctxOf(payee)).qr.mine())).toMatchObject({ code: 'identity.qr_key_unset' });
      expect(await record(payee.userId)).toEqual(before);
    });
  });
}
