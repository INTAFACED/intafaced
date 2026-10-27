import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, merchantClearing, parseAmount as amt } from '@intafaced/ledger-client';
import { PayError, PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { signPayload } from '../rails/webhook-signature.js';
import { SubscriptionService, type SubscriptionInvoiceOpener, type SubscriptionServiceOptions } from './subscription-service.js';
import { MAX_ATTEMPTS_PER_CYCLE, chargeIdempotencyKey } from './charge-cycle.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';

/**
 * THE RECURRING CHARGE CYCLE, END TO END, ASSERTED ON BALANCES.
 *
 * `charge-cycle.test.ts` pins the decisions. This file pins what the decisions
 * do to the book, because "charged once" is a statement about a balance and not
 * about a status word. Every money assertion here reads `merchantClearing`
 * through the ledger; none of them reads an HTTP code.
 *
 * Postgres is real. The two idempotency guards are database indexes —
 * `unique(subscription_id, occurrence)` and `unique(idempotency_key)` — and an
 * in-memory fake would quietly not have them, which is the one thing that must
 * not be faked in a suite about double charging.
 *
 * The ledger is `MemoryLedger`, the reference implementation the conformance
 * suite proves equivalent to svc-ledger's Postgres engine (§4.4).
 *
 * A PER-RUN DATABASE. This suite applies migrations and truncates; `pay`'s SQL
 * is schema-qualified so a generated schema cannot host it. `createTestDatabase`
 * moves the isolation boundary to the DATABASE — the same reasoning
 * `user-money-service.test.ts` records, and the reason this file can safely
 * truncate `pay.payments` while `payment-service.test.ts` runs in a parallel worker.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-subscription-cycle-secret-at-least-32-chars';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = 'cust-recurring-1';

/** Jan 1 2026, and a monthly mandate anchored on it. */
const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h, 0, 0, 0));
const JAN = utc(2026, 1, 1);

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay charge-cycle is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay charge-cycle (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-pay subscription charge cycle PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let card: CardSandboxAdapter;
  let pay: PayService;

  /** Every invoice the runner opened, in order, with the key it used. */
  let opened: Array<{ occurrence: number; idempotencyKey: string; paymentId: string }>;
  /** Occurrences the opener should fail on, so a failure can be driven. */
  let failOn: Set<number>;
  /**
   * Occurrences whose payment create commits, then the opener throws before
   * returning the id. The execution therefore never receives payment_id.
   */
  let commitThenThrow: Set<number>;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('H8a: svc-pay charge-cycle PG was not opened');
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.subscription_executions, pay.subscriptions, pay.subscription_mandates,
               pay.payment_events, pay.payments, pay.merchants
       RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    opened = [];
    failOn = new Set();
    commitThenThrow = new Set();
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── harness ───────────────────────────────────────────────────────────────

  /**
   * The real invoice opener, over the real `PayService`.
   *
   * The card sandbox rather than crypto-native only because a sandbox capture is
   * a single signed webhook; the cycle does not know or care which rail carries
   * the invoice, and it still never pulls — it opens a payment the payer settles.
   */
  const opener: SubscriptionInvoiceOpener = async (input) => {
    if (failOn.has(input.occurrence)) {
      throw new PayError(`rail unavailable for occurrence ${input.occurrence}`, 'pay.rail_failed');
    }
    const payment = await pay.createPayment({
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
    opened.push({ occurrence: input.occurrence, idempotencyKey: input.idempotencyKey, paymentId: payment.id });
    if (commitThenThrow.has(input.occurrence)) {
      commitThenThrow.delete(input.occurrence);
      throw new Error('invoice link write failed');
    }
    return { paymentId: payment.id };
  };

  /** Builds the pair, with `afterPaymentEvent` wired exactly as `index.ts` does. */
  function build(options: { defaultFeeBps?: number; notifyPreCharge?: SubscriptionServiceOptions['notifyPreCharge'] } = {}): {
    subs: SubscriptionService;
  } {
    let subs: SubscriptionService;
    pay = new PayService(sql, ledger, new RailRegistry([card]), {
      defaultFeeBps: options.defaultFeeBps,
      afterPaymentEvent: async (event) => {
        // The watch half of invoice-and-watch: a capture settles the period.
        if (event.type === 'payment.captured') await subs.markExecutionSettledForPayment(event.payment.id);
      },
    });
    subs = new SubscriptionService(sql, () => new Date(), opener, {
      defaultFeeBps: options.defaultFeeBps,
      resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
      notifyPreCharge: options.notifyPreCharge,
    });
    return { subs };
  }

  async function merchant(feeBps = 250) {
    return pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps } });
  }

  /**
   * A merchant with NO published rate.
   *
   * Onboarding requires one, so this is the documented other path: a jsonb
   * `pricing` column with nothing in it, which `MerchantPricing` already treats
   * as optional on read.
   */
  async function merchantWithNoRate(): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, tier, kyb_status, status, pricing, settlement_prefs)
      VALUES (${MERCHANT_USER}, 'gateway', 0, 'none', 'active', '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async function mandateAndSubscription(
    subs: SubscriptionService,
    input: { merchantId: string; amount?: string; ceiling?: string | null; endsAt?: Date | null },
  ) {
    const mandate = await subs.createMandate({
      merchantId: input.merchantId,
      customerId: CUSTOMER,
      assetId: 'USDT',
      amount: amt(input.amount ?? '10'),
      ceiling: input.ceiling === undefined || input.ceiling === null ? null : amt(input.ceiling),
      cadence: 'monthly',
      startsAt: JAN,
      endsAt: input.endsAt ?? null,
    });
    const sub = await subs.createSubscription({ mandateId: mandate.id });
    return { mandate, sub };
  }

  /**
   * Drives the PAYER's side: authorize, then a signed capture webhook.
   *
   * Deliberately the real webhook path rather than a direct `capture()` call —
   * the invoice-and-watch loop only closes if the capture EVENT reaches
   * `markExecutionSettledForPayment`, and calling the service method directly
   * would prove the settle logic while skipping the wiring that delivers it.
   */
  async function payInvoice(paymentId: string, amount: string): Promise<void> {
    const payment = await pay.authorize(paymentId);
    const body = JSON.stringify({ id: `evt_${paymentId}`, type: 'captured', ref: payment.railRef, amount });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    await pay.handleWebhook('card-sandbox', {
      body,
      headers: {
        'x-sandbox-signature': signPayload(SECRET, timestamp, body),
        'x-sandbox-timestamp': timestamp,
      },
    });

    /*
     * AND THEN WAIT FOR THE WATCH TO LAND.
     *
     * `notifyPaymentEvent` is deliberately fire-and-forget — "never throws into
     * the money path" — so `handleWebhook` returns before
     * `markExecutionSettledForPayment` has run. Asserting immediately after it
     * is a race, and one that passes locally often enough to look fine.
     *
     * This waits for the observable effect rather than calling the settle method
     * directly, so the wiring being tested is the real one: capture event →
     * hook → period settled. A period that never settles times out here and the
     * test fails, which is the correct outcome.
     */
    await settleLanded(paymentId);
  }

  /**
   * Polls until the capture hook has settled the period this payment belongs to.
   *
   * A missing `subscription_executions` row is not a landed settlement. The
   * payment may not be linked yet, or the period may never have been written.
   * Keep polling. A row that exists and is not settled keeps polling too. Only
   * `status = settled` returns. When the attempts are exhausted, throw: a
   * period that never settles times out and the test fails.
   */
  async function settleLanded(paymentId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await sql<Array<{ status: string }>>`
        SELECT status FROM pay.subscription_executions WHERE payment_id = ${paymentId}
      `;
      if (rows.length > 0 && rows[0]!.status === 'settled') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`capture of ${paymentId} never settled its subscription period`);
  }

  describe('settleLanded does not treat a missing execution as landed', () => {
    it('a payment id with no subscription_executions row times out instead of landing', async () => {
      const paymentId = '00000000-0000-4000-8000-000000000099';
      const started = Date.now();
      await expect(settleLanded(paymentId)).rejects.toThrow(`capture of ${paymentId} never settled its subscription period`);
      // The loop is 100 attempts of 20ms. Returning on the first empty poll finishes far under this.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    }, 15_000);
  });

  const clearingOf = async (merchantId: string, assetId = 'USDT') =>
    formatAmount((await ledger.balance(merchantClearing(merchantId, assetId))).amount);

  const cyclesOf = (subs: SubscriptionService, subscriptionId: string) => subs.listCycles(subscriptionId, { limit: 50 });

  /** Every business key recorded anywhere in the journal, deduplicated. */
  async function distinctKeys(): Promise<string[]> {
    const rows = await sql<Array<{ idempotency_key: string }>>`
      SELECT DISTINCT idempotency_key FROM pay.subscription_executions WHERE idempotency_key IS NOT NULL
    `;
    return rows.map((r) => r.idempotency_key).sort();
  }

  // ── 1. A RETRIED CHARGE CHARGES ONCE ──────────────────────────────────────

  describe('a retried charge charges once', () => {
    /**
     * The cheapest way to charge twice: run the cron twice. The claim and the
     * key are the same write, so the second pass finds the period already
     * claimed and opens nothing.
     */
    it('a double-run of the same pass moves the balance once', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      await mandateAndSubscription(subs, { merchantId: m.id });

      const first = await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(first.fired).toBe(1);
      await payInvoice(opened[0]!.paymentId, '10');
      expect(await clearingOf(m.id)).toBe('10');

      // The same instant, again — a cron that fired twice, or two replicas.
      const second = await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(second.fired).toBe(0);

      // THE assertion: the book, not the report.
      expect(await clearingOf(m.id)).toBe('10');
      expect(opened).toHaveLength(1);
    });

    /**
     * The bar's shape, exactly: assert DISTINCT IDEMPOTENCY KEYS, not call
     * counts. A deduped post still returns a transaction, so counting calls
     * proves nothing — two periods must carry two keys and one period retried
     * must carry one.
     */
    it('a period that failed and then succeeded carries ONE key, and charges once', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      // Attempt one fails inside the money path.
      failOn.add(0);
      const failedPass = await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(failedPass.fired).toBe(0);
      expect(await clearingOf(m.id)).toBe('0');

      // Attempt two, in its retry slot, succeeds.
      failOn.clear();
      const retryPass = await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 10) });
      expect(retryPass.retried).toBe(1);
      await payInvoice(opened[0]!.paymentId, '10');

      // Charged ONCE, on the balance.
      expect(await clearingOf(m.id)).toBe('10');

      // ONE period, ONE key, two attempts. The key did not change between them.
      const cycles = await cyclesOf(subs, sub.id);
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.attemptCount).toBe(2);
      expect(await distinctKeys()).toEqual([chargeIdempotencyKey({ subscriptionId: sub.id, occurrence: 0 })]);
    });

    it('two PERIODS carry two keys — dedupe must not swallow next month', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 2, 1) });
      await payInvoice(opened[1]!.paymentId, '10');

      expect(await clearingOf(m.id)).toBe('20');
      expect(await distinctKeys()).toEqual([
        chargeIdempotencyKey({ subscriptionId: sub.id, occurrence: 0 }),
        chargeIdempotencyKey({ subscriptionId: sub.id, occurrence: 1 }),
      ]);
    });

    /**
     * The guard behind the guard. If a future change derived the key from a
     * clock, `(subscription_id, occurrence)` would still hold — so the second,
     * table-wide index is what makes a per-attempt key fail LOUDLY.
     */
    it('the database refuses a second row under an existing period key', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });
      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      const key = chargeIdempotencyKey({ subscriptionId: sub.id, occurrence: 0 });
      await expect(
        sql`
          INSERT INTO pay.subscription_executions (subscription_id, occurrence, amount, status, idempotency_key)
          VALUES (${sub.id}, 99, 10::numeric, 'pending', ${key})
        `,
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    /** Doctrine §0.6: the cycle itself never posts. Only the capture does. */
    it('opening an invoice posts nothing to the ledger', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(ledger.journal()).toHaveLength(0);
      expect(await clearingOf(m.id)).toBe('0');
    });
  });

  // ── 2. A FAILED CYCLE IS RECORDED AS FAILED ───────────────────────────────

  describe('a failed cycle is recorded as failed, and is not a zero-amount cycle', () => {
    it('records the failure with its code, its amount, and its attempt count', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      failOn.add(0);
      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.status).toBe('rejected');
      expect(cycle!.rejectionCode).toBe('pay.rail_failed');
      // DISTINGUISHABLE FROM A ZERO-AMOUNT CYCLE: the amount is what was owed.
      expect(formatAmount(cycle!.amount)).toBe('10');
      expect(cycle!.settledAt).toBeNull();
      expect(await clearingOf(m.id)).toBe('0');
    });

    /**
     * The strongest available form of "distinguishable from a zero-amount
     * cycle": a zero-amount cycle cannot be written at all. `amount > 0` is a
     * CHECK, so there is no state in which a failure and a zero charge look
     * alike.
     */
    it('a zero-amount cycle cannot be recorded — the database refuses it', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await expect(
        sql`
          INSERT INTO pay.subscription_executions (subscription_id, occurrence, amount, status)
          VALUES (${sub.id}, 0, 0::numeric, 'rejected')
        `,
      ).rejects.toThrow(/amount_positive|check/i);
    });

    it('exhausts its bounded attempts and then STALLS in arrears, never rolling forward', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      failOn.add(0);
      // Enough passes, spaced across the period, to spend every attempt.
      for (const day of [1, 10, 20, 25]) await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, day) });

      const cycles = await cyclesOf(subs, sub.id);
      // ONE period. Not four, and not February.
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.occurrence).toBe(0);
      expect(cycles[0]!.attemptCount).toBe(MAX_ATTEMPTS_PER_CYCLE);
      expect(cycles[0]!.exhaustedAt).not.toBeNull();

      const stalled = await subs.getSubscription(sub.id);
      expect(stalled.status).toBe('paused');
      expect(stalled.stallReason).toBe('arrears');
      expect(await clearingOf(m.id)).toBe('0');
    });

    /**
     * *"A period that cannot be settled blocks the next one rather than being
     * silently skipped, because compounding a gap changes what every subsequent
     * position paid."* Six months of failure must not become six months owed.
     */
    it('a failing period does NOT let later periods fall due', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      failOn.add(0);
      for (const month of [1, 2, 3, 4, 5, 6]) await subs.runDueSubscriptions({ limit: 50, now: utc(2026, month, 1) });

      const cycles = await cyclesOf(subs, sub.id);
      expect(cycles.map((c) => c.occurrence)).toEqual([0]);
      expect(await clearingOf(m.id)).toBe('0');
    });

    it('a suspended merchant gets no new invoice or pre-charge notice: the cycle is a named rejection', async () => {
      const notified: number[] = [];
      const { subs } = build({ defaultFeeBps: 250, notifyPreCharge: (event) => void notified.push(event.occurrence) });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      expect(opened).toEqual([]);
      // Refused before the pre-charge notice: the customer is not told of an invoice that never opens.
      expect(notified).toEqual([]);
      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.status).toBe('rejected');
      expect(cycle!.rejectionCode).toBe('pay.merchant_inactive');
      expect(await clearingOf(m.id)).toBe('0');
    });

    it('a KYB-rejected merchant gets no new invoice or pre-charge notice: the cycle is a named rejection', async () => {
      const notified: number[] = [];
      const { subs } = build({ defaultFeeBps: 250, notifyPreCharge: (event) => void notified.push(event.occurrence) });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });
      await sql`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${m.id}`;

      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      expect(opened).toEqual([]);
      // Refused before the pre-charge notice: the customer is not told of an invoice that never opens.
      expect(notified).toEqual([]);
      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.status).toBe('rejected');
      expect(cycle!.rejectionCode).toBe('pay.kyb_required');
    });

    it('an unpaid invoice becomes a named failure rather than pending forever', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect((await cyclesOf(subs, sub.id))[0]!.status).toBe('invoiced');

      // A full interval later, nobody paid it.
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 2, 2) });
      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.status).toBe('rejected');
      expect(cycle!.rejectionCode).toBe('pay.subscription_invoice_unpaid');
      expect(await clearingOf(m.id)).toBe('0');
      expect((await subs.getSubscription(sub.id)).stallReason).toBe('arrears');
    });

    /**
     * A RETRY IS ONLY SAFE WHEN THE PREVIOUS ATTEMPT LEFT NOTHING COLLECTIBLE.
     *
     * This is the guard that stops the arrears design from reintroducing the
     * defect it exists to prevent. An unpaid invoice is a LIVE claim on the
     * customer; opening a second invoice for the same period does not replace
     * it, both stay payable, and the execution row can only point at one. A
     * customer who paid both would have been charged twice for one month with
     * the journal showing a single settled period.
     *
     * So an expired invoice is terminal for its period even though the attempt
     * bound is nowhere near spent — and the assertion is on the count of
     * collectible invoices, which is what would actually take the money.
     */
    it('does NOT open a second invoice for a period whose first invoice went unpaid', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(opened).toHaveLength(1);

      // Several passes across and beyond the expiry, all with a healthy rail.
      for (const at of [utc(2026, 2, 2), utc(2026, 2, 10), utc(2026, 3, 1), utc(2026, 4, 1)]) {
        await subs.runDueSubscriptions({ limit: 50, now: at });
      }

      // ONE collectible invoice for the period, not four.
      expect(opened).toHaveLength(1);
      const payments = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.payments`;
      expect(payments[0]!.n).toBe('1');
      expect((await cyclesOf(subs, sub.id))[0]!.exhaustedAt).not.toBeNull();
      expect(await clearingOf(m.id)).toBe('0');
    });

    /**
     * A late payment is still a payment. The money is in the book, so refusing to
     * acknowledge the period because the engine had given up on it would leave a
     * paid-up customer in arrears forever — and would block every later period
     * for a debt that no longer exists.
     */
    it('paying a written-off invoice late settles the period and lifts the arrears', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 2, 2) });
      expect((await subs.getSubscription(sub.id)).stallReason).toBe('arrears');

      // The customer pays the original invoice, late.
      await payInvoice(opened[0]!.paymentId, '10');

      expect(await clearingOf(m.id)).toBe('10');
      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.status).toBe('settled');
      expect(cycle!.exhaustedAt).toBeNull();

      const healed = await subs.getSubscription(sub.id);
      expect(healed.stallReason).toBeNull();
      expect(healed.status).toBe('active');
    });

    /**
     * An operator pause is not lifted by a payment. The distinction the ADR asks
     * for has to hold in the code that clears a stall, not only in the column.
     */
    it('a late payment does NOT un-pause a subscription a person paused', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await subs.pauseSubscription(sub.id);
      await payInvoice(opened[0]!.paymentId, '10');

      const still = await subs.getSubscription(sub.id);
      expect(still.status).toBe('paused');
      expect(still.stallReason).toBe('operator_pause');
      // The period it had already invoiced still settles — that money is real.
      expect((await cyclesOf(subs, sub.id))[0]!.status).toBe('settled');
      expect(await clearingOf(m.id)).toBe('10');
    });

    /**
     * Last attempt: the invoice payment has committed, and the write that
     * follows throws before payment_id is stored. The cycle is rejected and
     * exhausted with no payment_id. The next pass attaches the existing
     * payment and does not open another invoice. Capture of that payment
     * settles the period.
     */
    it('links the payment a last attempt already opened, then a capture settles the period', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      failOn.add(0);
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 1) });
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 10) });
      failOn.delete(0);
      commitThenThrow.add(0);

      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 20) });

      expect(opened).toHaveLength(1);
      const payments = await sql<Array<{ n: string; amount: string }>>`
        SELECT count(*)::text AS n, min(amount)::text AS amount FROM pay.payments
      `;
      expect(payments[0]!.n).toBe('1');
      expect(formatAmount(amt(payments[0]!.amount))).toBe('10');

      const [exhausted] = await cyclesOf(subs, sub.id);
      expect(exhausted!.status).toBe('rejected');
      expect(exhausted!.attemptCount).toBe(MAX_ATTEMPTS_PER_CYCLE);
      expect(exhausted!.exhaustedAt).not.toBeNull();
      expect(exhausted!.paymentId).toBeNull();
      expect(formatAmount(exhausted!.amount)).toBe('10');
      expect(await clearingOf(m.id)).toBe('0');

      const again = await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 25) });
      expect(again.fired).toBe(0);
      expect(opened).toHaveLength(1);
      const stillOne = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.payments`;
      expect(stillOne[0]!.n).toBe('1');

      const [linked] = await cyclesOf(subs, sub.id);
      expect(linked!.paymentId).toBe(opened[0]!.paymentId);
      expect(linked!.status).toBe('rejected');
      expect(formatAmount(linked!.amount)).toBe('10');
      expect((await subs.getSubscription(sub.id)).stallReason).toBe('arrears');

      await payInvoice(opened[0]!.paymentId, '10');

      const [settled] = await cyclesOf(subs, sub.id);
      expect(settled!.status).toBe('settled');
      expect(settled!.paymentId).toBe(opened[0]!.paymentId);
      expect(settled!.exhaustedAt).toBeNull();
      expect(await clearingOf(m.id)).toBe('10');
      const healed = await subs.getSubscription(sub.id);
      expect(healed.stallReason).toBeNull();
      expect(healed.status).toBe('active');
      expect(opened).toHaveLength(1);
    });
  });

  // ── 3. A RESUMED SCHEDULE DOES NOT COMPRESS ───────────────────────────────

  describe('a resumed schedule does not fire overdue periods back-to-back', () => {
    /**
     * THE DEFECT, in money. Paused after January and resumed in May, the old
     * shape would have charged February, March, April and May at once — 50 USDT
     * in one pass on a 10 USDT-a-month subscription. The assertion is the
     * balance, because that is what the customer sees.
     */
    it('charges ONE period on resume, not the four that went by', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      expect(await clearingOf(m.id)).toBe('10');

      await subs.pauseSubscription(sub.id);
      const paused = await subs.getSubscription(sub.id);
      expect(paused.stallReason).toBe('operator_pause');

      // Four months later.
      const resumeAt = utc(2026, 5, 1);
      const resumedSubs = new SubscriptionService(sql, () => resumeAt, opener, {
        defaultFeeBps: 250,
        resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
      });
      const { projectedEnd } = await resumedSubs.resumeSubscription(sub.id);
      // Open-ended mandate: nothing to project, and nothing refused.
      expect(projectedEnd).toBeNull();

      await resumedSubs.runDueSubscriptions({ limit: 50, now: resumeAt });
      expect(opened).toHaveLength(2);
      await payInvoice(opened[1]!.paymentId, '10');

      // 20, not 50. The four months are neither compressed nor forfeited — the
      // schedule simply runs four months later.
      expect(await clearingOf(m.id)).toBe('20');

      // And another pass at the same instant adds nothing.
      await resumedSubs.runDueSubscriptions({ limit: 50, now: resumeAt });
      expect(opened).toHaveLength(2);
      expect(await clearingOf(m.id)).toBe('20');
    });

    it('the resumed subscription then waits a full interval for its next period', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      await subs.pauseSubscription(sub.id);

      const resumeAt = utc(2026, 5, 10);
      const resumed = new SubscriptionService(sql, () => resumeAt, opener, {
        defaultFeeBps: 250,
        resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
      });
      await resumed.resumeSubscription(sub.id);
      await resumed.runDueSubscriptions({ limit: 50, now: resumeAt });
      await payInvoice(opened[1]!.paymentId, '10');

      // Two weeks on: nothing more is owed yet. Opening an invoice does not
      // pay it, so clearing stays 20 whether or not a third invoice exists.
      // The count is the bill. Two weeks after resume is not the next period.
      await resumed.runDueSubscriptions({ limit: 50, now: utc(2026, 5, 24) });
      expect(opened).toHaveLength(2);
      expect(await clearingOf(m.id)).toBe('20');

      // A month on from the RESUME instant, not from the mandate's start.
      // Pay the invoice this pass opened. A length of 3 is also true when
      // 24 May already opened the third invoice and 10 June opened nothing.
      const openedBeforeJune = opened.map((invoice) => invoice.paymentId);
      await resumed.runDueSubscriptions({ limit: 50, now: utc(2026, 6, 10) });
      expect(opened).toHaveLength(3);
      const openedInJune = opened.filter((invoice) => !openedBeforeJune.includes(invoice.paymentId));
      expect(openedInJune).toHaveLength(1);
      await payInvoice(openedInJune[0]!.paymentId, '10');
      expect(await clearingOf(m.id)).toBe('30');
    });

    /**
     * *"Two ways in, and the second needs nobody: the tick host is simply down
     * for a while. No user action at all."* An outage must not compress either,
     * and it must be distinguishable from a pause on the record.
     */
    it('a runner outage does not burst, and is recorded as an outage not a pause', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');

      // Nobody pauses anything. The cron just does not run until May.
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 5, 1) });
      expect(opened).toHaveLength(2);
      await payInvoice(opened[1]!.paymentId, '10');
      expect(await clearingOf(m.id)).toBe('20');

      const after = await subs.getSubscription(sub.id);
      expect(after.stallReason).toBe('runner_outage');
      expect(after.pausedAt).toBeNull();
      expect(after.status).toBe('active');
      // The frame moved, which is what stops the next pass firing again.
      expect(after.anchorAt?.toISOString()).toBe(utc(2026, 5, 1).toISOString());
      expect(after.anchorOccurrence).toBe(1);
    });

    it('an on-time charge clears the outage mark', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 5, 1) });
      await payInvoice(opened[1]!.paymentId, '10');
      expect((await subs.getSubscription(sub.id)).stallReason).toBe('runner_outage');

      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 6, 1) });
      await payInvoice(opened[2]!.paymentId, '10');
      const healthy = await subs.getSubscription(sub.id);
      expect(healthy.stallReason).toBeNull();
      expect(await clearingOf(m.id)).toBe('30');
    });

    /**
     * Where this deliberately differs from the TWAP ruling. The window is
     * consent, so re-spacing may not run past `endsAt` — and the answer is a
     * refusal with the projected end, not a compression and not a silent drop.
     */
    it('REFUSES a resume that would re-space past the mandate window', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      // Jan..Jun authorised: six periods, and no room to shift them.
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id, endsAt: utc(2026, 7, 1) });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      await subs.pauseSubscription(sub.id);

      const resumeAt = utc(2026, 5, 1);
      const resumed = new SubscriptionService(sql, () => resumeAt, opener, {
        defaultFeeBps: 250,
        resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
      });
      await expect(resumed.resumeSubscription(sub.id)).rejects.toMatchObject({
        code: 'pay.subscription_resume_exceeds_mandate',
      });

      // Refused means refused: still paused, and nothing charged.
      expect((await subs.getSubscription(sub.id)).status).toBe('paused');
      expect(await clearingOf(m.id)).toBe('10');
    });

    it('a paused subscription is not charged by a pass at all', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });
      await subs.pauseSubscription(sub.id);

      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 4, 1) });
      expect(opened).toHaveLength(0);
      expect(await clearingOf(m.id)).toBe('0');
      expect(await cyclesOf(subs, sub.id)).toEqual([]);
    });
  });

  // ── 4. THE MANDATE IS THE CEILING ─────────────────────────────────────────

  describe('a charge above the mandate ceiling refuses by code', () => {
    /**
     * REACHABLE, and this is why the check is at the moment of the charge rather
     * than the moment of the plan: a period claimed under one mandate reading is
     * retried after those terms were lowered. Checking against the mandate just
     * read would be a guard that can never fire.
     */
    it('refuses a retry of a period the mandate no longer authorises', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { mandate, sub } = await mandateAndSubscription(subs, { merchantId: m.id, amount: '10', ceiling: '25' });

      // The period is claimed at 10, and its first attempt fails.
      failOn.add(0);
      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(formatAmount((await cyclesOf(subs, sub.id))[0]!.amount)).toBe('10');

      // The mandate's terms are lowered underneath it.
      await sql`
        UPDATE pay.subscription_mandates SET amount = 5::numeric, ceiling = 5::numeric WHERE id = ${mandate.id}
      `;

      failOn.clear();
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 10) });

      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.rejectionCode).toBe('pay.subscription_exceeds_mandate');
      // Terminal: retrying cannot make an unauthorised charge authorised.
      expect(cycle!.exhaustedAt).not.toBeNull();
      // NOTHING MOVED. The book is the assertion.
      expect(await clearingOf(m.id)).toBe('0');
      expect(opened).toHaveLength(0);
    });

    it('refuses a charge outside the mandate window rather than charging late', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { mandate, sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      failOn.add(0);
      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      // The mandate's authorisation is closed before the retry lands.
      await sql`UPDATE pay.subscription_mandates SET ends_at = ${utc(2026, 1, 5)} WHERE id = ${mandate.id}`;

      failOn.clear();
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 1, 10) });

      expect((await cyclesOf(subs, sub.id))[0]!.rejectionCode).toBe('pay.subscription_exceeds_mandate');
      expect(await clearingOf(m.id)).toBe('0');
    });

    it('a cancelled mandate ends the subscription instead of charging it', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { mandate, sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await sql`UPDATE pay.subscription_mandates SET status = 'cancelled' WHERE id = ${mandate.id}`;
      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      expect((await subs.getSubscription(sub.id)).status).toBe('cancelled');
      expect(await clearingOf(m.id)).toBe('0');
      expect(opened).toHaveLength(0);
    });
  });

  describe('a cancel that commits after the due snapshot does not open an invoice', () => {
    /**
     * The due pass already holds an active subscription and an active mandate.
     * Cancel commits on another connection. The charge must wait on that row,
     * see the cancel, and not call openInvoice.
     */
    it('does not call openInvoice when the loaded mandate or subscription is cancelled', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const frame = {
        cadence: 'monthly' as const,
        mandateStartsAt: JAN,
        mandateEndsAt: null,
        anchorAt: null,
        anchorOccurrence: 0,
      };

      async function stillPending<T>(pending: Promise<T>, ms: number): Promise<boolean> {
        const winner = await Promise.race([
          pending.then(
            () => 'settled' as const,
            () => 'settled' as const,
          ),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
        ]);
        return winner === 'pending';
      }

      async function parkCancel(which: 'subscription' | 'mandate', id: string) {
        let announceLocked!: () => void;
        let release!: () => void;
        const locked = new Promise<void>((resolve) => {
          announceLocked = resolve;
        });
        const mayCommit = new Promise<void>((resolve) => {
          release = resolve;
        });
        const done = sql.begin(async (tx) => {
          if (which === 'subscription') {
            await tx`
              UPDATE pay.subscriptions
                 SET status = 'cancelled', cancelled_at = ${JAN}, updated_at = ${JAN}
               WHERE id = ${id}
            `;
          } else {
            await tx`
              UPDATE pay.subscription_mandates
                 SET status = 'cancelled', cancelled_at = ${JAN}, updated_at = ${JAN}
               WHERE id = ${id}
            `;
          }
          announceLocked();
          await mayCommit;
        });
        await locked;
        let released = false;
        return {
          async commit() {
            if (released) return;
            released = true;
            release();
            await done;
          },
        };
      }

      for (const which of ['subscription', 'mandate'] as const) {
        const loaded = await mandateAndSubscription(subs, { merchantId: m.id });
        const hold = await parkCancel(which, which === 'subscription' ? loaded.sub.id : loaded.mandate.id);
        const attempt = subs.attemptCycle({
          sub: loaded.sub,
          mandate: loaded.mandate,
          frame,
          occurrence: 0,
          isRetry: false,
          now: JAN,
        });
        const guarded = attempt.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          expect(await stillPending(guarded, 400)).toBe(true);
          await hold.commit();
          const result = await guarded;
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value.outcome).toBe('skipped');
          expect(opened).toHaveLength(0);
        } finally {
          await hold.commit();
        }
      }

      expect(await clearingOf(m.id)).toBe('0');
    }, 20_000);
  });

  // ── 5. AN UNSET FEE REFUSES BY CODE ───────────────────────────────────────

  describe('an unset fee is refuse-closed', () => {
    /**
     * The period is refused BEFORE it is claimed: no execution row, no attempt
     * spent, and the period still owed. An operator's configuration gap must not
     * consume a customer's charge attempts.
     */
    it('refuses to open a charge at an unknown price, and claims nothing', async () => {
      const { subs } = build({}); // no platform default
      const merchantId = await merchantWithNoRate();
      const { sub } = await mandateAndSubscription(subs, { merchantId });

      const report = await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(report.stalled).toBe(1);
      expect(report.outcomes[0]).toMatchObject({ outcome: 'stalled', stallReason: 'fee_unpublished' });
      expect(report.outcomes[0]!.rejectionCode).toBe('pay.subscription_fee_unpublished');

      // Nothing claimed, nothing charged, and the reason is on the record.
      expect(await cyclesOf(subs, sub.id)).toEqual([]);
      expect(await clearingOf(merchantId)).toBe('0');
      expect(opened).toHaveLength(0);
      const stalled = await subs.getSubscription(sub.id);
      expect(stalled.stallReason).toBe('fee_unpublished');
      expect(stalled.status).toBe('paused');
    });

    it('does not silently charge at zero when nobody published a rate', async () => {
      const { subs } = build({});
      const merchantId = await merchantWithNoRate();
      await mandateAndSubscription(subs, { merchantId });
      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      // The tempting bug: a 0 bps "sensible default" and a charge that lands.
      expect(ledger.journal()).toHaveLength(0);
      expect(await clearingOf(merchantId)).toBe('0');
    });

    it('charges once a rate IS published — the refusal is the rate, not the wiring', async () => {
      const withRate = build({ defaultFeeBps: 250 });
      const merchantId = await merchantWithNoRate();
      const { sub } = await mandateAndSubscription(withRate.subs, { merchantId });

      await withRate.subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      expect(await clearingOf(merchantId)).toBe('10');
      expect((await withRate.subs.getSubscription(sub.id)).stallReason).toBeNull();
    });
  });

  // ── 6. THE CARD RAIL IS ABSENT, AND SAYS SO ───────────────────────────────

  describe('the card mandate rail is absent, by name', () => {
    /**
     * Not a silent skip. `rail-adapter.ts` declares a `mandate` capability with
     * `createMandate` / `revokeMandate` and NO charge-against-mandate operation;
     * no registered adapter declares it. Until that port widens, a card-mandate
     * subscription refuses with a code an operator can search for.
     */
    it('refuses a card-mandate subscription with pay.mandate_rail_absent', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const mandate = await subs.createMandate({
        merchantId: m.id,
        customerId: CUSTOMER,
        assetId: 'USDT',
        amount: amt('10'),
        cadence: 'monthly',
        startsAt: JAN,
      });
      const sub = await subs.createSubscription({ mandateId: mandate.id, path: 'card_mandate' });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });

      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.rejectionCode).toBe('pay.mandate_rail_absent');
      expect(await clearingOf(m.id)).toBe('0');
      expect(opened).toHaveLength(0);
    });

    it('refuses when no invoice driver is wired at all, rather than skipping quietly', async () => {
      build({ defaultFeeBps: 250 });
      const m = await merchant();
      const driverless = new SubscriptionService(sql, () => JAN, undefined, {
        defaultFeeBps: 250,
        resolveMerchantFeeBps: async (merchantId) => (await pay.getMerchant(merchantId)).pricing.feeBps,
      });
      const { sub } = await mandateAndSubscription(driverless, { merchantId: m.id });

      await driverless.runDueSubscriptions({ limit: 50, now: JAN });
      expect((await driverless.listCycles(sub.id, { limit: 50 }))[0]!.rejectionCode).toBe('pay.subscription_driver_absent');
      expect(await clearingOf(m.id)).toBe('0');
    });
  });

  // ── 7. LIFECYCLE ─────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('cancel stops the schedule at once and does not reverse what settled', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      await subs.cancelSubscription(sub.id);

      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 2, 1) });
      expect(opened).toHaveLength(1);
      // The settled period stands — a cancel is not a refund.
      expect(await clearingOf(m.id)).toBe('10');
    });

    it('completes a bounded mandate rather than charging past its window', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      // Jan and Feb only.
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id, endsAt: utc(2026, 3, 1) });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      await payInvoice(opened[0]!.paymentId, '10');
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 2, 1) });
      await payInvoice(opened[1]!.paymentId, '10');
      await subs.runDueSubscriptions({ limit: 50, now: utc(2026, 3, 1) });

      expect(opened).toHaveLength(2);
      expect((await subs.getSubscription(sub.id)).status).toBe('completed');
      expect(await clearingOf(m.id)).toBe('20');
    });

    it('refuses to resume something that was never paused', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });
      await expect(subs.resumeSubscription(sub.id)).rejects.toMatchObject({ code: 'pay.subscription_inactive' });
    });
  });

  describe('pre-charge notify is recorded on the execution', () => {
    it('unwired port writes skipped_unwired and still opens the invoice (money fail-closed on capture)', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      const report = await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(report.fired).toBe(1);
      expect(report.outcomes[0]!.notifyStatus).toBe('skipped_unwired');
      expect(report.outcomes[0]!.noticeCode).toBe('pay.subscription_notify_unwired');

      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.notifyStatus).toBe('skipped_unwired');
      expect(cycle!.notifyCode).toBe('pay.subscription_notify_unwired');
      expect(opened).toHaveLength(1);
      expect(await clearingOf(m.id)).toBe('0');

      await payInvoice(opened[0]!.paymentId, '10');
      expect(await clearingOf(m.id)).toBe('10');
    });

    it('wired port records attempted before the invoice and capture still fail-closes', async () => {
      const seen: Array<{ type: string; occurrence: number }> = [];
      const { subs } = build({
        defaultFeeBps: 250,
        notifyPreCharge: (event) => {
          seen.push({ type: event.type, occurrence: event.occurrence });
        },
      });
      const m = await merchant();
      const { sub } = await mandateAndSubscription(subs, { merchantId: m.id });

      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      expect(seen).toEqual([{ type: 'subscription.invoice_upcoming', occurrence: 0 }]);
      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.notifyStatus).toBe('attempted');
      expect(cycle!.notifyCode).toBeNull();
      expect(opened).toHaveLength(1);
      expect(await clearingOf(m.id)).toBe('0');

      await payInvoice(opened[0]!.paymentId, '10');
      expect(await clearingOf(m.id)).toBe('10');
    });

    it('card mandate still refuses pay.mandate_rail_absent with no notify pretence', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const mandate = await subs.createMandate({
        merchantId: m.id,
        customerId: CUSTOMER,
        assetId: 'USDT',
        amount: amt('10'),
        cadence: 'monthly',
        startsAt: JAN,
      });
      const sub = await subs.createSubscription({ mandateId: mandate.id, path: 'card_mandate' });
      await subs.runDueSubscriptions({ limit: 50, now: JAN });
      const [cycle] = await cyclesOf(subs, sub.id);
      expect(cycle!.rejectionCode).toBe('pay.mandate_rail_absent');
      expect(cycle!.notifyStatus).toBeNull();
      expect(opened).toHaveLength(0);
      expect(await clearingOf(m.id)).toBe('0');
    });
  });

  describe('a due-pass throw stays on that subscription', () => {
    it('the earlier due row throws, the later one still runs, and the next pass is not stuck on the thrower', async () => {
      const { subs } = build({ defaultFeeBps: 250 });
      const m = await merchant();
      const early = await mandateAndSubscription(subs, { merchantId: m.id, amount: '10' });
      const late = await mandateAndSubscription(subs, { merchantId: m.id, amount: '12' });

      const earlyAt = utc(2026, 1, 1, 0);
      const lateAt = utc(2026, 1, 1, 1);
      const now = utc(2026, 1, 1, 2);
      await sql`UPDATE pay.subscriptions SET next_run_at = ${earlyAt} WHERE id = ${early.sub.id}`;
      await sql`UPDATE pay.subscriptions SET next_run_at = ${lateAt} WHERE id = ${late.sub.id}`;

      const original = subs.getMandate.bind(subs);
      const spy = vi.spyOn(subs, 'getMandate').mockImplementation(async (mandateId: string) => {
        if (mandateId === early.mandate.id) {
          throw new PayError(`Mandate ${mandateId} not found`, 'pay.mandate_not_found');
        }
        return original(mandateId);
      });

      try {
        const first = await subs.runDueSubscriptions({ limit: 50, now });
        expect(first.examined).toBe(2);
        expect(first.fired).toBe(1);
        expect(first.stalled).toBe(1);
        expect(first.outcomes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              subscriptionId: early.sub.id,
              occurrence: null,
              outcome: 'stalled',
              stallReason: 'due_pass_fault',
              rejectionCode: 'pay.mandate_not_found',
            }),
            expect.objectContaining({
              subscriptionId: late.sub.id,
              outcome: 'invoiced',
            }),
          ]),
        );

        expect(await cyclesOf(subs, early.sub.id)).toEqual([]);
        expect(opened).toHaveLength(1);
        expect(opened[0]!.idempotencyKey).toBe(chargeIdempotencyKey({ subscriptionId: late.sub.id, occurrence: 0 }));
        const amounts = await sql<Array<{ amount: string }>>`
          SELECT amount::text AS amount FROM pay.payments WHERE id = ${opened[0]!.paymentId}
        `;
        expect(formatAmount(amt(amounts[0]!.amount))).toBe('12');

        await payInvoice(opened[0]!.paymentId, '12');
        expect(await clearingOf(m.id)).toBe('12');
        expect(ledger.journal().some((tx) => tx.idempotencyKey.includes(early.sub.id))).toBe(false);

        const stalled = await subs.getSubscription(early.sub.id);
        expect(stalled.status).toBe('paused');
        expect(stalled.stallReason).toBe('due_pass_fault');

        const second = await subs.runDueSubscriptions({ limit: 1, now });
        expect(second.examined).toBe(0);
        expect(second.outcomes.some((outcome) => outcome.subscriptionId === early.sub.id)).toBe(false);
        expect(opened).toHaveLength(1);
        expect(await clearingOf(m.id)).toBe('12');

        const stillFirst = await sql<Array<{ id: string }>>`
          SELECT id FROM pay.subscriptions
           WHERE status = 'active' AND next_run_at <= ${now}
           ORDER BY next_run_at ASC
           LIMIT 1
        `;
        expect(stillFirst.some((row) => row.id === early.sub.id)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
