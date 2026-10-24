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
import { KybDocumentService } from './kyb-documents.js';
import { KybInformationRequestService } from './kyb-information-requests.js';
import { LOCAL_TEST_EICAR_STRING, LocalTestEicarScanner, type KybMalwareScanner } from './kyb-malware-scan.js';
import { KybEntityTypeService } from './kyb-entity-types.js';
import { createKybPspRouter } from './kyb-router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { KybService } from './kyb-service.js';
import { PspModeService } from './psp-mode.js';

/**
 * KYB information requests (J-merchant-02 step 4): compliance asks, the business answers once, compliance closes.
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
      .withDatabase('intafaced_kyb_requests_test')
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
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'kyb-requests' };
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

const REVIEWER = '99999999-9999-4999-8999-999999999999';
const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const DUE = later(14);
const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('kyb information requests', () => {
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
      `TRUNCATE pay.kyb_request_events, pay.kyb_request_answers, pay.kyb_information_requests, pay.kyb_upload_rules, pay.merchant_kyb_events, pay.merchant_status_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, status, pricing) VALUES (${OWNER}, 'psp', 'active', ${sql.json({ feeBps: 250 } as never)}) RETURNING id
    `;
    if (!row) throw new Error('no merchant');
    merchantId = row.id;
    await sql`INSERT INTO pay.kyb_upload_rules (max_bytes, content_types) VALUES (${1024}, ${[PDF, 'image/png']})`;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const api = async (
    opts: { userId?: string; scopes?: string[]; mfa?: boolean; key?: Buffer | null; scanner?: KybMalwareScanner | null } = {},
  ) => {
    const kyb = new KybService(sql);
    const types = new KybEntityTypeService(sql);
    const key = opts.key === undefined ? KEY : opts.key;
    const documents = new KybDocumentService(sql, types, key);
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
      undefined,
      documents,
      new KybInformationRequestService(sql, documents, key, opts.scanner === undefined ? new LocalTestEicarScanner() : opts.scanner),
    ).createCaller(await ctx(opts.userId ?? OWNER, opts.scopes, opts.mfa));
  };
  const reviewer = (opts: { mfa?: boolean; key?: Buffer | null } = {}) => api({ userId: REVIEWER, scopes: ['admin:compliance'], ...opts });
  const ask = async (text = 'TEST send a bank statement from the last three months', dueAt = DUE, requestKey = 'test:req:0001') =>
    (await (await reviewer()).kyb.requests.create({ merchantId, requestKey, text, dueAt })).request;

  it('a reviewer asks, the business reads it open with its due date, answers with a note and a file, and a reviewer closes it', async () => {
    const asked = await ask();
    expect(asked).toMatchObject({ state: 'open', pastDue: false, createdBy: REVIEWER, answer: null, closedBy: null });
    const owner = await api();
    const view = await owner.kyb.requests.list({ merchantId });
    expect(view.requests.map((r) => [r.text, r.state])).toEqual([['TEST send a bank statement from the last three months', 'open']]);
    expect(view.scanner).toEqual({ status: 'connected' });
    expect(view.uploadRules).toEqual({ maxBytes: 1024, contentTypes: [PDF, 'image/png'] });

    const answered = await owner.kyb.requests.answer({
      requestId: asked.id,
      note: 'TEST here it is',
      file: { contentType: PDF, bytesBase64: b64('%PDF statement') },
    });
    expect(answered.request.state).toBe('answered');
    expect(answered.request.answer).toMatchObject({ note: 'TEST here it is', file: { contentType: PDF, byteLength: 14 } });
    const stored = await sql<Array<{ ciphertext: Buffer }>>`SELECT ciphertext FROM pay.kyb_request_answers`;
    expect(stored[0]?.ciphertext.includes(Buffer.from('%PDF statement'))).toBe(false);

    const desk = await reviewer();
    const file = await desk.kyb.requests.file({ requestId: asked.id });
    expect(Buffer.from(file.bytesBase64, 'base64').toString()).toBe('%PDF statement');
    expect(file.sha256).toBe(createHash('sha256').update('%PDF statement').digest('hex'));

    const closed = await desk.kyb.requests.close({ requestId: asked.id, note: 'TEST statement received, thank you' });
    expect(closed.request).toMatchObject({ state: 'closed', closedBy: REVIEWER, closeNote: 'TEST statement received, thank you' });
    expect(closed.request.closedAt).not.toBeNull();
    const seen = (await owner.kyb.requests.list({ merchantId })).requests[0];
    expect(seen).toMatchObject({ state: 'closed', closedBy: REVIEWER });
    const kinds = await sql<
      Array<{ kind: string; actor_scope: string }>
    >`SELECT kind, actor_scope FROM pay.kyb_request_events ORDER BY created_at`;
    expect(kinds.map((k) => `${k.kind}:${k.actor_scope}`)).toEqual([
      'created:admin:compliance',
      'answered:pay:onboard',
      'file_read:admin:compliance',
      'closed:admin:compliance',
    ]);
  });

  it('an infected file is refused, nothing of it is kept, and the refusal stays in the history', async () => {
    const asked = await ask();
    const owner = await api();
    expect(
      await rejection(
        owner.kyb.requests.answer({
          requestId: asked.id,
          note: 'TEST attached',
          file: { contentType: PDF, bytesBase64: b64(LOCAL_TEST_EICAR_STRING) },
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST', cause: expect.objectContaining({ code: 'pay.kyb_answer_file_infected' }) });
    expect(await sql`SELECT 1 FROM pay.kyb_request_answers`).toHaveLength(0);
    const refused = await sql<Array<{ kind: string; detail: { sha256: string; verdict: string } }>>`
      SELECT kind, detail FROM pay.kyb_request_events WHERE kind = 'file_refused'`;
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toEqual({ sha256: createHash('sha256').update(LOCAL_TEST_EICAR_STRING).digest('hex'), verdict: 'infected' });
    expect((await owner.kyb.requests.list({ merchantId })).requests[0]?.state).toBe('open');
  });

  it('without a scanner a file answer refuses and a note alone still answers', async () => {
    const asked = await ask();
    const owner = await api({ scanner: null });
    expect((await owner.kyb.requests.list({ merchantId })).scanner).toEqual({
      status: 'not_connected',
      notConnected: 'vendor.malware_scan',
    });
    expect(
      await rejection(owner.kyb.requests.answer({ requestId: asked.id, file: { contentType: PDF, bytesBase64: b64('%PDF') } })),
    ).toMatchObject({ code: 'PRECONDITION_FAILED', cause: expect.objectContaining({ code: 'pay.kyb_scan_unconfigured' }) });
    const answered = await owner.kyb.requests.answer({ requestId: asked.id, note: 'TEST the statement is in the post' });
    expect(answered.request.answer).toMatchObject({ note: 'TEST the statement is in the post', file: null });
  });

  it('a file over the owner cap or of a type not accepted is refused before the scan', async () => {
    const asked = await ask();
    let scans = 0;
    const owner = await api({ scanner: { scan: async () => ((scans += 1), 'clean') } });
    expect(
      await rejection(
        owner.kyb.requests.answer({
          requestId: asked.id,
          file: { contentType: PDF, bytesBase64: Buffer.alloc(2048, 1).toString('base64') },
        }),
      ),
    ).toMatchObject({ cause: expect.objectContaining({ code: 'pay.kyb_document_too_large' }) });
    expect(
      await rejection(owner.kyb.requests.answer({ requestId: asked.id, file: { contentType: 'text/html', bytesBase64: b64('<p>') } })),
    ).toMatchObject({ cause: expect.objectContaining({ code: 'pay.kyb_document_type_refused' }) });
    expect(scans).toBe(0);
  });

  it('the same answer again changes nothing; another answer, or one to a closed request, is refused', async () => {
    const asked = await ask();
    const owner = await api();
    const first = { requestId: asked.id, note: 'TEST note', file: { contentType: PDF, bytesBase64: b64('%PDF one') } };
    await owner.kyb.requests.answer(first);
    expect((await owner.kyb.requests.answer(first)).request.state).toBe('answered');
    expect(await rejection(owner.kyb.requests.answer({ ...first, note: 'TEST other' }))).toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'pay.kyb_request_already_answered' }),
    });
    const other = await ask('TEST and a utility bill', later(14), 'test:req:0002');
    await (await reviewer()).kyb.requests.close({ requestId: other.id, note: 'TEST no longer needed' });
    expect(await rejection(owner.kyb.requests.answer({ requestId: other.id, note: 'TEST late' }))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_request_closed' }),
    });
    expect(await sql`SELECT 1 FROM pay.kyb_request_answers`).toHaveLength(1);
  });

  it('a request key makes asking idempotent; the due date must be in the future; past due shows while open', async () => {
    const asked = await ask();
    expect((await ask()).id).toBe(asked.id);
    expect(await rejection(ask('TEST different words'))).toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'pay.kyb_request_key_conflict' }),
    });
    expect(await rejection(ask('TEST too late', new Date(Date.now() - 60_000).toISOString(), 'test:req:0003'))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_request_due_past' }),
    });
    const soon = await ask('TEST due in a moment', new Date(Date.now() + 1500).toISOString(), 'test:req:0004');
    expect(soon.pastDue).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const owner = await api();
    const byId = new Map((await owner.kyb.requests.list({ merchantId })).requests.map((r) => [r.id, r]));
    expect(byId.get(soon.id)?.pastDue).toBe(true);
    expect(byId.get(asked.id)?.pastDue).toBe(false);
    await owner.kyb.requests.answer({ requestId: soon.id, note: 'TEST late but here' });
    expect((await owner.kyb.requests.list({ merchantId })).requests.find((r) => r.id === soon.id)?.pastDue).toBe(false);
  });

  it('only the owner answers and reads; only compliance with a second factor asks, closes and opens files', async () => {
    const asked = await ask();
    const stranger = await api({ userId: STRANGER });
    expect(await rejection(stranger.kyb.requests.list({ merchantId }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(stranger.kyb.requests.answer({ requestId: asked.id, note: 'TEST not mine' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    const owner = await api();
    expect(
      await rejection(owner.kyb.requests.create({ merchantId, requestKey: 'test:req:0009', text: 'TEST self', dueAt: later(3) })),
    ).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await rejection(owner.kyb.requests.close({ requestId: asked.id, note: 'TEST self close' }))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await rejection(owner.kyb.requests.file({ requestId: asked.id }))).toMatchObject({ code: 'FORBIDDEN' });
    const noFactor = await reviewer({ mfa: false });
    expect(await rejection(noFactor.kyb.requests.close({ requestId: asked.id, note: 'TEST no factor' }))).toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(await rejection(noFactor.kyb.requests.reviewList({ merchantId }))).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await rejection(owner.kyb.requests.answer({ requestId: '00000000-0000-4000-8000-000000000000', note: 'TEST' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('the database keeps a request’s words, moves it forward only, and keeps answers and history', async () => {
    const asked = await ask();
    await expect(sql`UPDATE pay.kyb_information_requests SET text = 'TEST changed' WHERE id = ${asked.id}`).rejects.toThrow(/only moves/);
    await expect(sql`DELETE FROM pay.kyb_information_requests WHERE id = ${asked.id}`).rejects.toThrow(/DELETE/);
    await (await api()).kyb.requests.answer({ requestId: asked.id, note: 'TEST answer' });
    await expect(sql`UPDATE pay.kyb_information_requests SET state = 'open' WHERE id = ${asked.id}`).rejects.toThrow(/only moves/);
    await expect(sql`UPDATE pay.kyb_request_answers SET note = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM pay.kyb_request_events`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE pay.kyb_information_requests SET state = 'closed' WHERE id = ${asked.id}`).rejects.toThrow(/closed_has_who/);
  });

  it('a file read with the wrong key is refused, and a request without a file has none to open', async () => {
    const asked = await ask();
    await (await api()).kyb.requests.answer({ requestId: asked.id, file: { contentType: PDF, bytesBase64: b64('%PDF x') } });
    expect(await rejection((await reviewer({ key: randomBytes(32) })).kyb.requests.file({ requestId: asked.id }))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_document_unreadable' }),
    });
    const noFile = await ask('TEST a note will do', later(5), 'test:req:0005');
    expect(await rejection((await reviewer()).kyb.requests.file({ requestId: noFile.id }))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
