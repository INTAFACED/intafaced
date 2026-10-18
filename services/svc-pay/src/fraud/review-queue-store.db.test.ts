import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { FraudReviewError } from './review-queue.js';
import {
  assertFlaggedPaymentHasCase,
  assertScreeningReviewHasCase,
  enqueueHeldPayment,
  PostgresFraudReviewQueue,
} from './review-queue-store.js';
import { FRESH, settleGuardRefusal, type PayoutExecuteContext } from '../seams/guards.js';
import { screeningSubjectKey } from '../screening/guard.js';
import { createW9ScreeningGuards } from '../seams/slots/w9-screening.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

function harnessAdminUrl(envUrl: string): string {
  const url = new URL(envUrl);
  const name = url.pathname.replace(/^\//, '');
  // The shared URL's database is named `test`. The harness only migrates a
  // database whose name ends in `_test`, and this server already has one.
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: harnessAdminUrl(envUrl), stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_fraud_review_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SETTLEMENT = '11111111-1111-4111-8111-111111111111';
const MERCHANT = '22222222-2222-4222-8222-222222222222';

describe('fraud review cases persist and one payment has one case', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('a flagged payment creates exactly one case, and that case is still there after a new queue', async () => {
    const paymentId = randomUUID();
    const input = {
      paymentRef: paymentId,
      merchantId: MERCHANT,
      amount: '10.50',
      assetId: 'USDT',
      reason: 'captured payment exceeded: daily_intake',
      reasons: [{ ruleId: 'captured_over_cap', detail: 'daily_intake' }],
      createdBy: 'system:capture_guard',
      source: 'control.captured_over_cap' as const,
    };
    const first = await enqueueHeldPayment(sql, input);
    const second = await enqueueHeldPayment(sql, input);
    expect(second.id).toBe(first.id);
    expect(first.amount).toBe('10.5');
    expect(parseAmount(first.amount)).toBe(parseAmount('10.50'));
    expect(first.paymentId).toBe(paymentId);
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_cases WHERE payment_ref = ${paymentId}`;
    expect(rows[0]?.n).toBe(1);
    const enqueued = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_decisions WHERE case_id = ${first.id} AND effect = 'enqueue'`;
    expect(enqueued[0]?.n).toBe(1);

    const restarted = new PostgresFraudReviewQueue(sql);
    expect((await restarted.get(first.id))?.status).toBe('open');
    expect((await restarted.get(first.id))?.reason).toBe(input.reason);
  });

  it('a held screening review with no case is a bug, and the review guard opens exactly one', async () => {
    const stray = 'ab'.repeat(32);
    await sql`
      INSERT INTO pay.screening_cases (subject_kind, subject_key, status, factors)
      VALUES ('payout', ${stray}, 'review', ${sql.json([{ code: 'manual' }])})`;
    await expect(assertScreeningReviewHasCase(sql, 'payout', stray)).rejects.toMatchObject({
      code: 'pay.fraud_review_missing_case',
    });
    await sql`DELETE FROM pay.screening_cases WHERE subject_kind = 'payout' AND subject_key = ${stray}`;

    const guards = createW9ScreeningGuards({
      sql,
      screener: async () => ({ category: 'review', factors: [{ code: 'name_review' }] }),
      listPosture: 'named',
    });
    const ctx: PayoutExecuteContext = {
      sql,
      settlementId: SETTLEMENT,
      merchantId: MERCHANT,
      assetId: 'USDT',
      amount: 1n,
      railId: 'crypto-native',
      destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      attempt: 0,
      replay: FRESH,
    };
    const refuse = async () => {
      try {
        await guards.beforePayoutExecute!(ctx);
      } catch (error) {
        await settleGuardRefusal(error);
      }
    };
    await refuse();
    await refuse();
    const key = screeningSubjectKey('payout', [SETTLEMENT, '0']);
    await assertScreeningReviewHasCase(sql, 'payout', key);
    const paymentRef = `screening:payout:${key}`;
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.fraud_review_cases WHERE payment_ref = ${paymentRef}`;
    expect(rows[0]?.n).toBe(1);
  });

  it('a flagged audit row without a case is a bug until the case is opened', async () => {
    const paymentId = randomUUID();
    await sql`
      INSERT INTO pay.control_audit (scope, scope_id, kind, outcome, actor_id, reason, after)
      VALUES (
        'merchant', ${paymentId}, 'payment.captured_over_cap', 'flagged', 'system:capture_guard',
        'captured payment exceeded: daily_intake', ${sql.json({ paymentId })}
      )`;
    await expect(assertFlaggedPaymentHasCase(sql, paymentId)).rejects.toBeInstanceOf(FraudReviewError);
    await enqueueHeldPayment(sql, {
      paymentRef: paymentId,
      merchantId: MERCHANT,
      amount: '3',
      assetId: 'USDT',
      reason: 'captured payment exceeded: daily_intake',
      reasons: [{ ruleId: 'captured_over_cap', detail: 'daily_intake' }],
      createdBy: 'system:capture_guard',
      source: 'control.captured_over_cap',
    });
    await assertFlaggedPaymentHasCase(sql, paymentId);
  });

  it('claim and decide write one effect each, and a second decide does not', async () => {
    const queue = new PostgresFraudReviewQueue(sql);
    const opened = await queue.enqueue({
      id: `rev-${randomUUID()}`,
      merchantId: MERCHANT,
      amount: '8',
      assetId: 'USDT',
      createdBy: 'ops-enqueue',
      decision: {
        outcome: 'review',
        reasons: [{ ruleId: 'velocity_count', detail: 'recentPaymentCount 9 exceeds maxPaymentsInWindow 2' }],
        skippedDisabled: [],
      },
    });
    const claimed = await queue.claim({ id: opened.id, actorId: 'ops-1' });
    const claimedAgain = await queue.claim({ id: opened.id, actorId: 'ops-1' });
    expect(claimedAgain.status).toBe('claimed');
    expect(claimedAgain.claimedBy).toBe(claimed.claimedBy);
    expect(await queue.countDecisions(opened.id, 'claim')).toBe(1);

    const allowed = await queue.resolve({ id: opened.id, outcome: 'allow', actorId: 'ops-1', note: 'known payer' });
    const again = await queue.resolve({ id: opened.id, outcome: 'allow', actorId: 'ops-2' });
    expect(again.status).toBe('allowed');
    expect(again.resolvedBy).toBe(allowed.resolvedBy);
    expect(await queue.countDecisions(opened.id, 'allow')).toBe(1);
    await expect(queue.resolve({ id: opened.id, outcome: 'decline', actorId: 'ops-2' })).rejects.toMatchObject({
      code: 'pay.fraud_review_closed',
    });
    expect(await queue.countDecisions(opened.id, 'decline')).toBe(0);

    const restarted = new PostgresFraudReviewQueue(sql);
    expect((await restarted.get(opened.id))?.status).toBe('allowed');
    await expect(sql`UPDATE pay.fraud_review_decisions SET note = 'rewrite' WHERE case_id = ${opened.id}`).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE pay.fraud_review_decisions`).rejects.toThrow(/TRUNCATE is not permitted/);
  });
});
