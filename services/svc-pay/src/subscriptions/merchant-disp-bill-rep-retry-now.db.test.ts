import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayError, PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { SubscriptionService, type SubscriptionInvoiceOpener } from './subscription-service.js';
import { SubscriptionRetryPolicyService } from './retry-policy.js';
import { SubscriptionRetryNow } from './retry-now.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';

/** M-bill-04 retryNow and final action against a real Postgres, through the real charge path. */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const SECRET = 'svc-pay-subscription-retry-now-secret-at-least-32-chars';
const MERCHANT_USER = '22222222-2222-4222-8222-222222222222';
const JAN = new Date(Date.UTC(2026, 0, 1));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const c = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_retry_now_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: c.getConnectionUri(), stop: async () => void (await c.stop()) };
}

describe('M-bill-04 retryNow and final action (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let subs!: SubscriptionService;
  let policy!: SubscriptionRetryPolicyService;
  let retry!: SubscriptionRetryNow;
  let failing = true;
  let opens = 0;

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
      `TRUNCATE pay.subscription_retry_final_actions, pay.subscription_retry_policy_events, pay.subscription_retry_policies,
               pay.subscription_executions, pay.subscriptions, pay.subscription_mandates,
               pay.payment_events, pay.payments, pay.merchants
       RESTART IDENTITY CASCADE`,
    );
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([card]), { defaultFeeBps: 250 });
    failing = true;
    opens = 0;
    const opener: SubscriptionInvoiceOpener = async (input) => {
      if (failing) throw new PayError('rail unavailable', 'pay.rail_failed');
      opens += 1;
      const p = await pay.createPayment({
        merchantId: input.merchantId,
        amount: input.amount,
        assetId: input.assetId,
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
        metadata: {
          source: 'subscription',
          subscriptionId: input.subscriptionId,
          occurrence: String(input.occurrence),
          subscriptionCycleKey: input.idempotencyKey,
        },
      });
      return { paymentId: p.id };
    };
    subs = new SubscriptionService(sql, () => new Date(), opener, {
      defaultFeeBps: 250,
      resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
    });
    policy = new SubscriptionRetryPolicyService(sql);
    retry = new SubscriptionRetryNow(sql, subs, policy);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** A merchant whose first cycle failed once (attempt 1, status rejected). */
  async function failedCycle(attempts: number | null, finalAction: 'cancel' | 'mark_unpaid' | 'leave_past_due' = 'cancel') {
    const m = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 250 } });
    if (attempts !== null) {
      await policy.set(
        { merchantId: m.id, values: { attempts, spacingHours: 24, finalAction }, autoRetry: false, expectedVersion: 0 },
        'owner',
      );
    }
    const mandate = await subs.createMandate({
      merchantId: m.id,
      customerId: 'cust-retry-1',
      assetId: 'USDT',
      amount: amt('10'),
      ceiling: null,
      cadence: 'monthly',
      startsAt: JAN,
      endsAt: null,
    });
    const sub = await subs.createSubscription({ mandateId: mandate.id });
    await subs.runDueSubscriptions({ limit: 50, now: JAN });
    const [exec] = await sql<Array<{ id: string; status: string; attempt_count: number }>>`
      SELECT id, status, attempt_count FROM pay.subscription_executions WHERE subscription_id = ${sub.id}`;
    expect(exec).toMatchObject({ status: 'rejected', attempt_count: 1 });
    return { sub, executionId: exec!.id };
  }

  it('retryNow runs the charge path once; the same attempt twice returns the first attempt', async () => {
    const { executionId } = await failedCycle(3);
    failing = false;
    const first = await retry.retryNow({ executionId, attempt: 2 }, 'owner');
    expect(first).toMatchObject({ outcome: 'reissued', attempt: 2, finalAction: null });
    expect(first.paymentId).not.toBeNull();
    const second = await retry.retryNow({ executionId, attempt: 2 }, 'owner');
    expect(second).toMatchObject({ outcome: 'already_attempted', attempt: 2, paymentId: first.paymentId });
    expect(opens).toBe(1);
  });

  it('paid invoice -> retryNow does nothing', async () => {
    const { executionId } = await failedCycle(3);
    await sql`UPDATE pay.subscription_executions SET status = 'settled' WHERE id = ${executionId}`;
    failing = false;
    expect((await retry.retryNow({ executionId, attempt: 2 }, 'owner')).outcome).toBe('already_paid');
    expect(opens).toBe(0);
  });

  it('an attempt whose result is unknown shows checking and the next attempt waits', async () => {
    const { executionId } = await failedCycle(3);
    await sql`UPDATE pay.subscription_executions SET status = 'pending' WHERE id = ${executionId}`;
    failing = false;
    expect((await retry.retryNow({ executionId, attempt: 2 }, 'owner')).outcome).toBe('checking');
    expect(opens).toBe(0);
  });

  it('blank policy -> retryNow refused, nothing charged', async () => {
    const { executionId } = await failedCycle(null);
    failing = false;
    await expect(retry.retryNow({ executionId, attempt: 2 }, 'owner')).rejects.toMatchObject({
      code: 'pay.subscription_retry_policy_unset',
    });
    expect(opens).toBe(0);
  });

  it('final action once per cycle: attempts spent -> cancel applied once, repeats return it', async () => {
    const { sub, executionId } = await failedCycle(1, 'cancel');
    const a = await retry.retryNow({ executionId, attempt: 2 }, 'owner');
    expect(a).toMatchObject({ outcome: 'final_action_applied', finalAction: 'cancel' });
    const b = await retry.retryNow({ executionId, attempt: 2 }, 'owner');
    expect(b).toMatchObject({ outcome: 'final_action_applied', finalAction: 'cancel' });
    const [{ n }] = (await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.subscription_retry_final_actions WHERE subscription_id = ${sub.id}`) as [{ n: number }];
    expect(n).toBe(1);
    expect((await subs.getSubscription(sub.id)).status).toBe('cancelled');
    expect(opens).toBe(0);
  });

  it('leave_past_due records the decision and stops further retries without cancelling', async () => {
    const { sub, executionId } = await failedCycle(1, 'leave_past_due');
    expect((await retry.retryNow({ executionId, attempt: 2 }, 'owner')).finalAction).toBe('leave_past_due');
    expect((await subs.getSubscription(sub.id)).status).toBe('active');
  });

  it('an attempt number that skips ahead or an unknown execution is refused', async () => {
    const { executionId } = await failedCycle(3);
    await expect(retry.retryNow({ executionId, attempt: 4 }, 'owner')).rejects.toMatchObject({
      code: 'pay.subscription_retry_attempt_not_found',
    });
    await expect(retry.retryNow({ executionId: '00000000-0000-4000-8000-000000000000', attempt: 2 }, 'owner')).rejects.toMatchObject({
      code: 'pay.subscription_retry_attempt_not_found',
    });
  });
});
