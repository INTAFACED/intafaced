/**
 * Proof of address against Postgres (I-kyc-compliance-11, J-identity-08 #5). Asked for only after an approved level;
 * an unset rule refuses; a document older than the rule, a refused kind or an unlisted country refuses and stores
 * nothing; a document from another country than the residence is stored flagged for the reviewer.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { kycPoaReadSchema } from '@intafaced/contracts/identity-kyc-poa';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { KycDocumentStore } from './document-store.js';
import { parseKycUploadCaps } from './profile.js';
import { KycPoaDesk, parseKycPoaMaxAgeDays, parseKycPoaTypes } from './proof-of-address.js';

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

const KEY = randomBytes(32);
const TYPES = parseKycPoaTypes(
  JSON.stringify({
    DE: {
      accepted: [{ type: 'utility_bill', label: 'TEST: Utility bill' }],
      rejected: [{ type: 'screenshot', label: 'TEST: Screenshots' }],
    },
    FR: { accepted: [{ type: 'utility_bill', label: 'TEST: Utility bill' }] },
  }),
);
const CAPS = parseKycUploadCaps({ IDENTITY_KYC_UPLOAD_MAX_BYTES: '1024', IDENTITY_KYC_UPLOAD_TYPES: 'image/png,application/pdf' });

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('Proof of address (Postgres unavailable)', () => {
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
  const vault = new KycDocumentStore(db.sql, KEY.toString('base64'));
  const desk = new KycPoaDesk(db.sql, { maxAgeDays: parseKycPoaMaxAgeDays('90'), types: TYPES, uploadCaps: CAPS, vault });
  let n = 0;
  async function person(approved = true) {
    const handle = `pa${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    if (approved) {
      const record = await auth.submitKyc({ userId: session.userId, tier: 'basic', jurisdiction: 'DE' });
      const reviewer = await auth.register({
        handle: `${handle}r`,
        email: `${handle}r@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });
      await auth.approveKycRecord({ recordId: record.id, reviewerId: reviewer.userId, approvalParties: [] });
    }
    return session.userId;
  }
  const PDF = Buffer.from('%PDF-1.4 TEST');
  const NOW = new Date('2026-10-27T12:00:00Z');
  const docs = async (userId: string) =>
    (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_documents WHERE user_id = ${userId}`)[0]!.n;
  const send = (userId: string, over: Partial<{ type: string; country: string; issuedOn: string }> = {}) =>
    desk.submit(
      userId,
      { type: 'utility_bill', country: 'DE', issuedOn: '2026-09-01', contentType: 'application/pdf', bytes: PDF, ...over },
      NOW,
    );

  describe('Proof of address', () => {
    it('is asked for only after an approved level, and reads the lists for the residence', async () => {
      const before = await person(false);
      expect(kycPoaReadSchema.parse(await desk.read(before))).toMatchObject({ requested: false, residence: null, maxAgeDays: 90 });
      await expect(send(before)).rejects.toMatchObject({ code: 'kyc.poa_not_requested' });
      const userId = await person();
      const read = kycPoaReadSchema.parse(await desk.read(userId));
      expect(read).toMatchObject({ requested: true, residence: 'DE', documents: { country: 'DE', published: true }, latest: null });
      expect(read.documents.rejected.map((r) => r.type)).toEqual(['screenshot']);
      expect((await desk.read(userId, 'US')).documents).toEqual({ country: 'US', published: false, accepted: [], rejected: [] });
    });

    it('refuses an unset rule, a document too old, a refused kind, an unlisted country, a future date, and stores nothing', async () => {
      const userId = await person();
      const unset = new KycPoaDesk(db.sql, { maxAgeDays: null, types: TYPES, uploadCaps: CAPS, vault });
      await expect(
        unset.submit(
          userId,
          { type: 'utility_bill', country: 'DE', issuedOn: '2026-09-01', contentType: 'application/pdf', bytes: PDF },
          NOW,
        ),
      ).rejects.toMatchObject({
        code: 'kyc.poa_rule_unset',
      });
      await expect(send(userId, { issuedOn: '2026-07-01' })).rejects.toMatchObject({
        code: 'kyc.poa_too_old',
        details: { maxAgeDays: 90 },
      });
      await expect(send(userId, { type: 'screenshot' })).rejects.toMatchObject({ code: 'kyc.poa_type_refused' });
      await expect(send(userId, { country: 'US' })).rejects.toMatchObject({ code: 'kyc.poa_types_unset' });
      await expect(send(userId, { issuedOn: '2026-11-30' })).rejects.toMatchObject({ code: 'kyc.poa_date_invalid' });
      await expect(send(userId, { issuedOn: '2026-02-30' })).rejects.toMatchObject({ code: 'kyc.poa_date_invalid' });
      expect(await docs(userId)).toBe(0);
    });

    it('stores the file in the vault and the submission; another country than the residence is flagged', async () => {
      const userId = await person();
      const ok = await send(userId);
      expect(ok).toMatchObject({
        type: 'utility_bill',
        country: 'DE',
        issuedOn: '2026-09-01',
        status: 'submitted',
        countryMismatch: false,
      });
      expect(ok.label).toBe('TEST: Utility bill');
      expect((await desk.read(userId)).latest).toEqual(ok);
      // The same document sent again returns its pending submission and stores nothing more.
      expect(await send(userId)).toEqual(ok);
      expect(await docs(userId)).toBe(1);
      // Another document while this one waits for a reviewer refuses and stores nothing.
      await expect(send(userId, { country: 'FR' })).rejects.toMatchObject({ code: 'kyc.poa_pending' });
      expect(await docs(userId)).toBe(1);
      // Once a reviewer decides it, the next one is taken and both stay on the record; another country is flagged.
      await db.sql`UPDATE kyc_poa_submissions SET status = 'rejected' WHERE user_id = ${userId}`;
      const flagged = await send(userId, { country: 'FR' });
      expect(flagged.countryMismatch).toBe(true);
      expect(await docs(userId)).toBe(2);
      expect((await desk.read(userId)).latest).toEqual(flagged);
      expect((await desk.listFor(userId, 10)).map((s) => s.country)).toEqual(['FR', 'DE']);
    });

    it('dated today on a calendar east of UTC (already tomorrow in UTC) is accepted', async () => {
      const userId = await person();
      await expect(send(userId, { issuedOn: '2026-10-28' })).resolves.toMatchObject({ issuedOn: '2026-10-28' });
    });

    it('different documents sent at the same moment: one waits for a reviewer, the others refuse and store nothing', async () => {
      const userId = await person();
      const sent = await Promise.allSettled(['2026-09-06', '2026-09-07', '2026-09-08'].map((day) => send(userId, { issuedOn: day })));
      expect(sent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of sent.filter((r) => r.status === 'rejected')) expect(r.reason).toMatchObject({ code: 'kyc.poa_pending' });
      expect(await desk.listFor(userId, 10)).toHaveLength(1);
      expect(await docs(userId)).toBe(1);
    });

    it('two identical sends at the same moment store one submission and one file', async () => {
      const userId = await person();
      const [a, b] = await Promise.all([send(userId, { issuedOn: '2026-09-02' }), send(userId, { issuedOn: '2026-09-02' })]);
      expect(a).toEqual(b);
      expect(await docs(userId)).toBe(1);
      expect(await desk.listFor(userId, 10)).toHaveLength(1);
    });

    it('a document exactly at the rule is accepted all day on a calendar west of UTC', async () => {
      const userId = await person();
      // 20:00 in UTC-10 on 27 Oct is 06:00 UTC on 28 Oct; 90 days before 27 Oct is 29 Jul.
      const evening = new Date('2026-10-28T06:00:00Z');
      const at = (issuedOn: string) =>
        desk.submit(userId, { type: 'utility_bill', country: 'DE', issuedOn, contentType: 'application/pdf', bytes: PDF }, evening);
      await expect(at('2026-07-29')).resolves.toMatchObject({ issuedOn: '2026-07-29' });
      await expect(at('2026-07-27')).rejects.toMatchObject({ code: 'kyc.poa_too_old' });
    });

    it('an approved level whose country is not two letters reads as asked for with the residence unknown, and is flagged', async () => {
      const userId = await person();
      await db.sql`UPDATE kyc_records SET jurisdiction = 'd-' WHERE user_id = ${userId}`;
      expect(kycPoaReadSchema.parse(await desk.read(userId))).toMatchObject({ requested: true, residence: null });
      expect((await send(userId)).countryMismatch).toBe(true);
    });
  });
}
