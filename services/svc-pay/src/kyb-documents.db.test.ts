import { truncatePayForTest } from './payment-events-test-reset.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { KybApplicationService } from './kyb-application.js';
import { KybDocumentService } from './kyb-documents.js';
import { KybEntityTypeService } from './kyb-entity-types.js';
import { createKybPspRouter } from './kyb-router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { KybService } from './kyb-service.js';
import { PspModeService } from './psp-mode.js';

/**
 * KYB documents: checklist and upload (I-kyc-compliance-22).
 * Postgres required, like the other KYB suites: TEST_DATABASE_URL, or a Testcontainers postgres:16-alpine. No skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const IMAGE = 'postgres:16-alpine';
const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OWNER = '66666666-6666-4666-8666-666666666666';
const STRANGER = '88888888-8888-4888-8888-888888888888';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_kyb_docs_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `KYB documents are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${msg}`,
    );
  }
}

async function ctx(userId: string, scopes: string[] = ['pay:onboard'], mfa = true): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: '77777777-7777-4777-8777-777777777777', scopes, tier: 'full', mfa },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'kyb-documents' };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, but the call resolved');
}

const KEY = randomBytes(32);
const PDF = 'application/pdf';

describe('kyb documents', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let merchantId: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.kyb_document_reads, pay.kyb_document_reviews, pay.kyb_documents, pay.kyb_upload_rules, pay.kyb_application_events, pay.kyb_application_sections, pay.kyb_applications, pay.kyb_entity_types, pay.merchant_kyb_events, pay.merchant_status_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, status, pricing) VALUES (${OWNER}, 'psp', 'active', ${sql.json({ feeBps: 250 } as never)}) RETURNING id
    `;
    if (!row) throw new Error('no merchant');
    merchantId = row.id;
    await sql`
      INSERT INTO pay.kyb_entity_types (entity_type, document_keys, people_roles, questionnaire_keys, countries)
      VALUES ('trust', ${['trust_deed', 'proof_of_address']}, ${[]}, ${[]}, ${['DE']})
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const publishRules = (maxBytes = 1024) =>
    sql`INSERT INTO pay.kyb_upload_rules (max_bytes, content_types) VALUES (${maxBytes}, ${[PDF, 'image/png']})`;

  const api = async (opts: { userId?: string; key?: Buffer | null; scopes?: string[]; mfa?: boolean } = {}) => {
    const kyb = new KybService(sql);
    const types = new KybEntityTypeService(sql);
    return createKybPspRouter(
      kyb,
      new PspModeService(sql),
      stubApprovalConsumer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      {
        getMerchant: async (id) =>
          (await sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.merchants WHERE id = ${id}`).map((r) => ({
            userId: r.user_id,
          }))[0] ?? Promise.reject(new Error('missing')),
      },
      types,
      new KybApplicationService(sql, kyb, types),
      new KybDocumentService(sql, types, opts.key === undefined ? KEY : opts.key),
    ).createCaller(await ctx(opts.userId ?? OWNER, opts.scopes, opts.mfa));
  };

  const startApplication = async () => {
    const owner = await api();
    return (await owner.kyb.application.start({ merchantId, entityType: 'trust', country: 'DE' })).applicationId;
  };

  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('lists every required document as missing, with the check shown as not connected and rules unset', async () => {
    const id = await startApplication();
    const view = await (await api()).kyb.documents.checklist({ applicationId: id });
    expect(view.rows.map((r) => [r.key, r.state, r.document])).toEqual([
      ['trust_deed', 'missing', null],
      ['proof_of_address', 'missing', null],
    ]);
    expect(view.uploadRules).toBeNull();
    expect(view.vendorCheck).toEqual({ status: 'not_connected', notConnected: 'vendor.kyc' });
  });

  it('refuses an upload while the owner has not published rules, and while the key is unset, and stores nothing', async () => {
    const id = await startApplication();
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('deed') };
    expect(await rejection((await api()).kyb.documents.upload(input))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_upload_rules_unset' }),
    });
    await publishRules();
    expect(await rejection((await api({ key: null })).kyb.documents.upload(input))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_doc_key_unset' }),
    });
    const counted = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents`;
    expect(counted[0]?.n).toBe('0');
  });

  it('stores an upload encrypted, shows it as provided, and the same bytes again are the same document', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const text = 'the trust deed';
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64(text) };
    const first = await owner.kyb.documents.upload(input);
    expect(first.row.state).toBe('provided');
    expect(first.row.document?.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    const again = await owner.kyb.documents.upload(input);
    expect(again.row.document?.id).toBe(first.row.document?.id);
    const rows = await sql<Array<{ ciphertext: Buffer }>>`SELECT ciphertext FROM pay.kyb_documents`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext.includes(Buffer.from(text))).toBe(false);
    const view = await owner.kyb.documents.checklist({ applicationId: id });
    expect(view.rows.find((r) => r.key === 'trust_deed')?.state).toBe('provided');
    expect(view.rows.find((r) => r.key === 'proof_of_address')?.state).toBe('missing');
    expect(view.uploadRules).toEqual({ maxBytes: 1024, contentTypes: [PDF, 'image/png'] });
  });

  it('after a restart the checklist asks for every document again, and the same file sent again counts as new', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('the deed') };
    const before = await owner.kyb.documents.upload(input);
    await owner.kyb.application.restart({ applicationId: id, confirm: true });
    const cleared = await owner.kyb.documents.checklist({ applicationId: id });
    expect(cleared.rows.map((r) => r.state)).toEqual(['missing', 'missing']);
    const after = await owner.kyb.documents.upload(input);
    expect(after.row.document?.id).not.toBe(before.row.document?.id);
    const view = await owner.kyb.documents.checklist({ applicationId: id });
    expect(view.rows.find((r) => r.key === 'trust_deed')).toMatchObject({ state: 'provided', document: { id: after.row.document?.id } });
    // Both uploads are kept; only the one after the restart counts.
    const kept = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents WHERE application_id = ${id}`;
    expect(kept[0]?.n).toBe('2');
  });

  it('a later upload for the key replaces what the checklist shows', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const base = { applicationId: id, key: 'trust_deed', contentType: PDF };
    await owner.kyb.documents.upload({ ...base, bytesBase64: b64('v1') });
    const second = await owner.kyb.documents.upload({ ...base, bytesBase64: b64('v2') });
    const view = await owner.kyb.documents.checklist({ applicationId: id });
    expect(view.rows[0]?.document?.id).toBe(second.row.document?.id);
  });

  it('sending an earlier file again makes it the current one, and the latest bytes again change nothing', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const base = { applicationId: id, key: 'trust_deed', contentType: PDF };
    const a = await owner.kyb.documents.upload({ ...base, bytesBase64: b64('file A') });
    await owner.kyb.documents.upload({ ...base, bytesBase64: b64('file B') });
    const again = await owner.kyb.documents.upload({ ...base, bytesBase64: b64('file A') });
    expect(again.row.document?.sha256).toBe(a.row.document?.sha256);
    const view = await owner.kyb.documents.checklist({ applicationId: id });
    expect(view.rows[0]?.document?.id).toBe(again.row.document?.id);
    await owner.kyb.documents.upload({ ...base, bytesBase64: b64('file A') });
    const count = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents`;
    expect(count[0]?.n).toBe('3');
  });

  it('two uploads of the same bytes at once are one document', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('same') };
    await Promise.all([owner.kyb.documents.upload(input), owner.kyb.documents.upload(input), owner.kyb.documents.upload(input)]);
    const count = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents`;
    expect(count[0]?.n).toBe('1');
  });

  it('an upload racing a submit either lands before it or is refused, never after', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('late') };
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM pay.kyb_applications WHERE id = ${id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 300));
      await tx`UPDATE pay.kyb_applications SET state = 'submitted', kyb_ref = 'ref', submitted_at = now() WHERE id = ${id}`;
    });
    await new Promise((r) => setTimeout(r, 50));
    const outcome = await rejection(owner.kyb.documents.upload(input));
    await holder;
    expect(outcome).toMatchObject({ cause: expect.objectContaining({ code: 'pay.kyb_application_submitted' }) });
    const count = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents`;
    expect(count[0]?.n).toBe('0');
  });

  it('an upload racing a restart or type change is refused, so a cleared list never gets an old pick', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('picked before the restart') };
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM pay.kyb_applications WHERE id = ${id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 300));
      await tx`UPDATE pay.kyb_applications SET documents_after_seq = documents_after_seq + 1 WHERE id = ${id}`;
    });
    await new Promise((r) => setTimeout(r, 50));
    const outcome = await rejection(owner.kyb.documents.upload(input));
    await holder;
    expect(outcome).toMatchObject({ code: 'CONFLICT', cause: expect.objectContaining({ code: 'pay.kyb_application_changed' }) });
    const count = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents`;
    expect(count[0]?.n).toBe('0');
  });

  it('refuses an oversize file with the cap, a type that is not accepted, and a key the type is not asked for', async () => {
    const id = await startApplication();
    await publishRules(8);
    const owner = await api();
    const base = { applicationId: id, key: 'trust_deed', contentType: PDF };
    expect(await rejection(owner.kyb.documents.upload({ ...base, bytesBase64: b64('123456789') }))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_document_too_large' }),
    });
    expect(await rejection(owner.kyb.documents.upload({ ...base, contentType: 'text/html', bytesBase64: b64('x') }))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_document_type_refused' }),
    });
    expect(await rejection(owner.kyb.documents.upload({ ...base, key: 'passport', bytesBase64: b64('x') }))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_document_key_unknown' }),
    });
  });

  it('shows a rejected document with its reason', async () => {
    const id = await startApplication();
    await publishRules();
    const owner = await api();
    await owner.kyb.documents.upload({ applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('blurry') });
    await sql`UPDATE pay.kyb_documents SET state = 'rejected', rejection_reason = 'The scan is not readable' WHERE document_key = 'trust_deed'`;
    const view = await owner.kyb.documents.checklist({ applicationId: id });
    expect(view.rows[0]).toMatchObject({ state: 'rejected', rejectionReason: 'The scan is not readable' });
  });

  it('refuses an upload once the application is submitted, and for someone who does not own it', async () => {
    const id = await startApplication();
    await publishRules();
    const input = { applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('deed') };
    expect(await rejection((await api({ userId: STRANGER })).kyb.documents.upload(input))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.merchant_not_found' }),
    });
    await sql`UPDATE pay.kyb_applications SET state = 'submitted', kyb_ref = 'ref', submitted_at = now() WHERE id = ${id}`;
    expect(await rejection((await api()).kyb.documents.upload(input))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_application_submitted' }),
    });
    const counted = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_documents`;
    expect(counted[0]?.n).toBe('0');
  });

  it('keeps the table constraints: a reason only when rejected, one rules row, a 32-hex-pair digest', async () => {
    const id = await startApplication();
    await publishRules();
    await expect(sql`INSERT INTO pay.kyb_upload_rules (max_bytes, content_types) VALUES (5, ${[PDF]})`).rejects.toThrow();
    await expect(
      sql`INSERT INTO pay.kyb_documents (application_id, document_key, content_type, byte_length, sha256, ciphertext, nonce, state, uploaded_by)
          VALUES (${id}, 'trust_deed', ${PDF}, 1, ${'a'.repeat(64)}, ${Buffer.from('x')}, ${randomBytes(12)}, 'provided', 'u')
          RETURNING rejection_reason`.then(
        () =>
          sql`INSERT INTO pay.kyb_documents (application_id, document_key, content_type, byte_length, sha256, ciphertext, nonce, state, rejection_reason, uploaded_by)
            VALUES (${id}, 'trust_deed', ${PDF}, 1, ${'b'.repeat(64)}, ${Buffer.from('x')}, ${randomBytes(12)}, 'provided', 'why', 'u')`,
      ),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO pay.kyb_documents (application_id, document_key, content_type, byte_length, sha256, ciphertext, nonce, uploaded_by)
          VALUES (${id}, 'trust_deed', ${PDF}, 1, 'xyz', ${Buffer.from('x')}, ${randomBytes(12)}, 'u')`,
    ).rejects.toThrow();
  });

  describe('compliance review', () => {
    const REVIEWER = '99999999-9999-4999-8999-999999999999';
    const reviewer = (mfa = true) => api({ userId: REVIEWER, scopes: ['admin:compliance'], mfa });
    const sent = async () => {
      const id = await startApplication();
      await publishRules();
      const owner = await api();
      const deed = await owner.kyb.documents.upload({
        applicationId: id,
        key: 'trust_deed',
        contentType: PDF,
        bytesBase64: b64('the deed'),
      });
      const address = await owner.kyb.documents.upload({
        applicationId: id,
        key: 'proof_of_address',
        contentType: PDF,
        bytesBase64: b64('the address'),
      });
      return { id, owner, deed: deed.row.document!.id, address: address.row.document!.id };
    };

    it('a reviewer marks one document accepted and another rejected with a reason, and the business reads both', async () => {
      const { id, owner, deed, address } = await sent();
      const desk = await reviewer();
      const before = await desk.kyb.documents.reviewView({ merchantId });
      expect(before.application).toMatchObject({ applicationId: id, entityType: 'trust', country: 'DE', state: 'draft' });
      expect(before.rows.map((r) => [r.key, r.state, r.reviewedBy])).toEqual([
        ['trust_deed', 'provided', null],
        ['proof_of_address', 'provided', null],
      ]);

      const accepted = await desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted' });
      expect(accepted.row).toMatchObject({ state: 'accepted', rejectionReason: null });
      await desk.kyb.documents.review({
        applicationId: id,
        documentId: address,
        verdict: 'rejected',
        reason: 'TEST the address is cut off',
      });

      const view = await owner.kyb.documents.checklist({ applicationId: id });
      expect(view.rows.map((r) => [r.key, r.state, r.rejectionReason])).toEqual([
        ['trust_deed', 'accepted', null],
        ['proof_of_address', 'rejected', 'TEST the address is cut off'],
      ]);
      const after = await desk.kyb.documents.reviewView({ merchantId });
      expect(after.rows.every((r) => r.reviewedBy === REVIEWER && r.reviewedAt !== null)).toBe(true);
      const reviews = await sql<Array<{ verdict: string; reason: string | null; actor_scope: string }>>`
        SELECT verdict, reason, actor_scope FROM pay.kyb_document_reviews ORDER BY created_at`;
      expect(reviews).toEqual([
        { verdict: 'accepted', reason: null, actor_scope: 'admin:compliance' },
        { verdict: 'rejected', reason: 'TEST the address is cut off', actor_scope: 'admin:compliance' },
      ]);
    });

    it('the same verdict again changes nothing; another verdict on a reviewed upload is refused', async () => {
      const { id, deed } = await sent();
      const desk = await reviewer();
      await desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'rejected', reason: 'TEST blurry' });
      const again = await desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'rejected', reason: 'TEST blurry' });
      expect(again.row.state).toBe('rejected');
      expect(await rejection(desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted' }))).toMatchObject({
        code: 'CONFLICT',
        cause: expect.objectContaining({ code: 'pay.kyb_document_already_reviewed' }),
      });
      const count = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.kyb_document_reviews`;
      expect(count[0]?.n).toBe('1');
    });

    it('a rejection needs a reason and an acceptance takes none', async () => {
      const { id, deed } = await sent();
      const desk = await reviewer();
      expect(await rejection(desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'rejected' }))).toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(
        await rejection(desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted', reason: 'TEST fine' })),
      ).toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('only the current upload of a key takes a verdict', async () => {
      const { id, owner, deed } = await sent();
      await owner.kyb.documents.upload({ applicationId: id, key: 'trust_deed', contentType: PDF, bytesBase64: b64('a newer deed') });
      const desk = await reviewer();
      expect(await rejection(desk.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted' }))).toMatchObject({
        cause: expect.objectContaining({ code: 'pay.kyb_document_not_current' }),
      });
      await owner.kyb.application.restart({ applicationId: id, confirm: true });
      const cleared = (await desk.kyb.documents.reviewView({ merchantId })).rows;
      expect(cleared.map((r) => r.state)).toEqual(['missing', 'missing']);
      expect(
        await rejection(
          desk.kyb.documents.review({ applicationId: id, documentId: '00000000-0000-4000-8000-000000000000', verdict: 'accepted' }),
        ),
      ).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a reviewer opens a file and gets the bytes the business sent; every open is recorded', async () => {
      const { id, deed } = await sent();
      const desk = await reviewer();
      const file = await desk.kyb.documents.file({ applicationId: id, documentId: deed });
      expect(Buffer.from(file.bytesBase64, 'base64').toString()).toBe('the deed');
      expect(file).toMatchObject({ key: 'trust_deed', contentType: PDF, sha256: createHash('sha256').update('the deed').digest('hex') });
      await desk.kyb.documents.file({ applicationId: id, documentId: deed });
      const reads = await sql<Array<{ actor_id: string }>>`SELECT actor_id FROM pay.kyb_document_reads WHERE document_id = ${deed}`;
      expect(reads.map((r) => r.actor_id)).toEqual([REVIEWER, REVIEWER]);
      expect(
        await rejection(
          (await api({ userId: REVIEWER, scopes: ['admin:compliance'], key: randomBytes(32) })).kyb.documents.file({
            applicationId: id,
            documentId: deed,
          }),
        ),
      ).toMatchObject({ cause: expect.objectContaining({ code: 'pay.kyb_document_unreadable' }) });
    });

    it('needs admin:compliance on a second-factor sign-in; the business owner cannot review or open files', async () => {
      const { id, owner, deed } = await sent();
      expect(await rejection(owner.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted' }))).toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await rejection(owner.kyb.documents.file({ applicationId: id, documentId: deed }))).toMatchObject({ code: 'FORBIDDEN' });
      expect(await rejection(owner.kyb.documents.reviewView({ merchantId }))).toMatchObject({ code: 'FORBIDDEN' });
      const noFactor = await reviewer(false);
      expect(await rejection(noFactor.kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted' }))).toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(await rejection(noFactor.kyb.documents.file({ applicationId: id, documentId: deed }))).toMatchObject({ code: 'UNAUTHORIZED' });
      expect((await sql<Array<{ state: string }>>`SELECT state FROM pay.kyb_documents WHERE id = ${deed}`)[0]?.state).toBe('provided');
    });

    it('the database lets an upload change only from waiting to a verdict, and keeps reviews and reads', async () => {
      const { id, deed } = await sent();
      await expect(sql`UPDATE pay.kyb_documents SET sha256 = ${'c'.repeat(64)} WHERE id = ${deed}`).rejects.toThrow(/verdict/);
      await expect(sql`DELETE FROM pay.kyb_documents WHERE id = ${deed}`).rejects.toThrow(/DELETE/);
      await (await reviewer()).kyb.documents.review({ applicationId: id, documentId: deed, verdict: 'accepted' });
      await expect(
        sql`UPDATE pay.kyb_documents SET state = 'rejected', rejection_reason = 'TEST later' WHERE id = ${deed}`,
      ).rejects.toThrow(/verdict/);
      await expect(sql`UPDATE pay.kyb_document_reviews SET reason = 'x'`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM pay.kyb_document_reviews`).rejects.toThrow(/append-only/);
    });

    it('an unknown merchant is not found, and a merchant with no application reads empty', async () => {
      const desk = await reviewer();
      expect(await rejection(desk.kyb.documents.reviewView({ merchantId: STRANGER }))).toMatchObject({ code: 'NOT_FOUND' });
      expect(await desk.kyb.documents.reviewView({ merchantId })).toMatchObject({ application: null, rows: [] });
    });
  });
});
