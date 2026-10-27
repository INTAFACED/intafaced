/**
 * KYC capabilities against Postgres (I-kyc-compliance-07, J-identity-08 #6). A request marks the level's capabilities
 * pending; the approval makes them active in its own transaction; a reject puts them back; with no mapping an approval
 * grants nothing; inactive is terminal, keeps its reason, survives approvals and refuses a request that would grant it.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { kycCapabilitiesOutputSchema } from '@intafaced/contracts/identity-kyc-capabilities';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { parseKycCapabilitiesByLevel } from './capabilities.js';
import { parseKycRejectReasons } from './cases.js';

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

const MAP = parseKycCapabilitiesByLevel(
  JSON.stringify({ basic: ['custody_crypto', 'transfer_crypto', 'trade_crypto'], full: ['custody_fiat', 'transfer_fiat'] }),
);

const REASONS = parseKycRejectReasons(
  JSON.stringify([{ code: 'compliance_hold', reason: 'TEST: switched off after review.', guidance: 'TEST: ask Support.' }]),
  'IDENTITY_KYC_CAPABILITY_REASONS',
);

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('KYC capabilities (Postgres unavailable)', () => {
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
  const unmapped = new AuthService(
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
  unmapped.useLogger({ warn: () => undefined });
  let n = 0;
  async function person() {
    const handle = `kp${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }
  const states = async (userId: string, service = auth) =>
    Object.fromEntries(
      kycCapabilitiesOutputSchema
        .parse(await service.listKycCapabilities(userId, REASONS))
        .capabilities.map((c) => [c.capability, c.state]),
    );
  const events = async (userId: string) => {
    const [row] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_capability_events WHERE user_id = ${userId}`;
    return row!.n;
  };
  const approve = (recordId: string, reviewerId: string, service = auth) =>
    service.approveKycRecord({ recordId, reviewerId, approvalParties: [] });
  const reject = (recordId: string, reviewerId: string) =>
    auth.rejectKycRecord({ recordId, reviewerId, reasonCode: 'document_unreadable', approvalParties: [] });
  const off = (userId: string, reviewerId: string, capability = 'trade_crypto' as const, reasonCode = 'compliance_hold') =>
    auth.deactivateKycCapability({ userId, capability, reasonCode, reviewerId, approvalParties: [], reasons: REASONS });

  describe('KYC capabilities', () => {
    it('reads every capability unrequested before anything is asked, with the lowest level that grants it', async () => {
      const userId = await person();
      const read = kycCapabilitiesOutputSchema.parse(await auth.listKycCapabilities(userId, REASONS));
      expect(read.mapped).toBe(true);
      expect(read.capabilities.map((c) => [c.capability, c.state, c.grantedAt])).toEqual([
        ['custody_crypto', 'unrequested', 'basic'],
        ['custody_fiat', 'unrequested', 'full'],
        ['transfer_crypto', 'unrequested', 'basic'],
        ['transfer_fiat', 'unrequested', 'full'],
        ['trade_crypto', 'unrequested', 'basic'],
      ]);
      await expect(auth.listKycCapabilities('00000000-0000-4000-8000-000000000000', REASONS)).rejects.toMatchObject({
        code: 'auth.not_found',
      });
    });

    it('a request marks its level pending and the approval makes them active in the same transaction', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      expect(await states(userId)).toEqual({
        custody_crypto: 'pending',
        custody_fiat: 'pending',
        transfer_crypto: 'pending',
        transfer_fiat: 'pending',
        trade_crypto: 'pending',
      });
      const approved = await approve(record.id, await person());
      expect(approved.status).toBe('approved');
      expect(Object.values(await states(userId))).toEqual(Array(5).fill('active'));
      const [stamped] = await db.sql<Array<{ at: Date }>>`
        SELECT DISTINCT at FROM kyc_capabilities WHERE user_id = ${userId} AND state = 'active'`;
      expect(stamped!.at.getTime()).toBe(approved.reviewedAt!.getTime());
      expect(await events(userId)).toBe(10);
      // The same approval again changes nothing and writes no history.
      await approve(record.id, await person());
      expect(await events(userId)).toBe(10);
    });

    it('a lower level grants only its own; a reject puts what was pending back', async () => {
      const userId = await person();
      const basic = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await approve(basic.id, await person());
      const full = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      expect(await states(userId)).toMatchObject({ custody_crypto: 'active', custody_fiat: 'pending', transfer_fiat: 'pending' });
      await reject(full.id, await person());
      expect(await states(userId)).toEqual({
        custody_crypto: 'active',
        custody_fiat: 'unrequested',
        transfer_crypto: 'active',
        transfer_fiat: 'unrequested',
        trade_crypto: 'active',
      });
    });

    it('with no mapping published an approval grants nothing, and the read says so', async () => {
      const userId = await person();
      const record = await unmapped.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await approve(record.id, await person(), unmapped);
      expect(await unmapped.kycTier(userId)).toBe('basic');
      const read = kycCapabilitiesOutputSchema.parse(await unmapped.listKycCapabilities(userId, REASONS));
      expect(read.mapped).toBe(false);
      expect(read.capabilities.every((c) => c.state === 'unrequested' && c.grantedAt === null)).toBe(true);
      expect(await events(userId)).toBe(0);
    });

    it('inactive is terminal: it keeps its reason, survives an approval and refuses a request that would grant it', async () => {
      const userId = await person();
      const operator = await person();
      const basic = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await approve(basic.id, operator);
      const after = kycCapabilitiesOutputSchema.parse(await off(userId, operator));
      expect(after.capabilities.find((c) => c.capability === 'trade_crypto')).toMatchObject({
        state: 'inactive',
        reasonCode: 'compliance_hold',
        reasonText: 'TEST: switched off after review.',
      });
      // The same decision again returns; another code is refused, so the recorded reason stays.
      await off(userId, operator);
      await expect(off(userId, operator, 'trade_crypto', 'other_code')).rejects.toMatchObject({ code: 'kyc.capability_state' });
      await expect(auth.assertKycCapabilityDeactivatable(userId, 'trade_crypto', 'other_code')).rejects.toMatchObject({
        code: 'kyc.capability_state',
      });
      // A request for the level whose own capabilities include it is refused, and stores nothing.
      await db.sql`UPDATE kyc_records SET expires_at = now() - interval '1 minute' WHERE id = ${basic.id}`;
      await expect(auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' })).rejects.toMatchObject({
        code: 'kyc.capability_inactive',
      });
      const [records] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_records WHERE user_id = ${userId}`;
      expect(records!.n).toBe(1);
      // A higher level stays open, and its approval leaves the switched-off one off.
      const full = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      await approve(full.id, operator);
      expect(await states(userId)).toEqual({
        custody_crypto: 'active',
        custody_fiat: 'active',
        transfer_crypto: 'active',
        transfer_fiat: 'active',
        trade_crypto: 'inactive',
      });
    });

    it('a lapsed level stops reading active; a level approved before capabilities existed reads active', async () => {
      const userId = await person();
      const [legacy] = await db.sql<Array<{ id: string }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at) VALUES (${userId}, 'basic', 'DE', 'approved', now())
        RETURNING id`;
      expect(await states(userId)).toMatchObject({ custody_crypto: 'active', trade_crypto: 'active', custody_fiat: 'unrequested' });
      await db.sql`UPDATE kyc_records SET expires_at = now() - interval '1 minute' WHERE id = ${legacy!.id}`;
      expect(Object.values(await states(userId))).toEqual(Array(5).fill('unrequested'));
      // Asking again after the lapse marks it pending again.
      await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      expect(await states(userId)).toMatchObject({ custody_crypto: 'pending', custody_fiat: 'unrequested' });
    });

    it('a reject puts back only what its own request made pending', async () => {
      const userId = await person();
      const operator = await person();
      const basic = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const full = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      expect(Object.values(await states(userId))).toEqual(Array(5).fill('pending'));
      await reject(full.id, operator);
      expect(await states(userId)).toEqual({
        custody_crypto: 'pending',
        custody_fiat: 'unrequested',
        transfer_crypto: 'pending',
        transfer_fiat: 'unrequested',
        trade_crypto: 'pending',
      });
      await approve(basic.id, operator);
      expect(await states(userId)).toMatchObject({ custody_crypto: 'active', custody_fiat: 'unrequested' });
    });

    it('an approval and a switch-off of a capability with no row yet are serialised, never both version 1', async () => {
      const userId = await person();
      const operator = await person();
      const [legacy] = await db.sql<Array<{ id: string }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status) VALUES (${userId}, 'basic', 'DE', 'pending') RETURNING id`;
      await Promise.all([approve(legacy!.id, operator), off(userId, operator)]);
      const versions = await db.sql<Array<{ version: number }>>`
        SELECT version FROM kyc_capability_events WHERE user_id = ${userId} AND capability = 'trade_crypto' ORDER BY version`;
      expect(versions.map((v) => v.version)).toEqual(versions.length === 1 ? [1] : [1, 2]);
      expect(await states(userId)).toMatchObject({ trade_crypto: 'inactive', custody_crypto: 'active' });
    });

    it('nobody switches off their own capability', async () => {
      const userId = await person();
      await expect(off(userId, userId)).rejects.toMatchObject({ code: 'auth.kyc_self_review' });
      expect(await events(userId)).toBe(0);
    });
  });
}
