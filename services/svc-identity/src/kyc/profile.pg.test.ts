/**
 * Guided verification against Postgres (I-kyc-compliance-08, J-identity-08 #2). A draft resumes at the step left with
 * what was entered, sealed so no personal field is readable in the table; a stale save refuses and the same save twice
 * returns; a country with no published list says so; an over-size photo is refused with the cap; sending opens one
 * pending request with the photo as its reference, and sending again returns the same one; with no key every door refuses.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { kycProfileSchema } from '@intafaced/contracts/identity-kyc-profile';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { KycDocumentStore } from './document-store.js';
import { KycProfileDesk, parseKycDocumentTypes, parseKycUploadCaps } from './profile.js';

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
const TYPES = parseKycDocumentTypes(JSON.stringify({ DE: [{ type: 'passport', label: 'TEST: Passport', originalRequired: true }] }));
const CAPS = parseKycUploadCaps({ IDENTITY_KYC_UPLOAD_MAX_BYTES: '1024', IDENTITY_KYC_UPLOAD_TYPES: 'image/png' });

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('Guided verification (Postgres unavailable)', () => {
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
  const desk = new KycProfileDesk(db.sql, KEY, { documentTypes: TYPES, uploadCaps: CAPS, vault, submit: (input) => auth.submitKyc(input) });
  let n = 0;
  async function person() {
    const handle = `gp${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const fill = async (userId: string) => {
    let d = await desk.start(userId, 'basic');
    d = await desk.saveStep(userId, { step: 'residence', version: d.version, fields: { residence: 'DE', nationality: 'DE' } });
    d = await desk.saveStep(userId, {
      step: 'identity',
      version: d.version,
      fields: { legalName: 'TEST Anna Muster', localName: null, dateOfBirth: '1990-01-31' },
    });
    d = await desk.saveStep(userId, {
      step: 'document',
      version: d.version,
      fields: { documentType: 'passport', documentNumber: 'TEST123' },
    });
    d = await desk.saveStep(userId, {
      step: 'address',
      version: d.version,
      fields: { addressLine: 'TEST Str. 1', city: 'Berlin', postalCode: '10115' },
    });
    return desk.upload(userId, { version: d.version, contentType: 'image/png', bytes: PNG });
  };

  describe('Guided verification', () => {
    it('resumes at the step left with what was entered, and seals it', async () => {
      const userId = await person();
      expect(kycProfileSchema.parse(await desk.read(userId))).toMatchObject({ draft: null, documentCheck: 'not_connected' });
      let d = await desk.start(userId, 'full');
      expect(d).toMatchObject({ tier: 'full', step: 1, version: 1, recordId: null });
      d = await desk.saveStep(userId, { step: 'residence', version: 1, fields: { residence: 'DE', nationality: 'AT' } });
      d = await desk.saveStep(userId, {
        step: 'identity',
        version: d.version,
        fields: { legalName: 'TEST Anna Muster', localName: null, dateOfBirth: '1990-01-31' },
      });
      // Left here; a later read, and a later start, come back at step 3 with both steps kept.
      const read = kycProfileSchema.parse(await desk.read(userId));
      expect(read.draft).toMatchObject({
        step: 3,
        version: 3,
        fields: { residence: 'DE', nationality: 'AT', legalName: 'TEST Anna Muster' },
      });
      expect(await desk.start(userId, 'full')).toMatchObject({ step: 3, version: 3 });
      const [raw] = await db.sql<Array<{ c: Buffer }>>`SELECT ciphertext AS c FROM kyc_profile_drafts WHERE user_id = ${userId}`;
      expect(raw!.c.toString('latin1')).not.toContain('Anna');
    });

    it('a stale save refuses; the same save sent twice returns the draft it made', async () => {
      const userId = await person();
      const d = await desk.start(userId, 'basic');
      const save = { step: 'residence' as const, version: d.version, fields: { residence: 'DE', nationality: 'DE' } };
      const once = await desk.saveStep(userId, save);
      expect(await desk.saveStep(userId, save)).toEqual(once);
      await expect(desk.saveStep(userId, { ...save, fields: { residence: 'DE', nationality: 'FR' } })).rejects.toMatchObject({
        code: 'kyc.profile_version',
      });
      await expect(desk.saveStep(userId, { step: 'identity', version: once.version, fields: { legalName: '' } })).rejects.toMatchObject({
        code: 'kyc.profile_invalid',
      });
    });

    it('a country with no published list says so, and its document step refuses', async () => {
      const userId = await person();
      expect(desk.documentTypes('FR')).toEqual({ country: 'FR', published: false, types: [] });
      expect(desk.documentTypes('DE').types.map((t) => t.type)).toEqual(['passport']);
      let d = await desk.start(userId, 'basic');
      d = await desk.saveStep(userId, { step: 'residence', version: d.version, fields: { residence: 'FR', nationality: 'FR' } });
      d = await desk.saveStep(userId, {
        step: 'identity',
        version: d.version,
        fields: { legalName: 'TEST Anna Muster', localName: null, dateOfBirth: '1990-01-31' },
      });
      await expect(
        desk.saveStep(userId, { step: 'document', version: d.version, fields: { documentType: 'passport', documentNumber: 'X1' } }),
      ).rejects.toMatchObject({ code: 'kyc.document_types_unset', details: { country: 'FR' } });
    });

    it('an over-size or unlisted photo is refused with the cap and stores nothing', async () => {
      const userId = await person();
      const d = await desk.start(userId, 'basic');
      await expect(
        desk.upload(userId, { version: d.version, contentType: 'image/png', bytes: Buffer.alloc(1025, 1) }),
      ).rejects.toMatchObject({
        code: 'kyc.upload_too_large',
        details: { maxBytes: 1024 },
      });
      await expect(desk.upload(userId, { version: d.version, contentType: 'image/gif', bytes: PNG })).rejects.toMatchObject({
        code: 'kyc.upload_type',
      });
      const [docs] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_documents WHERE user_id = ${userId}`;
      expect(docs!.n).toBe(0);
      const unset = new KycProfileDesk(db.sql, KEY, {
        documentTypes: TYPES,
        uploadCaps: null,
        vault,
        submit: () => Promise.reject(new Error('no')),
      });
      await expect(unset.upload(userId, { version: d.version, contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({
        code: 'kyc.upload_caps_unset',
      });
    });

    it('sending needs every step; it opens one pending request with the photo, and sending again returns it', async () => {
      const userId = await person();
      const partial = await desk.start(userId, 'basic');
      await expect(desk.submit(userId, partial.version)).rejects.toMatchObject({
        code: 'kyc.profile_incomplete',
        details: { step: 'residence' },
      });
      const ready = await fill(userId);
      expect(ready.step).toBe(6);
      const sent = await desk.submit(userId, ready.version);
      expect(sent.documentCheck).toBe('not_connected');
      const [record] = await db.sql<Array<{ status: string; provider_ref: string; jurisdiction: string }>>`
        SELECT status, provider_ref, jurisdiction FROM kyc_records WHERE id = ${sent.recordId}`;
      expect(record).toMatchObject({ status: 'pending', jurisdiction: 'DE', provider_ref: ready.fields.documentId });
      expect(await desk.submit(userId, ready.version)).toEqual(sent);
      await expect(
        desk.saveStep(userId, { step: 'residence', version: ready.version + 1, fields: { residence: 'DE', nationality: 'DE' } }),
      ).rejects.toMatchObject({
        code: 'kyc.profile_sent',
      });
      // A new start after sending begins again at step 1.
      expect(await desk.start(userId, 'basic')).toMatchObject({ step: 1, recordId: null, fields: { residence: null } });
    });

    it('going back to fix a step keeps the later ones; a new photo replaces the old one in the vault', async () => {
      const userId = await person();
      const ready = await fill(userId);
      const first = ready.fields.documentId!;
      const fixed = await desk.saveStep(userId, {
        step: 'identity',
        version: ready.version,
        fields: { legalName: 'TEST Anna Musterfrau', localName: null, dateOfBirth: '1990-01-31' },
      });
      expect(fixed).toMatchObject({ step: 6, fields: { legalName: 'TEST Anna Musterfrau', documentId: first } });
      const again = await desk.upload(userId, {
        version: fixed.version,
        contentType: 'image/png',
        bytes: Buffer.concat([PNG, Buffer.from([1])]),
      });
      expect(again.fields.documentId).not.toBe(first);
      const docs = await db.sql<Array<{ id: string }>>`SELECT id FROM kyc_documents WHERE user_id = ${userId}`;
      expect(docs.map((d) => d.id)).toEqual([again.fields.documentId]);
      // A stale upload stores nothing that stays.
      await expect(desk.upload(userId, { version: fixed.version, contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({
        code: 'kyc.profile_version',
      });
      expect(await db.sql`SELECT id FROM kyc_documents WHERE user_id = ${userId}`).toHaveLength(1);
      await expect(
        desk.saveStep(userId, {
          step: 'identity',
          version: again.version,
          fields: { legalName: 'X', localName: null, dateOfBirth: '2099-01-01' },
        }),
      ).rejects.toMatchObject({ code: 'kyc.profile_invalid' });
    });

    it('a request already open at the level, from the plain form, is not taken over', async () => {
      const userId = await person();
      await auth.submitKyc({ userId, tier: 'basic', jurisdiction: 'DE' });
      const ready = await fill(userId);
      await expect(desk.submit(userId, ready.version)).rejects.toMatchObject({ code: 'kyc.profile_request_open' });
      expect(kycProfileSchema.parse(await desk.read(userId)).draft).toMatchObject({ recordId: null, version: ready.version });
    });

    it('with no key every door refuses and nothing is stored', async () => {
      const userId = await person();
      const keyless = new KycProfileDesk(db.sql, null, {
        documentTypes: TYPES,
        uploadCaps: CAPS,
        vault,
        submit: () => Promise.reject(new Error('no')),
      });
      await expect(keyless.read(userId)).rejects.toMatchObject({ code: 'kyc.profile_unconfigured' });
      await expect(keyless.start(userId, 'basic')).rejects.toMatchObject({ code: 'kyc.profile_unconfigured' });
      const [row] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_profile_drafts WHERE user_id = ${userId}`;
      expect(row!.n).toBe(0);
    });

    it('refuses skipping ahead: a step, or the photo, waits until the draft has reached it', async () => {
      const userId = await person();
      const d = await desk.start(userId, 'basic');
      await expect(
        desk.saveStep(userId, {
          step: 'address',
          version: d.version,
          fields: { addressLine: 'TEST Str. 1', city: 'Berlin', postalCode: '10115' },
        }),
      ).rejects.toMatchObject({ code: 'kyc.profile_incomplete', details: { step: 'residence' } });
      await expect(desk.upload(userId, { version: d.version, contentType: 'image/png', bytes: PNG })).rejects.toMatchObject({
        code: 'kyc.profile_incomplete',
      });
      const [count] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_documents WHERE user_id = ${userId}`;
      expect(count!.n).toBe(0);
    });

    it('a draft the key cannot open reads as none, flagged, and starting again replaces it', async () => {
      const userId = await person();
      await desk.start(userId, 'basic');
      await db.sql`UPDATE kyc_profile_drafts SET key_id = 'v0' WHERE user_id = ${userId}`;
      expect(await desk.read(userId)).toMatchObject({ draft: null, unreadableDraft: true });
      const fresh = await desk.start(userId, 'basic');
      expect(fresh).toMatchObject({ step: 1, recordId: null });
      expect(await desk.read(userId)).toMatchObject({ draft: { step: 1 }, unreadableDraft: false });
    });

    it('a send claims the draft first: a save from the version that was sent refuses, and the request is recorded once', async () => {
      const userId = await person();
      const ready = await fill(userId);
      const sent = await desk.submit(userId, ready.version);
      await expect(
        desk.saveStep(userId, {
          step: 'address',
          version: ready.version,
          fields: { addressLine: 'TEST Str. 2', city: 'Berlin', postalCode: '10115' },
        }),
      ).rejects.toMatchObject({ code: 'kyc.profile_sent' });
      const [count] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_records WHERE user_id = ${userId}`;
      expect(count!.n).toBe(1);
      expect((await desk.read(userId)).draft).toMatchObject({ recordId: sent.recordId });
    });

    it('a draft changed while its request was opening is not marked sent; the request stands and a resend says so', async () => {
      const userId = await person();
      const ready = await fill(userId);
      // While the request opens (no connection is held), another tab moves the draft on.
      const racing = new KycProfileDesk(db.sql, KEY, {
        documentTypes: TYPES,
        uploadCaps: CAPS,
        vault,
        submit: async (input) => {
          await db.sql`UPDATE kyc_profile_drafts SET version = version + 1 WHERE user_id = ${input.userId}`;
          return auth.submitKyc(input);
        },
      });
      await expect(racing.submit(userId, ready.version)).rejects.toMatchObject({ code: 'kyc.profile_version' });
      const after = (await desk.read(userId)).draft!;
      expect(after.recordId).toBeNull();
      // Same photo: the pending request that carries it is this draft's, so the resend records it.
      const resent = await desk.submit(userId, after.version);
      const [count] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_records WHERE user_id = ${userId}`;
      expect(count!.n).toBe(1);
      expect((await desk.read(userId)).draft).toMatchObject({ recordId: resent.recordId });
    });
  });
}
