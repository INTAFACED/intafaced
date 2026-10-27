/**
 * KYC attempt limits against Postgres (I-kyc-compliance-10, J-identity-08 #4). Rejections inside the window count from
 * the case history; at the cap a new request is refused with the seconds left and stores nothing; rejections older than
 * the window, or a lockout that has run out, open it again; with no limit set nothing is refused.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { kycAttemptsSchema } from '@intafaced/contracts/identity-kyc-attempts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { KycAttemptsError, parseKycAttemptLimit, readKycAttempts } from './attempts.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const tokenConfig = {
  secret: 'an-identity-kyc-cases-test-secret-long-enough',
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

const LIMIT = parseKycAttemptLimit({
  IDENTITY_KYC_MAX_DENIALS: '2',
  IDENTITY_KYC_DENIAL_WINDOW_HOURS: '24',
  IDENTITY_KYC_LOCKOUT_HOURS: '1',
});

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('KYC attempt limits (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  afterAll(async () => {
    await db.drop();
  });
  const bus = new MemoryEventBus('svc-identity');
  const service = () => {
    const s = new AuthService(
      db.sql,
      bus,
      new RankService(db.sql, bus),
      tokenConfig,
      webauthnConfig,
      randomBytes(32).toString('base64'),
      undefined,
      undefined,
      25,
    );
    s.useLogger({ warn: () => undefined });
    return s;
  };
  const auth = service();
  auth.useKycAttemptLimit(LIMIT);
  const unlimited = service();
  let n = 0;
  async function person() {
    const handle = `ka${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }
  const rejected = async (userId: string) => {
    const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
    await auth.rejectKycRecord({ recordId: record.id, reviewerId: await person(), reasonCode: 'document_unreadable', approvalParties: [] });
  };
  const records = async (userId: string) => {
    const [row] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_records WHERE user_id = ${userId}`;
    return row!.n;
  };

  describe('KYC attempt limits', () => {
    it('counts rejections in the window; at the cap a request is refused with the seconds left and stores nothing', async () => {
      const userId = await person();
      expect(kycAttemptsSchema.parse(await auth.kycAttempts(userId))).toEqual({
        limit: { maxDenials: 2, windowHours: 24, lockoutHours: 1 },
        denialsInWindow: 0,
        lockedUntil: null,
      });
      await rejected(userId);
      expect(await auth.kycAttempts(userId)).toMatchObject({ denialsInWindow: 1, lockedUntil: null });
      await rejected(userId);
      const read = kycAttemptsSchema.parse(await auth.kycAttempts(userId));
      expect(read.denialsInWindow).toBe(2);
      const [last] = await db.sql<Array<{ at: Date }>>`
        SELECT max(e.at) AS at FROM kyc_case_events e JOIN kyc_cases c ON c.id = e.case_id
        WHERE c.user_id = ${userId} AND e.state = 'rejected'`;
      expect(Date.parse(read.lockedUntil!)).toBe(last!.at.getTime() + 3_600_000);

      const before = await records(userId);
      const refused = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(KycAttemptsError);
      expect(refused).toMatchObject({ code: 'kyc.attempts_exhausted' });
      const seconds = (refused as KycAttemptsError).details.retryAfterSeconds;
      expect(seconds).toBeGreaterThan(3500);
      expect(seconds).toBeLessThanOrEqual(3600);
      expect(await records(userId)).toBe(before);
      // Another person is not held by this one's rejections.
      const other = await person();
      await expect(auth.submitKyc({ userId: other, tier: 'basic', jurisdiction: 'DE' })).resolves.toMatchObject({ status: 'pending' });
    });

    it('a lockout that has run out, and rejections older than the window, open it again', async () => {
      const userId = await person();
      await rejected(userId);
      await rejected(userId);
      const events = db.sql`
        SELECT e.id FROM kyc_case_events e JOIN kyc_cases c ON c.id = e.case_id WHERE c.user_id = ${userId} AND e.state = 'rejected'`;
      // Two hours ago: still in the window, so the count stands, but the hour of lockout is over.
      await db.sql`UPDATE kyc_case_events SET at = at - interval '2 hours' WHERE id IN (${events})`;
      expect(await auth.kycAttempts(userId)).toMatchObject({ denialsInWindow: 2, lockedUntil: null });
      await expect(readKycAttempts(db.sql, LIMIT, userId, new Date())).resolves.toMatchObject({ lockedUntil: null });
      // Older than the window: they no longer count.
      await db.sql`UPDATE kyc_case_events SET at = at - interval '1 day' WHERE id IN (${events})`;
      expect(await auth.kycAttempts(userId)).toMatchObject({ denialsInWindow: 0, lockedUntil: null });
      await expect(auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' })).resolves.toMatchObject({ status: 'pending' });
    });

    it('with no limit set nothing is refused, and the read says none is set', async () => {
      const userId = await person();
      await rejected(userId);
      await rejected(userId);
      expect(await unlimited.kycAttempts(userId)).toEqual({ limit: null, denialsInWindow: null, lockedUntil: null });
      await expect(unlimited.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' })).resolves.toMatchObject({ status: 'pending' });
    });
  });
}
