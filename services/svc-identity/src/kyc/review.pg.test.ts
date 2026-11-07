/**
 * The verification review queue against Postgres (I-kyc-compliance-02, J-identity-20 #1 #2): open cases a page of the
 * owner's page size at a time, oldest first, with an exact next-page marker; two reviewers claiming at once, one wins and
 * the other is refused kyc.case_assigned; a decided case cannot be claimed; notes are append-only and never in the
 * customer's history; an unset page size refuses.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { kycHistoryOutputSchema, kycReviewCaseSchema, kycReviewListOutputSchema } from '@intafaced/contracts/identity-kyc-cases';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { parseKycRejectReasons } from './cases.js';
import { KycReviewDesk, KycReviewError, decodeQueueCursor, parseKycQueuePageSize } from './review.js';

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
  describe.skip('KYC review queue (Postgres unavailable)', () => {
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
  let n = 0;
  async function person() {
    const handle = `kr${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }
  const reject = (recordId: string, reviewerId: string, reasonCode = 'document_unreadable', extra = {}) =>
    auth.rejectKycRecord({ recordId, reviewerId, reasonCode, approvalParties: [], ...extra });
  const history = async (userId: string) => kycHistoryOutputSchema.parse({ cases: await auth.listKycCases(userId, 50, REASONS) }).cases;
  const desk = (pageSize: number | null = 2) => new KycReviewDesk(db.sql, { pageSize, reasons: REASONS });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (err) {
      return err instanceof KycReviewError ? err.code : String(err);
    }
  };

  describe('KYC review queue', () => {
    it('reads the owner page size strictly; unset refuses the queue', async () => {
      expect(parseKycQueuePageSize(undefined)).toBeNull();
      expect(parseKycQueuePageSize(' ')).toBeNull();
      expect(parseKycQueuePageSize('25')).toBe(25);
      expect(() => parseKycQueuePageSize('0')).toThrow();
      expect(() => parseKycQueuePageSize('2.5')).toThrow();
      expect(() => parseKycQueuePageSize('201')).toThrow();
      expect(await code(desk(null).list(null))).toBe('kyc.queue_page_size_unset');
      expect(await code(desk().list('not-a-cursor'))).toBe('kyc.queue_cursor_invalid');
    });

    it('pages open cases oldest first, never repeating or skipping one, and leaves decided cases out', async () => {
      await db.sql`UPDATE kyc_cases SET state = 'expired' WHERE state = 'submitted'`;
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const record = await auth.submitKyc({ userId: await person(), tier: 'basic', jurisdiction: 'DE' });
        ids.push(record.id);
      }
      await reject(ids[2]!, await person());
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = kycReviewListOutputSchema.parse(await desk(2).list(cursor));
        expect(page.pageSize).toBe(2);
        expect(page.cases.length).toBeLessThanOrEqual(2);
        if (page.nextCursor) expect(page.cases).toHaveLength(2);
        seen.push(...page.cases.map((c) => c.recordId));
        cursor = page.nextCursor;
        if (cursor) expect(decodeQueueCursor(cursor).id).toBe(page.cases[1]!.caseId);
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual([ids[0], ids[1], ids[3], ids[4]]);
      expect(pages).toBe(2);
    });

    it('two reviewers claiming at once: exactly one wins, the other is refused kyc.case_assigned', async () => {
      const userId = await person();
      const [a, b] = [await person(), await person()];
      await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const [{ id: caseId }] = await db.sql<Array<{ id: string }>>`SELECT id FROM kyc_cases WHERE user_id = ${userId}`;
      const results = await Promise.all([code(desk().assign(caseId!, a, 'claim')), code(desk().assign(caseId!, b, 'claim'))]);
      expect(results.sort()).toEqual(['kyc.case_assigned', 'resolved']);
      const holder = (await desk().read(caseId!)).assignedTo;
      expect([a, b]).toContain(holder);
      const other = holder === a ? b : a;
      // The holder claiming again returns the stored claim; the other cannot release it.
      expect((await desk().assign(caseId!, holder!, 'claim')).assignedTo).toBe(holder);
      expect(await code(desk().assign(caseId!, other, 'release'))).toBe('kyc.case_not_assigned');
      expect((await desk().assign(caseId!, holder!, 'release')).assignedTo).toBeNull();
      expect((await desk().assign(caseId!, other, 'claim')).assignedTo).toBe(other);
    });

    it('a decided case cannot be claimed; an unknown case is kyc.case_unknown', async () => {
      const userId = await person();
      const record = await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      await reject(record.id, await person());
      const [{ id: caseId }] = await db.sql<Array<{ id: string }>>`SELECT id FROM kyc_cases WHERE record_id = ${record.id}`;
      expect(await code(desk().assign(caseId!, await person(), 'claim'))).toBe('kyc.case_state');
      expect(await code(desk().read('00000000-0000-4000-8000-000000000000'))).toBe('kyc.case_unknown');
    });

    it('a case reads with its history, the owner reasons and append-only notes the customer never sees', async () => {
      const userId = await person();
      const reviewer = await person();
      const record = await auth.submitKyc({ userId, tier: 'full', jurisdiction: 'DE' });
      const [{ id: caseId }] = await db.sql<Array<{ id: string }>>`SELECT id FROM kyc_cases WHERE record_id = ${record.id}`;
      await desk().addNote(caseId!, reviewer, 'TEST: internal note one');
      await desk().addNote(caseId!, reviewer, 'TEST: internal note two');
      const read = kycReviewCaseSchema.parse(await desk().read(caseId!));
      expect(read.userId).toBe(userId);
      expect(read.recordStatus).toBe('pending');
      expect(read.case).toMatchObject({ id: caseId, recordId: record.id, state: 'submitted' });
      expect(read.reasonCodes.map((r) => r.code)).toEqual(['document_unreadable', 'name_mismatch']);
      expect(read.notes.map((n) => n.body)).toEqual(['TEST: internal note one', 'TEST: internal note two']);
      const customerSees = JSON.stringify(await history(userId));
      expect(customerSees).not.toContain('internal note');
    });
  });
}
