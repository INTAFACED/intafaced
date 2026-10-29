/**
 * Selfie against Postgres (I-kyc-compliance-09, J-identity-08 #3). With the face match not connected a selfie is kept
 * for a person to compare; a hand-off link works once, only for its own account, and not after it expires; an unset
 * link life refuses; a refused file stores nothing.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { kycSelfieReadSchema } from '@intafaced/contracts/identity-kyc-selfie';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { KycDocumentStore } from './document-store.js';
import { parseKycUploadCaps } from './profile.js';
import { KycSelfieDesk, parseKycHandoffTtlSeconds, parseKycLivenessRecheckFor } from './selfie.js';

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
const CAPS = parseKycUploadCaps({ IDENTITY_KYC_UPLOAD_MAX_BYTES: '1024', IDENTITY_KYC_UPLOAD_TYPES: 'image/jpeg,application/pdf' });

describe('Selfie settings', () => {
  it('reads unset as none, and stops the service on a malformed value', () => {
    expect(parseKycHandoffTtlSeconds(undefined)).toBeNull();
    expect(parseKycHandoffTtlSeconds('600')).toBe(600);
    expect(() => parseKycHandoffTtlSeconds('10')).toThrow(/60 to 3600/);
    expect(() => parseKycHandoffTtlSeconds('ten')).toThrow(/whole number/);
    expect(parseKycLivenessRecheckFor(' ')).toBeNull();
    expect(parseKycLivenessRecheckFor('withdraw.crypto, signin.new_device')).toEqual(['withdraw.crypto', 'signin.new_device']);
    expect(() => parseKycLivenessRecheckFor('withdraw,withdraw')).toThrow(/distinct/);
    expect(() => parseKycLivenessRecheckFor('Withdraw!')).toThrow(/action names/);
  });
});

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('Selfie (Postgres unavailable)', () => {
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
  const desk = new KycSelfieDesk(db.sql, { handoffTtlSeconds: 600, recheckFor: null, uploadCaps: CAPS, vault });
  let n = 0;
  async function person() {
    const handle = `sf${process.pid}x${++n}`;
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const docs = async (userId: string) =>
    (await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_documents WHERE user_id = ${userId}`)[0]!.n;

  describe('Selfie', () => {
    it('keeps a selfie for a person to compare, with the face match and liveness not connected', async () => {
      const userId = await person();
      expect(kycSelfieReadSchema.parse(await desk.read(userId))).toMatchObject({
        latest: null,
        faceCheck: 'not_connected',
        liveness: { check: 'not_connected', recheckFor: null },
        handoffTtlSeconds: 600,
      });
      const selfie = await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      expect(selfie).toMatchObject({ status: 'provided', via: 'this_device' });
      expect((await desk.read(userId)).latest).toEqual(selfie);
      expect(await desk.listFor(userId, 10)).toEqual([
        { ...selfie, documentId: expect.any(String), captureCheck: 'not_checked', decidedAt: null },
      ]);
      expect(await docs(userId)).toBe(1);
    });

    it('a retake replaces a selfie nobody has decided, row and frame; a decided one is kept', async () => {
      const userId = await person();
      const REVIEWER = await person();
      const first = await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      const second = await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      expect((await desk.listFor(userId, 10)).map((s) => s.id)).toEqual([second.id]);
      expect(await docs(userId)).toBe(1);
      await expect(
        desk.decide({ selfieId: first.id, decision: 'accepted', reviewerId: REVIEWER, approvalParties: [] }),
      ).rejects.toMatchObject({
        code: 'kyc.selfie_unknown',
      });
      await desk.decide({ selfieId: second.id, decision: 'rejected', reviewerId: REVIEWER, approvalParties: [] });
      const third = await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      expect((await desk.listFor(userId, 10)).map((s) => [s.id, s.status])).toEqual([
        [third.id, 'provided'],
        [second.id, 'rejected'],
      ]);
      expect(await docs(userId)).toBe(2);
    });

    it('two sends at the same moment leave one undecided selfie and one frame', async () => {
      const userId = await person();
      await Promise.all(Array.from({ length: 8 }, () => desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG })));
      expect((await desk.listFor(userId, 10)).map((s) => s.status)).toEqual(['provided']);
      expect(await docs(userId)).toBe(1);
    });

    it('a person decides a selfie once: the same decision again returns it, the other refuses', async () => {
      const userId = await person();
      const reviewer = await person();
      const selfie = await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      expect(await desk.assertDecidable(selfie.id, 'accepted')).toBe(userId);
      const decided = await desk.decide({ selfieId: selfie.id, decision: 'accepted', reviewerId: reviewer, approvalParties: [] });
      expect(decided).toMatchObject({ id: selfie.id, status: 'accepted', decidedAt: expect.any(String) });
      expect(await desk.decide({ selfieId: selfie.id, decision: 'accepted', reviewerId: reviewer, approvalParties: [] })).toEqual(decided);
      await expect(desk.assertDecidable(selfie.id, 'rejected')).rejects.toMatchObject({ code: 'kyc.selfie_decided' });
      await expect(
        desk.decide({ selfieId: selfie.id, decision: 'rejected', reviewerId: reviewer, approvalParties: [] }),
      ).rejects.toMatchObject({
        code: 'kyc.selfie_decided',
      });
      // Nobody decides their own, whether as the reviewer or as a party to the approval.
      const mine = await desk.submit(reviewer, { contentType: 'image/jpeg', bytes: JPEG });
      await expect(
        desk.decide({ selfieId: mine.id, decision: 'accepted', reviewerId: userId, approvalParties: [reviewer] }),
      ).rejects.toMatchObject({
        code: 'auth.kyc_self_review',
      });
      expect((await desk.read(userId)).latest).toMatchObject({ status: 'accepted' });
    });

    it("a new phone link replaces the account's unused ones", async () => {
      const userId = await person();
      const old = await desk.startHandoff(userId);
      const fresh = await desk.startHandoff(userId);
      // A replaced link is expired, so the phone holding it says so, and it cannot be used.
      expect(await desk.checkHandoff(userId, old.token)).toMatchObject({ state: 'expired' });
      await expect(desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG, handoff: old.token })).rejects.toMatchObject({
        code: 'kyc.handoff_expired',
      });
      expect(await desk.checkHandoff(userId, fresh.token)).toMatchObject({ state: 'open' });
      await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG, handoff: fresh.token });
      // A used link stays while its selfie does, so the phone can still say it was used.
      await desk.startHandoff(userId);
      expect(await desk.checkHandoff(userId, fresh.token)).toMatchObject({ state: 'used' });
      const [links] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_selfie_handoffs WHERE user_id = ${userId}`;
      expect(links!.n).toBe(2);
    });

    it('a retake keeps a frame compliance bound to a verification record', async () => {
      const userId = await person();
      await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      const [{ documentId }] = (await desk.listFor(userId, 1)) as [{ documentId: string }];
      await db.sql`INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status) VALUES (${userId}, 'basic', 'DE', ${documentId}, 'pending')`;
      await desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG });
      expect((await desk.listFor(userId, 10)).map((s) => s.status)).toEqual(['provided']);
      expect(await docs(userId)).toBe(2);
      const [kept] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kyc_documents WHERE id = ${documentId}`;
      expect(kept!.n).toBe(1);
    });

    it('refuses a file that is not a photo, or over the caps, and stores nothing', async () => {
      const userId = await person();
      await expect(desk.submit(userId, { contentType: 'application/pdf', bytes: JPEG })).rejects.toMatchObject({ code: 'kyc.selfie_type' });
      await expect(desk.submit(userId, { contentType: 'image/jpeg', bytes: Buffer.alloc(2048, 1) })).rejects.toMatchObject({
        code: 'kyc.upload_too_large',
      });
      await expect(desk.submit(userId, { contentType: 'image/png', bytes: JPEG })).rejects.toMatchObject({ code: 'kyc.upload_type' });
      expect(await docs(userId)).toBe(0);
    });

    it('a hand-off link works once, only for its own account, and two sends of it store one selfie', async () => {
      const userId = await person();
      const other = await person();
      const link = await desk.startHandoff(userId);
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await desk.checkHandoff(userId, link.token)).toMatchObject({ state: 'open' });
      await expect(desk.checkHandoff(other, link.token)).rejects.toMatchObject({ code: 'kyc.handoff_unknown' });
      await expect(desk.submit(other, { contentType: 'image/jpeg', bytes: JPEG, handoff: link.token })).rejects.toMatchObject({
        code: 'kyc.handoff_unknown',
      });
      const results = await Promise.allSettled([
        desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG, handoff: link.token }),
        desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG, handoff: link.token }),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'kyc.handoff_used' } });
      expect((won[0] as PromiseFulfilledResult<{ via: string }>).value.via).toBe('handoff');
      expect(await desk.checkHandoff(userId, link.token)).toMatchObject({ state: 'used' });
      await expect(desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG, handoff: link.token })).rejects.toMatchObject({
        code: 'kyc.handoff_used',
      });
      // The loser's frame is removed from the vault: one selfie, one stored file.
      expect(await docs(userId)).toBe(1);
      expect(await docs(other)).toBe(0);
      const [stored] = await db.sql<
        Array<{ token_sha256: string }>
      >`SELECT token_sha256 FROM kyc_selfie_handoffs WHERE user_id = ${userId}`;
      expect(stored!.token_sha256).not.toContain(link.token);
    });

    it('refuses an expired link, and a hand-off when no link life is set', async () => {
      const userId = await person();
      const link = await desk.startHandoff(userId);
      await db.sql`UPDATE kyc_selfie_handoffs SET expires_at = now() - interval '1 second' WHERE user_id = ${userId}`;
      expect(await desk.checkHandoff(userId, link.token)).toMatchObject({ state: 'expired' });
      await expect(desk.submit(userId, { contentType: 'image/jpeg', bytes: JPEG, handoff: link.token })).rejects.toMatchObject({
        code: 'kyc.handoff_expired',
      });
      const unset = new KycSelfieDesk(db.sql, { handoffTtlSeconds: null, recheckFor: null, uploadCaps: CAPS, vault });
      await expect(unset.startHandoff(userId)).rejects.toMatchObject({ code: 'kyc.handoff_unset' });
      expect(await docs(userId)).toBe(0);
    });
  });
}
