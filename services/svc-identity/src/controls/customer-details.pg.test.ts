import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, CustomerDetailsEditInput } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { FounderControls, parseFounderPair } from './founder-controls.js';
import { CustomerDetailsDesk } from './customer-details.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'a-customer-details-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASON = 'Customer letter of 20 Oct, signed';

if (!available) {
  describe.skip('staff edits of customer details (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let controls: FounderControls;
  let desk: CustomerDetailsDesk;
  let first: Context;
  let second: Context;
  let customer: Context;
  let target: string;

  const seed = async (): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `d${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: ['identity:read', 'identity:write'], mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const id = (context: Context) => context.principal!.userId;
  const edit = (changes: CustomerDetailsEditInput['changes'], expectedVersion = '0', extra: Partial<CustomerDetailsEditInput> = {}) => ({
    requestId: randomUUID(),
    userId: target,
    expectedVersion,
    reason: REASON,
    changes,
    ...extra,
  });
  const decision = (reviewId: string, decision: 'pass' | 'reject', userId = target) => ({
    requestId: randomUUID(),
    userId,
    reviewId,
    decision,
    note: 'Passport and utility bill checked',
  });

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed();
    second = await seed();
    customer = await seed();
    target = id(customer);
    controls = new FounderControls(db.sql, parseFounderPair(id(first), id(second)));
    expect(await controls.bootstrap()).toBe(true);
    desk = new CustomerDetailsDesk(db.sql, controls, randomBytes(32));
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('staff edits of customer details (J-ops-console-04 #9)', () => {
    it('applies open details at once with one founder, keeps them encrypted, and the history names fields, never values', async () => {
      const applied = await desk.edit(first, edit({ phone: '+44 20 7946 0000', city: 'Leeds' }));
      expect(applied).toMatchObject({ outcome: 'applied', changed: true, fields: ['phone', 'city'], version: '1', reviewId: null });
      const state = await desk.state(first, { userId: target });
      expect(state).toMatchObject({
        version: '1',
        details: { phone: '+44 20 7946 0000', city: 'Leeds', legalName: null },
        openReview: null,
      });
      const [stored] = await db.sql<Array<{ ciphertext: Buffer }>>`SELECT ciphertext FROM customer_details WHERE user_id = ${target}`;
      expect(stored!.ciphertext.toString('latin1')).not.toContain('Leeds');
      const history = await desk.history(first, { userId: target, limit: 10 });
      expect(history).toHaveLength(1);
      expect(JSON.stringify(history)).not.toContain('Leeds');
      const events = await db.sql<Array<{ result: unknown }>>`SELECT result FROM customer_detail_events`;
      expect(JSON.stringify(events)).not.toContain('7946');
      // Clearing a detail is a change; the same values again are none.
      expect(await desk.edit(first, edit({ city: null }, '1'))).toMatchObject({ outcome: 'applied', version: '2' });
      expect(await desk.edit(first, edit({ phone: '+44 20 7946 0000' }, '2'))).toMatchObject({ code: 'identity.details_unchanged' });
      expect(await desk.edit(first, edit({ phone: '+44 1' }, '1'))).toMatchObject({ outcome: 'conflict', version: '2' });
    });

    it('applies a protected change only through a review the other founder passes, and a reject changes nothing', async () => {
      const opened = await desk.edit(first, edit({ legalName: 'Ada Lovelace', dateOfBirth: '1990-12-10' }));
      expect(opened).toMatchObject({ outcome: 'review_opened', fields: ['legalName', 'dateOfBirth'] });
      const reviewId = opened.reviewId!;
      let state = (await desk.state(first, { userId: target }))!;
      expect(state.details.legalName).toBeNull();
      expect(state.openReview).toMatchObject({
        reviewId,
        status: 'open',
        proposed: { legalName: 'Ada Lovelace', dateOfBirth: '1990-12-10' },
      });
      // One open review at a time, and the requester cannot decide their own.
      expect(await desk.edit(first, edit({ taxNumber: 'AB123456C' }))).toMatchObject({
        code: 'identity.details_review_open',
        reviewId,
      });
      expect(await desk.decide(first, decision(reviewId, 'pass'))).toMatchObject({ code: 'identity.details_review_self_forbidden' });
      expect((await desk.state(first, { userId: target }))!.details.legalName).toBeNull();
      const done = await desk.decide(second, decision(reviewId, 'pass'));
      expect(done).toMatchObject({ outcome: 'applied', changed: true, actorUserId: id(second), reviewId, version: '1' });
      state = (await desk.state(first, { userId: target }))!;
      expect(state).toMatchObject({ version: '1', details: { legalName: 'Ada Lovelace', dateOfBirth: '1990-12-10' }, openReview: null });
      expect(await desk.decide(second, decision(reviewId, 'pass'))).toMatchObject({ code: 'identity.details_review_closed' });
      // A review named under another customer, or one that does not exist, is not found and is filed under the customer named.
      const other = id(await seed());
      expect(await desk.decide(second, decision(reviewId, 'pass', other))).toMatchObject({
        code: 'identity.details_review_not_found',
        userId: other,
      });
      expect(await desk.decide(second, decision(randomUUID(), 'pass'))).toMatchObject({
        code: 'identity.details_review_not_found',
        userId: target,
      });

      const renamed = await desk.edit(first, edit({ legalName: 'Ada King' }, '1'));
      expect(await desk.decide(second, decision(renamed.reviewId!, 'reject'))).toMatchObject({
        outcome: 'review_rejected',
        version: '1',
      });
      expect((await desk.state(first, { userId: target }))!.details.legalName).toBe('Ada Lovelace');
      const reviews = await desk.reviews(first, { userId: target, limit: 10 });
      expect(reviews.map((r) => r.status)).toEqual(['rejected', 'passed']);
      expect(reviews[1]).toMatchObject({ requestedBy: id(first), decidedBy: id(second) });
    });

    it('refuses a mixed edit, unknown documents, a founder record, an archived record and anyone who is not a live founder', async () => {
      expect(await desk.edit(first, edit({ legalName: 'Ada Lovelace', city: 'Leeds' }))).toMatchObject({
        code: 'identity.details_mixed_edit',
      });
      expect(await desk.edit(first, edit({ city: 'Leeds' }, '0', { documentIds: [randomUUID()] }))).toMatchObject({
        code: 'identity.details_mixed_edit',
      });
      expect(await desk.edit(first, edit({ legalName: 'Ada Lovelace' }, '0', { documentIds: [randomUUID()] }))).toMatchObject({
        code: 'identity.details_documents_unknown',
      });
      const documentId = randomUUID();
      await db.sql`INSERT INTO kyc_documents (id, user_id, content_type, byte_length, ciphertext, nonce)
        VALUES (${documentId}, ${target}, 'application/pdf', 4, ${Buffer.from('test')}, ${Buffer.alloc(12)})`;
      const withDocument = await desk.edit(first, edit({ legalName: 'Ada Lovelace' }, '0', { documentIds: [documentId] }));
      expect(withDocument).toMatchObject({ outcome: 'review_opened' });
      expect((await desk.state(first, { userId: target }))!.openReview!.documentIds).toEqual([documentId]);

      target = id(second);
      expect(await desk.edit(first, edit({ city: 'Leeds' }))).toMatchObject({ code: 'identity.details_founder_forbidden' });
      target = id(customer);
      // Someone who is not a live founder is answered and leaves nothing in the founders' history.
      const before = (await desk.history(first, { userId: target, limit: 50 })).length;
      expect(await desk.edit(customer, edit({ city: 'Leeds' }))).toMatchObject({ code: 'operator.denied' });
      expect(await desk.decide(customer, decision(withDocument.reviewId!, 'pass'))).toMatchObject({ code: 'operator.denied' });
      expect(await desk.history(first, { userId: target, limit: 50 })).toHaveLength(before);
      await expect(desk.state(customer, { userId: target })).rejects.toMatchObject({ code: 'operator.denied' });

      await db.sql`UPDATE users SET status = 'closed', archived_at = now(), archive_reason = 'dormant' WHERE id = ${target}`;
      expect(await desk.edit(first, edit({ city: 'Leeds' }))).toMatchObject({ code: 'identity.account_archived' });
      expect(await desk.decide(second, decision(withDocument.reviewId!, 'pass'))).toMatchObject({ code: 'identity.account_archived' });
      expect(await desk.state(first, { userId: target })).toMatchObject({ archived: true });
    });

    it('returns the stored answer for the same request id, refuses another body under it, and refuses with no key', async () => {
      const input = edit({ city: 'Leeds' });
      const applied = await desk.edit(first, input);
      expect(await desk.edit(first, input)).toEqual(applied);
      expect(await desk.edit(first, { ...input, changes: { city: 'York' } })).toMatchObject({ code: 'request.conflict' });
      expect((await desk.state(first, { userId: target }))!.details.city).toBe('Leeds');

      const unkeyed = new CustomerDetailsDesk(db.sql, controls, null);
      expect(await unkeyed.edit(first, edit({ city: 'York' }, '1'))).toMatchObject({ code: 'identity.details_unconfigured' });
      await expect(unkeyed.state(first, { userId: target })).rejects.toMatchObject({ code: 'identity.details_unconfigured' });
      expect(await desk.history(first, { userId: target, limit: 50 })).toHaveLength(2);
      expect(await desk.state(first, { userId: id(await seed()) })).toMatchObject({ version: '0', openReview: null });
      expect(await desk.state(first, { userId: randomUUID() })).toBeNull();
    });

    it('refuses identity.details_unreadable, and writes nothing, when the key no longer opens the record', async () => {
      await desk.edit(first, edit({ city: 'Leeds' }));
      const rotated = new CustomerDetailsDesk(db.sql, controls, randomBytes(32));
      await expect(rotated.state(first, { userId: target })).rejects.toMatchObject({ code: 'identity.details_unreadable' });
      await expect(rotated.edit(first, edit({ city: 'York' }, '1'))).rejects.toMatchObject({ code: 'identity.details_unreadable' });
      await db.sql`UPDATE customer_details SET key_id = 'v2' WHERE user_id = ${target}`;
      await expect(desk.state(first, { userId: target })).rejects.toMatchObject({ code: 'identity.details_unreadable' });
      await db.sql`UPDATE customer_details SET key_id = 'v1' WHERE user_id = ${target}`;
      expect(await desk.state(first, { userId: target })).toMatchObject({ version: '1', details: { city: 'Leeds' } });
    });
  });

  describe('the own-name rule (P-ads-merchant-18, J-p2p-04 #2)', () => {
    it('answers only the outcome: unverified until a legal name passes review, then match or mismatch after normalising', async () => {
      expect(await desk.holderNameCheck({ userId: target, name: 'Anna-Lena Müller' })).toEqual({ userId: target, outcome: 'unverified' });
      // An open review is not a verified name.
      const opened = await desk.edit(first, edit({ legalName: 'Anna-Lena Müller' }));
      expect(await desk.holderNameCheck({ userId: target, name: 'Anna-Lena Müller' })).toMatchObject({ outcome: 'unverified' });
      await desk.decide(second, decision(opened.reviewId!, 'pass'));
      for (const name of ['Anna-Lena Müller', 'anna lena muller', '  ANNA  LENA  MÜLLER ', 'Anna-Lena Mu\u0308ller']) {
        expect(await desk.holderNameCheck({ userId: target, name })).toEqual({ userId: target, outcome: 'match' });
      }
      for (const name of ['Müller Anna-Lena', 'Anna Müller', 'Anna-Lena Müllerr']) {
        expect(await desk.holderNameCheck({ userId: target, name })).toEqual({ userId: target, outcome: 'mismatch' });
      }
      // Open details alone are not a name: a customer with only a city is unverified too.
      const other = id(await seed());
      await desk.edit(first, { ...edit({ city: 'Leeds' }), userId: other });
      expect(await desk.holderNameCheck({ userId: other, name: 'Leeds' })).toMatchObject({ outcome: 'unverified' });
      expect(await desk.holderNameCheck({ userId: randomUUID(), name: 'Anna-Lena Müller' })).toBeNull();
    });

    it('is unconfigured without the key, and refuses a record the key cannot open', async () => {
      const opened = await desk.edit(first, edit({ legalName: 'Ada Lovelace' }));
      await desk.decide(second, decision(opened.reviewId!, 'pass'));
      const keyless = new CustomerDetailsDesk(db.sql, controls, null);
      expect(await keyless.holderNameCheck({ userId: target, name: 'Ada Lovelace' })).toEqual({ userId: target, outcome: 'unconfigured' });
      const otherKey = new CustomerDetailsDesk(db.sql, controls, randomBytes(32));
      await expect(otherKey.holderNameCheck({ userId: target, name: 'Ada Lovelace' })).rejects.toMatchObject({
        code: 'identity.details_unreadable',
      });
    });
  });
}
