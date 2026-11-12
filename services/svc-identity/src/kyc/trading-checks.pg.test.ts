/**
 * The trading checks against Postgres (J-cex-spot-01 #3, OWNER 258 (4)). A clear grants level basic for trading in one
 * transaction with its case and capabilities; a hit holds the account behind a pending record and grants nothing; a
 * blank owner list refuses kyc.screening_list_unset and writes nothing; a repeat answers the first outcome by its
 * business key and never screens again; the name and date of birth are never stored in plaintext.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kycCapabilitiesOutputSchema } from '@intafaced/contracts/identity-kyc-capabilities';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { FounderControls } from '../controls/founder-controls.js';
import { sealBirthDate } from './birth-date.js';
import { parseKycCapabilitiesByLevel } from './capabilities.js';
import { parseKycRejectReasons } from './cases.js';
import { parseSanctionsPersonsList, TRADING_CHECKS_REVIEWER, TradingChecksDesk, type SanctionsPersonList } from './trading-checks.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const tokenConfig = {
  secret: 'an-identity-trading-checks-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

// As the TEST owner values map it: basic also holds crypto custody and transfer, which a trading clear must never grant.
const MAP = parseKycCapabilitiesByLevel(
  JSON.stringify({ basic: ['custody_crypto', 'transfer_crypto', 'trade_crypto'], full: ['custody_fiat'] }),
);
const REASONS = parseKycRejectReasons(
  JSON.stringify([{ code: 'compliance_hold', reason: 'TEST: switched off.', guidance: 'TEST: ask Support.' }]),
  'IDENTITY_KYC_CAPABILITY_REASONS',
);
const LIST = parseSanctionsPersonsList(
  JSON.stringify({
    label: 'TEST: trading checks test only',
    entries: [{ legalName: 'TEST Listed Person', dateOfBirth: '1970-01-01', country: 'DE' }],
  }),
  'test',
)!;
const KEY = randomBytes(32);
const SCREENING_ENV = ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE', 'INTAFACED_SCREENING_FAIL_CLOSED', 'APP_ENV'];

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('trading checks (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of SCREENING_ENV) saved[k] = process.env[k];
    // The region screen (sign-up's), read as a TEST list on a test stack; the person list is this test's own.
    process.env.INTAFACED_SANCTIONS_REGIONS = 'KP:TEST fixture';
    process.env.INTAFACED_SANCTIONS_LIST_SOURCE = 'TEST fixture for the trading checks test';
    process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';
    process.env.APP_ENV = 'test';
  });
  afterAll(async () => {
    for (const k of SCREENING_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await db.drop();
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(
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
  auth.useLogger({ warn: () => undefined });
  auth.useKycCapabilities(MAP);
  const desk = (list: SanctionsPersonList | null = LIST, key: Buffer | null = KEY) =>
    new TradingChecksDesk(db.sql, {
      key,
      list,
      capabilities: MAP,
      kycTier: (userId, tx) => auth.kycTier(userId, tx),
      announce: (record) => auth.announceTradingClear(record),
    });
  beforeEach(() => bus.reset());

  let n = 0;
  async function person(dateOfBirth: string | null = '1990-05-01') {
    const handle = `tc${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    if (dateOfBirth) {
      const sealed = sealBirthDate(KEY, dateOfBirth);
      await db.sql`INSERT INTO birth_dates (user_id, ciphertext, nonce) VALUES (${session.userId}, ${sealed.ciphertext}, ${sealed.nonce})`;
    }
    return session.userId;
  }
  const records = (userId: string) =>
    db.sql<Array<{ tier: string; status: string; reviewed_by: string | null; jurisdiction: string }>>`
      SELECT tier, status, reviewed_by, jurisdiction FROM kyc_records WHERE user_id = ${userId}`;
  const checks = (userId: string) => db.sql`SELECT outcome, business_key FROM trading_checks WHERE user_id = ${userId}`;
  const capability = async (userId: string, name = 'trade_crypto') =>
    kycCapabilitiesOutputSchema.parse(await auth.listKycCapabilities(userId, REASONS)).capabilities.find((c) => c.capability === name)!
      .state;
  const refusal = async (promise: Promise<unknown>) =>
    (await promise.then(
      () => ({ code: 'resolved' }),
      (e: { code?: string }) => e,
    )) as { code?: string };

  describe('the trading checks', () => {
    it('reads the sign-up country to confirm, and whether the owner list is set', async () => {
      const userId = await person();
      expect(await desk().read(userId)).toEqual({ state: 'not_run', country: 'DE', listSet: true });
      expect((await desk(null).read(userId)).listSet).toBe(false);
    });

    it('a clear grants trading alone (level basic marked for trading), with its case and the trading capability, in one step', async () => {
      const userId = await person();
      const result = await desk().run(userId, { legalName: 'TEST Trader One', country: 'DE', confirmed: true });
      expect(result).toMatchObject({ outcome: 'cleared', fresh: true });
      // No approved level: the clear is for trading alone, so every lookup of the level reads none.
      expect(await auth.kycTier(userId)).toBe('none');
      expect(await auth.kycTradingOnly(userId)).toBe(true);
      expect(await records(userId)).toEqual([
        { tier: 'basic', status: 'approved', reviewed_by: TRADING_CHECKS_REVIEWER, jurisdiction: 'DE' },
      ]);
      expect(await capability(userId)).toBe('active');
      // For trading only: custody and transfer, which basic also maps to, stay unrequested, and no row grants them.
      expect(await capability(userId, 'custody_crypto')).toBe('unrequested');
      expect(await capability(userId, 'transfer_crypto')).toBe('unrequested');
      expect(await db.sql`SELECT capability, state FROM kyc_capabilities WHERE user_id = ${userId}`).toEqual([
        { capability: 'trade_crypto', state: 'active' },
      ]);
      // The session carries no approved level, only the trading clear: custody, transfer and withdrawal gates read none.
      expect(await auth.sessionTier(userId)).toEqual({ tier: 'none', tradingCleared: true });
      expect(await db.sql`SELECT state FROM kyc_cases WHERE user_id = ${userId}`).toEqual([{ state: 'approved' }]);
      expect(bus.published.some((e) => e.subject.endsWith('identity.kyc.approved'))).toBe(true);
      expect((await desk().read(userId)).state).toBe('cleared');
      // Neither the name nor the date of birth is stored in plaintext.
      const stored = JSON.stringify(await db.sql`SELECT * FROM trading_checks WHERE user_id = ${userId}`);
      expect(stored).not.toContain('Trader');
      expect(JSON.stringify(await db.sql`SELECT * FROM birth_dates WHERE user_id = ${userId}`)).not.toContain('1990');
    });

    it("a clear never raises the level that Edge's per-request authority read forwards to every service", async () => {
      const userId = await person();
      const [session] = await db.sql<Array<{ id: string }>>`SELECT id FROM sessions WHERE user_id = ${userId} LIMIT 1`;
      const authority = () =>
        new FounderControls(db.sql, null).currentAuthority({ userId, credential: { kind: 'session', sessionId: session!.id } });
      expect(await desk().run(userId, { legalName: 'TEST Trader One', country: 'DE', confirmed: true })).toMatchObject({
        outcome: 'cleared',
      });
      // Edge overwrites each forwarded principal's tier with this value, so a trading clear here would open the bank gates.
      expect(await authority()).toMatchObject({ status: 'eligible', account: { kycTier: 'none' } });
      // An operator-approved level beside the clear still reads as itself.
      await db.sql`INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_by, reviewed_at)
        VALUES (${userId}, 'basic', 'DE', 'approved', 'TEST operator', now())`;
      expect(await authority()).toMatchObject({ status: 'eligible', account: { kycTier: 'basic' } });
    });

    it("after a clear, the bank's verification still opens its own request, and trading stays open while it is reviewed", async () => {
      const userId = await person();
      expect(await desk().run(userId, { legalName: 'TEST Trader One', country: 'DE', confirmed: true })).toMatchObject({
        outcome: 'cleared',
      });
      const request = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      // A new pending request, not the trading clear handed back as if the bank's level were held.
      expect(request).toMatchObject({ tier: 'basic', status: 'pending' });
      expect(await records(userId)).toEqual(
        expect.arrayContaining([
          { tier: 'basic', status: 'approved', reviewed_by: TRADING_CHECKS_REVIEWER, jurisdiction: 'DE' },
          { tier: 'basic', status: 'pending', reviewed_by: null, jurisdiction: 'DE' },
        ]),
      );
      expect(await db.sql`SELECT count(*)::int AS n FROM kyc_cases WHERE user_id = ${userId}`).toEqual([{ n: 2 }]);
      // What the bank's level adds waits for its review; the trading clear's own capability stays active.
      expect(await capability(userId, 'custody_crypto')).toBe('pending');
      expect(await capability(userId, 'transfer_crypto')).toBe('pending');
      expect(await capability(userId)).toBe('active');
      expect(await db.sql`SELECT state FROM kyc_capabilities WHERE user_id = ${userId} AND capability = 'trade_crypto'`).toEqual([
        { state: 'active' },
      ]);
      expect(await auth.sessionTier(userId)).toEqual({ tier: 'none', tradingCleared: true });
      // A second press is the same request.
      expect((await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' })).id).toBe(request.id);
    });

    it('a hit holds the account under review: a pending record for a person, nothing granted', async () => {
      const userId = await person('1970-01-01');
      const result = await desk().run(userId, { legalName: '  test listed   person ', country: 'DE', confirmed: true });
      expect(result).toMatchObject({ outcome: 'held', fresh: true });
      expect(await auth.kycTier(userId)).toBe('none');
      expect(await auth.kycTradingOnly(userId)).toBe(false);
      expect(await records(userId)).toEqual([{ tier: 'basic', status: 'pending', reviewed_by: null, jurisdiction: 'DE' }]);
      expect(await capability(userId)).toBe('pending');
      expect((await auth.listPendingKyc(50)).some((r) => r.userId === userId)).toBe(true);
      expect(bus.published.some((e) => e.subject.endsWith('identity.kyc.approved'))).toBe(false);
      expect((await desk().read(userId)).state).toBe('held');
    });

    it('screens and records the country given at sign-up: another typed country is refused kyc.country_mismatch and grants nothing', async () => {
      const userId = await person();
      const err = await refusal(desk().run(userId, { legalName: 'TEST Trader Four', country: 'FR', confirmed: true }));
      expect(err.code).toBe('kyc.country_mismatch');
      expect(await records(userId)).toEqual([]);
      expect(await checks(userId)).toEqual([]);
      expect(await auth.kycTier(userId)).toBe('none');
    });

    it('a listed person who types another country is still held', async () => {
      const userId = await person('1970-01-01');
      // FR would screen clear against the DE entry; it is refused, nothing is granted, and the recorded DE is what is screened.
      const err = await refusal(desk().run(userId, { legalName: 'TEST Listed Person', country: 'FR', confirmed: true }));
      expect(err.code).toBe('kyc.country_mismatch');
      expect(await auth.kycTier(userId)).toBe('none');
      expect(await records(userId)).toEqual([]);
      const held = await desk().run(userId, { legalName: 'TEST Listed Person', country: 'DE', confirmed: true });
      expect(held).toMatchObject({ outcome: 'held', fresh: true });
      expect(await records(userId)).toEqual([{ tier: 'basic', status: 'pending', reviewed_by: null, jurisdiction: 'DE' }]);
      expect(await auth.kycTier(userId)).toBe('none');
    });

    it('with the owner list blank, refuses kyc.screening_list_unset and writes nothing', async () => {
      const userId = await person();
      const err = await refusal(desk(null).run(userId, { legalName: 'TEST Trader Two', country: 'DE', confirmed: true }));
      expect(err.code).toBe('kyc.screening_list_unset');
      expect(await records(userId)).toEqual([]);
      expect(await checks(userId)).toEqual([]);
      expect(await auth.kycTier(userId)).toBe('none');
    });

    it('a repeat answers the first outcome by its business key and never screens again', async () => {
      const userId = await person('1970-01-01');
      const first = await desk().run(userId, { legalName: 'TEST Listed Person', country: 'DE', confirmed: true });
      // The same person sends it again, with a name that would clear: still held, still one record.
      const again = await desk().run(userId, { legalName: 'TEST Someone Else', country: 'DE', confirmed: true });
      expect(again).toEqual({ outcome: 'held', recordId: first.recordId, fresh: false });
      // Two at once: one row, one record.
      const other = await person();
      const both = await Promise.all([
        desk().run(other, { legalName: 'TEST Trader Three', country: 'DE', confirmed: true }),
        desk().run(other, { legalName: 'TEST Trader Three', country: 'DE', confirmed: true }),
      ]);
      expect(both.map((r) => r.outcome)).toEqual(['cleared', 'cleared']);
      expect(both[0]!.recordId).toBe(both[1]!.recordId);
      expect(await records(other)).toHaveLength(1);
      expect(await checks(other)).toEqual([{ outcome: 'cleared', business_key: `kyc:trading-checks:${other}` }]);
    });

    it('refuses without the country confirmed, without a date of birth, without the key, or for a level already held', async () => {
      const userId = await person();
      expect((await refusal(desk().run(userId, { legalName: 'TEST Trader', country: 'DE', confirmed: false }))).code).toBe(
        'kyc.country_unconfirmed',
      );
      expect((await refusal(desk().run(userId, { legalName: 'TEST Trader', country: 'ZZ', confirmed: true }))).code).toBe(
        'kyc.country_invalid',
      );
      expect((await refusal(desk(LIST, null).run(userId, { legalName: 'TEST Trader', country: 'DE', confirmed: true }))).code).toBe(
        'kyc.trading_checks_unconfigured',
      );
      const noBirth = await person(null);
      expect((await refusal(desk().run(noBirth, { legalName: 'TEST Trader', country: 'DE', confirmed: true }))).code).toBe(
        'kyc.date_of_birth_unknown',
      );
      expect(await records(noBirth)).toEqual([]);
      const verified = await person();
      const record = await auth.submitKyc({ userId: verified, tier: 'basic', jurisdiction: 'DE' });
      await auth.approveKycRecord({ recordId: record.id, reviewerId: '00000000-0000-4000-8000-0000000000aa', approvalParties: [] });
      expect((await refusal(desk().run(verified, { legalName: 'TEST Trader', country: 'DE', confirmed: true }))).code).toBe(
        'kyc.level_held',
      );
      expect(await auth.kycTradingOnly(verified)).toBe(false);
    });
  });
}
