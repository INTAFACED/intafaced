import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { stubApprovalConsumer, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { createPayRouter } from '../router.js';
import { UserMoneyService } from '../user-money-service.js';
import { enqueueHeldPayment } from './review-queue-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CONFIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function harnessAdminUrl(envUrl: string): string {
  const url = new URL(envUrl);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: harnessAdminUrl(envUrl), stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_fraud_review_router_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

async function ctx(scopes: string[], userId: string): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: randomUUID(), scopes, tier: 'full', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: randomUUID() };
}

function reviewInput(merchantId: string, id: string, paymentId?: string) {
  return {
    id,
    merchantId,
    amount: '17.25',
    assetId: 'USDT',
    ...(paymentId ? { paymentId } : {}),
    recentPaymentCount: 50,
    thresholds: { maxPaymentsInWindow: 5, velocityCountAction: 'review' as const },
  };
}

describe('fraud.enqueueReview cannot read or adopt another case', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  let pay!: PayService;
  let router!: ReturnType<typeof createPayRouter>;
  const approvalConsumes: string[] = [];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    approvalConsumes.length = 0;
    const ledger = new MemoryLedger();
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        approvalConsumes.push(input.approvalId);
        return stubApprovalConsumer(CONFIRM).consume(input);
      },
    };
    router = createPayRouter(
      pay,
      rails,
      new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
      null,
      undefined,
      approvals,
      null,
      undefined,
      sql,
    );
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant(userId: string) {
    return pay.createMerchant({ userId, pricing: { feeBps: 250 } });
  }

  async function payment(merchantId: string) {
    return pay.createPayment({
      merchantId,
      amount: parseAmount('10'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
  }

  async function caller(scopes: string[], userId: string) {
    return router.createCaller(await ctx(scopes, userId));
  }

  async function storedCase(id: string) {
    const rows = await sql<
      Array<{
        id: string;
        merchant_id: string;
        payment_ref: string | null;
        amount: string;
        status: string;
        reason: string;
        source: string;
        reasons: unknown;
      }>
    >`
      SELECT id, merchant_id, payment_ref, amount::text AS amount, status, reason, source, reasons
        FROM pay.fraud_review_cases WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  it('refuses merchant B enqueueReview of merchant A payment as not found and returns no case', async () => {
    const merchantA = await merchant(USER_A);
    const merchantB = await merchant(USER_B);
    const owned = await payment(merchantA.id);
    const missingId = randomUUID();
    const writerB = await caller(['pay:write'], USER_B);

    const foreign = await writerB.fraud
      .enqueueReview(reviewInput(merchantB.id, `rev-${randomUUID()}`, owned.id))
      .catch((error: unknown) => error);
    const missing = await writerB.fraud
      .enqueueReview(reviewInput(merchantB.id, `rev-${randomUUID()}`, missingId))
      .catch((error: unknown) => error);

    expect(foreign).toMatchObject({ code: 'NOT_FOUND', message: `pay.payment_not_found: Payment ${owned.id} not found` });
    expect(missing).toMatchObject({ code: 'NOT_FOUND', message: `pay.payment_not_found: Payment ${missingId} not found` });
    expect(JSON.stringify(foreign)).not.toContain(merchantA.id);
    expect(JSON.stringify(foreign)).not.toContain('17.25');
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_cases WHERE payment_ref = ${owned.id}`;
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses merchant B enqueueReview of another case id and of a system case id', async () => {
    const merchantA = await merchant(USER_A);
    const merchantB = await merchant(USER_B);
    const writerA = await caller(['pay:write'], USER_A);
    const writerB = await caller(['pay:write'], USER_B);
    const caseId = `rev-${randomUUID()}`;
    const opened = await writerA.fraud.enqueueReview(reviewInput(merchantA.id, caseId));
    const before = await storedCase(opened.id);
    expect(before?.merchant_id).toBe(merchantA.id);

    const foreign = await writerB.fraud.enqueueReview(reviewInput(merchantB.id, caseId)).catch((error: unknown) => error);
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
    expect((foreign as { message: string }).message).toContain('pay.fraud_review_not_found');
    expect(JSON.stringify(foreign)).not.toContain(merchantA.id);
    expect(JSON.stringify(foreign)).not.toContain('17.25');
    expect(JSON.stringify(foreign)).not.toContain(before?.reason);
    expect(await storedCase(caseId)).toEqual(before);

    const paymentRef = randomUUID();
    const held = await enqueueHeldPayment(sql, {
      paymentRef,
      merchantId: merchantA.id,
      amount: '4',
      assetId: 'USDT',
      reason: 'captured payment exceeded: daily_intake',
      reasons: [{ ruleId: 'captured_over_cap', detail: 'daily_intake' }],
      createdBy: 'system:capture_guard',
      source: 'control.captured_over_cap',
    });
    expect(held.id).toBe(`held:${paymentRef}`);
    const heldBefore = await storedCase(held.id);
    const system = await writerB.fraud.enqueueReview(reviewInput(merchantB.id, held.id)).catch((error: unknown) => error);
    expect(system).toMatchObject({ code: 'BAD_REQUEST' });
    expect((system as { message: string }).message).toContain('pay.fraud_review_not_review');
    expect((system as { message: string }).message).toContain('reserved for system holds');
    expect(JSON.stringify(system)).not.toContain('daily_intake');
    expect(JSON.stringify(system)).not.toContain(merchantA.id);
    expect(JSON.stringify(system)).not.toContain('captured payment exceeded');
    expect(await storedCase(held.id)).toEqual(heldBefore);
  });

  it('opens a system case beside a merchant fraud.review for the same payment', async () => {
    const merchantA = await merchant(USER_A);
    const owned = await payment(merchantA.id);
    const writerA = await caller(['pay:write'], USER_A);
    await writerA.fraud.enqueueReview(reviewInput(merchantA.id, `rev-${randomUUID()}`, owned.id));

    const system = await enqueueHeldPayment(sql, {
      paymentRef: owned.id,
      merchantId: merchantA.id,
      amount: '4',
      assetId: 'USDT',
      reason: 'captured payment exceeded: daily_intake',
      reasons: [{ ruleId: 'captured_over_cap', detail: 'daily_intake' }],
      createdBy: 'system:capture_guard',
      source: 'control.captured_over_cap',
    });
    expect(system.source).toBe('control.captured_over_cap');
    expect(system.amount).toBe('4');

    const rows = await sql<Array<{ id: string; source: string }>>`
      SELECT id, source FROM pay.fraud_review_cases WHERE payment_ref = ${owned.id} ORDER BY source`;
    expect(rows.map((row) => row.source)).toEqual(['control.captured_over_cap', 'fraud.review']);
    const enqueued = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_decisions
       WHERE case_id = ${system.id} AND effect = 'enqueue'`;
    expect(enqueued[0]?.n).toBe(1);
  });

  it('refuses a merchant enqueueReview of a system hold id and writes no row', async () => {
    const merchantA = await merchant(USER_A);
    const owned = await payment(merchantA.id);
    const writerA = await caller(['pay:write'], USER_A);
    const heldPayment = `held:${owned.id}`;
    const heldSource = `held:control.captured_over_cap:${owned.id}`;

    const withPayment = await writerA.fraud
      .enqueueReview(reviewInput(merchantA.id, heldPayment, owned.id))
      .catch((error: unknown) => error);
    const withoutPayment = await writerA.fraud.enqueueReview(reviewInput(merchantA.id, heldPayment)).catch((error: unknown) => error);
    const sourceQualified = await writerA.fraud.enqueueReview(reviewInput(merchantA.id, heldSource)).catch((error: unknown) => error);

    for (const refused of [withPayment, withoutPayment, sourceQualified]) {
      expect(refused).toMatchObject({ code: 'BAD_REQUEST' });
      expect((refused as { message: string }).message).toContain('pay.fraud_review_not_review');
      expect((refused as { message: string }).message).toContain('reserved for system holds');
    }
    expect(await storedCase(heldPayment)).toBeNull();
    expect(await storedCase(heldSource)).toBeNull();
  });

  it('opens the over-cap system case after a merchant was refused the held ids', async () => {
    const merchantA = await merchant(USER_A);
    const owned = await payment(merchantA.id);
    const writerA = await caller(['pay:write'], USER_A);
    await writerA.fraud.enqueueReview(reviewInput(merchantA.id, `held:${owned.id}`, owned.id)).catch(() => undefined);
    await writerA.fraud.enqueueReview(reviewInput(merchantA.id, `held:${owned.id}`)).catch(() => undefined);
    await writerA.fraud.enqueueReview(reviewInput(merchantA.id, `held:control.captured_over_cap:${owned.id}`)).catch(() => undefined);

    const system = await enqueueHeldPayment(sql, {
      paymentRef: owned.id,
      merchantId: merchantA.id,
      amount: '4',
      assetId: 'USDT',
      reason: 'captured payment exceeded: daily_intake',
      reasons: [{ ruleId: 'captured_over_cap', detail: 'daily_intake' }],
      createdBy: 'system:capture_guard',
      source: 'control.captured_over_cap',
    });
    expect(system.source).toBe('control.captured_over_cap');
    const enqueued = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_decisions
       WHERE case_id = ${system.id} AND effect = 'enqueue'`;
    expect(enqueued[0]?.n).toBe(1);
  });

  it('enqueue, claim, and allow twice consume one approval and write one allow', async () => {
    const merchantA = await merchant(USER_A);
    const writer = await caller(['pay:write'], USER_A);
    const operator = await caller(['admin:treasury'], OPERATOR);
    const id = `rev-${randomUUID()}`;
    const opened = await writer.fraud.enqueueReview(reviewInput(merchantA.id, id));
    expect(opened.status).toBe('open');

    const claimed = await operator.fraud.claimReview({ id });
    expect(claimed).toMatchObject({ id, status: 'claimed', claimedBy: OPERATOR });

    const first = await operator.fraud.resolveReview({
      id,
      outcome: 'allow',
      note: 'known payer',
      confirmOperatorId: CONFIRM,
      approvalId: 'appr-allow',
      operationId: 'op-allow',
    });
    const second = await operator.fraud.resolveReview({
      id,
      outcome: 'allow',
      confirmOperatorId: CONFIRM,
      approvalId: 'appr-allow',
      operationId: 'op-allow',
    });

    expect(first).toMatchObject({ id, status: 'allowed', confirmOperatorId: CONFIRM });
    expect(second).toMatchObject({ id, status: 'allowed' });
    expect(approvalConsumes).toEqual(['appr-allow']);
    const allows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_decisions WHERE case_id = ${id} AND effect = 'allow'`;
    expect(allows[0]?.n).toBe(1);
  });
});
