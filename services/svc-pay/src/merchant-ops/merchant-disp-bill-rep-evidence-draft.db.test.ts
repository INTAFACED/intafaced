import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { createMerchantOpsRouter } from './router.js';
import { MemoryDisputeCaseStore } from '../fraud/dispute-case.js';
import { recordRailDisputeDeadline } from './dispute-deadlines.js';

/** M-disp-02 merchantOps.disputes.reviewDraft and guidance through the router, against a real Postgres. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_evidence_draft_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const founderAuthority = createFounderAuthority({
  identityUrl: 'https://identity.invalid',
  serviceSecret: 's'.repeat(32),
  fetcher: async () => new Response('{}', { status: 500 }),
});
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error('expected a refusal');
}

describe('M-disp-02 evidence draft (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  const stranger = id();
  let merchantId = '';
  const disputes = new MemoryDisputeCaseStore();
  const disputeId = `dp-${id()}`;
  const bare = `dp-${id()}`;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    disputes.open({ disputeId, paymentId: id(), merchantId, amount: '100', assetId: 'USDT', reasonCode: 'product_not_received' });
    disputes.open({ disputeId: bare, paymentId: id(), merchantId, amount: '5', assetId: 'USDT', reasonCode: '4853' });
    await recordRailDisputeDeadline(sql, {
      merchantId,
      disputeId,
      evidenceDueBy: new Date(Date.now() + 3 * 86_400_000 - 60_000),
      railEventId: 'evt-1',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantOpsRouter({ sql, founderAuthority, disputes }).createCaller(ctxOf(principalOf(userId, over)));

  it('empty draft: nothing to send, contest blocked, rail due date counts down, unknown scheme code gets general guidance', async () => {
    const empty = await as(owner).merchantOps.disputes.reviewDraft({ disputeId: bare });
    expect(empty).toMatchObject({ state: 'empty', items: [], canSubmit: false, blockers: ['no_evidence'], due: null });
    expect(empty.guidance.category).toBe('general');
    const withDue = await as(owner).merchantOps.disputes.reviewDraft({ disputeId });
    expect(withDue.due).toMatchObject({ pastDue: false, daysLeft: 3 });
  });

  it('a saved note shows as a saved draft, lists what is missing, and nothing is sent (disputes-risk-054, -005)', async () => {
    await as(owner).merchantOps.disputes.addEvidence({
      disputeId,
      kind: 'receipt',
      fileName: 'receipt-note.txt',
      contentType: 'text/plain',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      note: 'order 42 receipt',
    });
    const draft = await as(owner).merchantOps.disputes.reviewDraft({ disputeId });
    expect(draft).toMatchObject({ state: 'saved_draft', status: 'open', canSubmit: true, blockers: [] });
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ kind: 'receipt', note: 'order 42 receipt' });
    expect(draft.missingRecommended).toEqual(['shipping_proof', 'customer_communication']);
    const responses = await sql`SELECT 1 FROM pay.merchant_dispute_responses WHERE dispute_id = ${disputeId}`;
    expect(responses).toHaveLength(0);
  });

  it('after contest the draft reads sent and cannot be submitted again', async () => {
    await as(owner).merchantOps.disputes.respond({ requestId: id(), disputeId, action: 'contest' });
    const sent = await as(owner).merchantOps.disputes.reviewDraft({ disputeId });
    expect(sent).toMatchObject({ state: 'sent', status: 'contested', canSubmit: false, blockers: ['already_sent'] });
  });

  it('read-only role sees the draft; strangers and other ids are refused', async () => {
    await expect(as(owner, { scopes: ['pay:read'] }).merchantOps.disputes.reviewDraft({ disputeId })).resolves.toMatchObject({ disputeId });
    expect(await refusal(() => as(stranger).merchantOps.disputes.reviewDraft({ disputeId }))).toEqual({
      code: 'FORBIDDEN',
      message: 'pay.merchant_ops_not_merchant',
    });
    expect(await refusal(() => as(owner).merchantOps.disputes.reviewDraft({ disputeId: 'dp-missing' }))).toEqual({
      code: 'NOT_FOUND',
      message: 'pay.dispute_not_found',
    });
  });

  it('guidance answers by category through the router', async () => {
    const g = await as(owner).merchantOps.disputes.guidance({ reason: 'product_not_received' });
    expect(g.recommended[0]).toBe('shipping_proof');
  });
});
