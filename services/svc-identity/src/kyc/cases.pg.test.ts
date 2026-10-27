/**
 * KYC cases against Postgres (I-kyc-compliance-01, J-identity-08 #6). A submission opens one case with its record; a
 * reject names a listed reason and moves the case with the record in one transaction; a retry with the same reason is
 * the same decision and another reason is refused; a resubmission opens a new case linked to the rejected one; an
 * approval moves the case too; and the relay publishes kycSubmitted and kycRejected once each, at least once.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { kycHistoryOutputSchema } from '@intafaced/contracts/identity-kyc-cases';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { parseKycRejectReasons, relayKycCaseEvents } from './cases.js';

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

const REASONS = parseKycRejectReasons(
  JSON.stringify([
    { code: 'document_unreadable', reason: 'TEST: the photo of your ID could not be read.', guidance: 'TEST: upload a sharp photo.' },
    { code: 'name_mismatch', reason: 'TEST: the name does not match.', guidance: 'TEST: use the name on your ID.' },
  ]),
);

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('KYC cases (Postgres unavailable)', () => {
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
  const relay = (b: Parameters<typeof relayKycCaseEvents>[0]['bus'] = bus) =>
    relayKycCaseEvents({ sql: db.sql, bus: b, now: () => new Date() });

  let n = 0;
  async function person() {
    const handle = `kc${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }
  const reject = (recordId: string, reviewerId: string, reasonCode = 'document_unreadable', extra = {}) =>
    auth.rejectKycRecord({ recordId, reviewerId, reasonCode, approvalParties: [], ...extra });
  const history = async (userId: string) => kycHistoryOutputSchema.parse({ cases: await auth.listKycCases(userId, 50, REASONS) }).cases;
  const counts = async (userId: string) => {
    const [row] = await db.sql<Array<{ cases: number; events: number }>>`
      SELECT (SELECT count(*)::int FROM kyc_cases WHERE user_id = ${userId}) AS cases,
             (SELECT count(*)::int FROM kyc_case_events e JOIN kyc_cases c ON c.id = e.case_id WHERE c.user_id = ${userId}) AS events`;
    return row!;
  };

  beforeEach(async () => {
    // Every earlier test's rows are out already, so each test counts only its own.
    await db.sql`UPDATE kyc_case_events SET published_at = now() WHERE published_at IS NULL`;
    bus.reset();
  });

  describe('KYC cases', () => {
    it('a submission opens one case with one history row, published once as kycSubmitted', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      // The same request again is the same record and the same case.
      await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      expect(await counts(userId)).toEqual({ cases: 1, events: 1 });
      const [open] = await history(userId);
      expect(open).toMatchObject({
        recordId: record.id,
        tier: 'basic',
        jurisdiction: 'DE',
        state: 'submitted',
        version: 1,
        followsCaseId: null,
      });
      expect(open!.reason).toBeNull();
      expect(open!.history).toEqual([{ version: 1, state: 'submitted', at: record.createdAt.toISOString() }]);

      expect(await relay()).toBe(1);
      const sent = bus.emitted('kycSubmitted');
      expect(sent.map((e) => e.payload)).toEqual([
        { userId, caseId: open!.id, version: 1, previousCaseId: null, submittedAt: record.createdAt.toISOString() },
      ]);
      expect(sent[0]!.idempotencyKey).toBe(`identity.kyc.submitted:${open!.id}:1`);
      expect(await relay()).toBe(0);
    });

    it('a reject with a listed code moves the record and the case together, with one history row and one event', async () => {
      const userId = await person();
      const operator = await person();
      const record = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      await relay();
      bus.reset();
      const rejected = await reject(record.id, operator, 'name_mismatch', {
        customerNote: '  TEST: check the spelling.  ',
        noteVisible: true,
      });
      expect(rejected.status).toBe('rejected');
      expect(await auth.kycTier(userId)).toBe('none');
      expect(await counts(userId)).toEqual({ cases: 1, events: 2 });
      const [only] = await history(userId);
      expect(only).toMatchObject({
        state: 'rejected',
        version: 2,
        decidedAt: rejected.reviewedAt!.toISOString(),
        reason: { code: 'name_mismatch', text: 'TEST: the name does not match.', guidance: 'TEST: use the name on your ID.' },
        note: 'TEST: check the spelling.',
      });
      expect(only!.history.map((h) => h.state)).toEqual(['submitted', 'rejected']);

      expect(await relay()).toBe(1);
      const sent = bus.emitted('kycRejected');
      expect(sent.map((e) => e.payload)).toEqual([
        { userId, caseId: only!.id, version: 2, reasonCode: 'name_mismatch', rejectedAt: rejected.reviewedAt!.toISOString() },
      ]);
      expect(sent[0]!.idempotencyKey).toBe(`identity.kyc.rejected:${only!.id}:2`);
    });

    it('a retry with the same code returns the stored result; another code is refused kyc.case_state', async () => {
      const userId = await person();
      const operator = await person();
      const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const first = await reject(record.id, operator);
      const again = await reject(record.id, await person());
      expect(again.reviewedBy).toBe(operator);
      expect(again.reviewedAt?.getTime()).toBe(first.reviewedAt?.getTime());
      await expect(reject(record.id, operator, 'name_mismatch')).rejects.toMatchObject({ code: 'kyc.case_state' });
      expect(await counts(userId)).toEqual({ cases: 1, events: 2 });
      expect((await history(userId))[0]!.reason?.code).toBe('document_unreadable');
    });

    it('a note not marked visible never reaches the customer', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await reject(record.id, await person(), 'document_unreadable', { customerNote: 'TEST: internal only' });
      expect((await history(userId))[0]!.note).toBeNull();
    });

    it('a resubmission after a reject opens a new case linked to the rejected one', async () => {
      const userId = await person();
      const operator = await person();
      const first = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await reject(first.id, operator);
      const second = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const [newest, older] = await history(userId);
      expect(newest).toMatchObject({ recordId: second.id, state: 'submitted', followsCaseId: older!.id });
      expect(older).toMatchObject({ recordId: first.id, state: 'rejected' });
      await relay();
      expect(bus.emitted('kycSubmitted').find((e) => e.payload.caseId === newest!.id)?.payload.previousCaseId).toBe(older!.id);
    });

    it('an approval moves the case to approved at once, and the relay announces nothing more for it', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      await relay();
      bus.reset();
      const approved = await auth.approveKycRecord({ recordId: record.id, reviewerId: await person(), approvalParties: [] });
      expect(await auth.kycTier(userId)).toBe('full');
      const [only] = await history(userId);
      expect(only).toMatchObject({ state: 'approved', version: 2, decidedAt: approved.reviewedAt!.toISOString(), reason: null });
      expect(only!.history.map((h) => h.state)).toEqual(['submitted', 'approved']);
      expect(bus.emitted('kycApproved')).toHaveLength(1);
      expect(await relay()).toBe(0);
      expect(bus.emitted('kycSubmitted')).toHaveLength(0);
    });

    it('a record with no case (made before cases) gets one in its own state when it is decided, never announced late', async () => {
      const userId = await person();
      const [legacy] = await db.sql<Array<{ id: string }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status) VALUES (${userId}, 'basic', 'DE', 'pending') RETURNING id`;
      await reject(legacy!.id, await person());
      const [only] = await history(userId);
      expect(only).toMatchObject({ state: 'rejected', reason: { code: 'document_unreadable' } });
      expect(await relay()).toBe(1);
      expect(bus.emitted('kycSubmitted')).toHaveLength(0);
      expect(bus.emitted('kycRejected')).toHaveLength(1);

      const [old] = await db.sql<Array<{ id: string }>>`
        INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at) VALUES (${userId}, 'full', 'DE', 'rejected', now()) RETURNING id`;
      // Rejected before reasons existed: a reason cannot be added afterwards.
      await expect(reject(old!.id, await person())).rejects.toMatchObject({ code: 'kyc.case_state' });
    });

    it('a code the owner later removed keeps its code with no text', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await reject(record.id, await person());
      const [only] = await auth.listKycCases(
        userId,
        5,
        parseKycRejectReasons(JSON.stringify([{ code: 'other', reason: 'r', guidance: 'g' }])),
      );
      expect(only!.reason).toEqual({ code: 'document_unreadable', text: null, guidance: null });
    });

    it('reads only an existing person, newest first, inside the window', async () => {
      await expect(auth.listKycCases('00000000-0000-4000-8000-000000000000', 5, REASONS)).rejects.toMatchObject({ code: 'auth.not_found' });
      const userId = await person();
      expect(await auth.listKycCases(userId, 5, REASONS)).toEqual([]);
      await expect(auth.listKycCases(userId, 0, REASONS)).rejects.toThrow();
    });

    it('a resubmission follows only a rejected case at the same level', async () => {
      const userId = await person();
      const operator = await person();
      const basic = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await reject(basic.id, operator);
      const full = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      const again = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const byRecord = new Map((await history(userId)).map((c) => [c.recordId, c]));
      expect(byRecord.get(full.id)!.followsCaseId).toBeNull();
      expect(byRecord.get(again.id)!.followsCaseId).toBe(byRecord.get(basic.id)!.id);
      // A rejected case is followed once: a later reject and resubmit follows the newer case, not the first again.
      await reject(again.id, operator);
      const third = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const latest = new Map((await history(userId)).map((c) => [c.recordId, c]));
      expect(latest.get(third.id)!.followsCaseId).toBe(latest.get(again.id)!.id);
    });

    it('an approval whose level lapsed reads expired, with an expired step at the lapse, and nothing is written', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await auth.approveKycRecord({ recordId: record.id, reviewerId: await person(), approvalParties: [] });
      const [lapse] = await db.sql<Array<{ at: Date }>>`
        UPDATE kyc_records SET expires_at = now() - interval '1 hour' WHERE id = ${record.id} RETURNING expires_at AS at`;
      const before = await counts(userId);
      const [only] = await history(userId);
      expect(only).toMatchObject({ state: 'expired', version: 2, expiresAt: lapse!.at.toISOString() });
      expect(only!.history).toEqual([
        expect.objectContaining({ version: 1, state: 'submitted' }),
        expect.objectContaining({ version: 2, state: 'approved' }),
        { version: 3, state: 'expired', at: lapse!.at.toISOString() },
      ]);
      expect(await counts(userId)).toEqual(before);
      const [stored] = await db.sql<Array<{ state: string }>>`SELECT state FROM kyc_cases WHERE record_id = ${record.id}`;
      expect(stored!.state).toBe('approved');
    });

    it("the relay sends a case's rows in version order, and one case that fails does not hold the others back", async () => {
      const first = await person();
      const second = await person();
      const operator = await person();
      const a = await auth.submitKyc({ userId: first, tier: 'basic', jurisdiction: 'DE' });
      await reject(a.id, operator);
      await auth.submitKyc({ userId: second, tier: 'basic', jurisdiction: 'DE' });
      const [caseA] = await history(first);
      const failing = {
        publish: (async (...args: Parameters<typeof bus.publish>) => {
          if ((args[1] as { caseId: string }).caseId === caseA!.id) throw new Error('bus down for one case');
          return bus.publish(...args);
        }) as typeof bus.publish,
      };
      await expect(relay(failing)).rejects.toThrow('bus down for one case');
      expect(bus.emitted('kycSubmitted').map((e) => e.payload.userId)).toEqual([second]);
      expect(bus.emitted('kycRejected')).toHaveLength(0);
      bus.reset();
      expect(await relay()).toBe(2);
      const sent = [...bus.emitted('kycSubmitted'), ...bus.emitted('kycRejected')].map((e) => e.idempotencyKey);
      expect(sent).toEqual([`identity.kyc.submitted:${caseA!.id}:1`, `identity.kyc.rejected:${caseA!.id}:2`]);
      expect(await relay()).toBe(0);
    });

    it('a publish that fails leaves the row unpublished, for the next run to send again', async () => {
      const userId = await person();
      await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const failing = { publish: async () => Promise.reject(new Error('bus down')) };
      await expect(relay(failing)).rejects.toThrow('bus down');
      expect(await relay()).toBe(1);
      expect(bus.emitted('kycSubmitted')).toHaveLength(1);
    });
  });
}
