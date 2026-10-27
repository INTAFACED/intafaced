import { truncatePayForTest } from './payment-events-test-reset.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import {
  InsufficientFundsError,
  MemoryLedger,
  formatAmount,
  houseFees,
  merchantClearing,
  merchantProceeds,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { PayService, PayError, type PaymentView } from './payment-service.js';
import { NOOP_GUARDS } from './seams/guards.js';
import { loadKybDecisionBinding } from './kyb-decision-binding.js';
import { defaultDisputeCaseStore } from './fraud/dispute-case.js';
import { REFERENCE_RAIL_ROUTING_PROFILES, type RailRoutingProfile } from './routing/decide.js';
import { memoryPayoutDestinations, MerchantPayoutDestinationStore } from './merchant-payout-destination.js';
import { installPayoutDestinationShim } from './payout-destination-test-shim.js';
import { RailRegistry } from './rails/registry.js';
import { railFailure } from './rails/rail-adapter.js';
import { CardSandboxAdapter, SANDBOX_DECLINE_TOKEN } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { MemoryChain } from './rails/chain-port.js';
import { signPayload } from './rails/webhook-signature.js';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { createIdentityOperationDecisionClient, type IdentityOperationDecisionPort, type Context } from '@intafaced/contracts';
import { createPayRouter } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { UserMoneyService } from './user-money-service.js';
import { randomUUID } from 'node:crypto';
import { MerchantAccountControls } from './merchant-account-controls.js';
import { drainPendingPaymentIdentityIntents } from './payment-admission.js';
import { createLedgerClient } from './ledger-client.js';
import { fakeLedgerDoor, type DoorCall } from './ledger-door-fake.js';

/** Who moves KYB in these tests; `merchant_kyb_events` records it. */
const KYB_ACTOR = { id: 'kyb-test-actor', scope: 'pay:onboard' };

/**
 * svc-pay money paths.
 *
 * The ledger here is `MemoryLedger` — the reference implementation, which the
 * ledger conformance suite proves behaves identically to svc-ledger's Postgres
 * engine (§4.4). That equivalence is what makes it legitimate to use here:
 * these tests are about svc-pay's recipes and ordering, not about the ledger.
 *
 * Postgres is real, because the payment row / event log / ledger interaction is
 * exactly where a bug would hide — and because the append-only guarantee on
 * `payment_events` is enforced by a database trigger, which an in-memory fake
 * would quietly not have.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 0000, 0002, 0003 and 0005 — every migration touching the MERCHANT-money tables,
 * applied together and truncated together in `beforeEach`.
 *
 * The hosted-checkout tests live in this file rather than in one of their own
 * for exactly that reason. `merchants`, `payment_links`, `checkout_sessions`,
 * `payments` and `payment_events` are one connected set. 0001's tables
 * (`deposits`, `withdrawals`) are disjoint, which is precisely why
 * `user-money-service.test.ts` legitimately gets its own file.
 *
 * Isolation is now a per-run DATABASE (`createTestDatabase`), so a parallel
 * file on the same tables no longer shares rows with this suite.
 */
const migrations = [
  '0000_pay_init.sql',
  '0002_pay_payment_links.sql',
  '0003_pay_checkout_sessions.sql',
  '0005_pay_merchant_kyb.sql',
  // submitKyb and every KYB decision write their history row.
  '0013_pay_merchant_kyb_history.sql',
  '0006_pay_merchant_status_history.sql',
  // createMerchant reads parent_merchant_id, so every list that creates a merchant carries 0009.
  '0009_pay_submerchant_tree.sql',
  '0014_pay_merchant_payout_destinations.sql',
  '0090_pay_payout_destination_verified.sql',
  '0018_pay_founder_controls_admission.sql',
  // Payment and settlement reads select the stored pricing row. The table is empty here.
  '0050_pay_control_tiers.sql',
  '0051_pay_control_pricing.sql',
  // createMerchant writes the name columns, so every list that creates a merchant carries 0071.
  '0071_pay_merchant_names.sql',
  // decideKyb reads the identity columns to bind the approval hash.
  '0082_pay_merchant_business_profile.sql',
  '0073_pay_settlement_read.sql',
  // dispute.opened records a rail due date. Evidence metadata is the parent of the byte table.
  '0065_pay_merchant_dispute_responses.sql',
  '0083_pay_dispute_deadlines_evidence.sql',
  // createPaymentLink stores checkout_token and the create idempotency journal.
  '0087_pay_payment_link_checkout.sql',
  // createPaymentLink writes the confirmation columns. Null when the caller omitted them.
  '0132_pay_payment_link_share.sql',
  // createPaymentLink writes price_id, which names a catalogue price. Null when the link has none.
  '20261024121606_pay_catalog_products.sql',
  '20261024132500_pay_catalog_prices.sql',
  '20261024210512_pay_payment_link_price.sql',
  '0089_pay_payout_dispatched_outcome.sql',
  // createPayment and openCheckoutSession read the business's category (RC-merchant-08). Empty here: nothing refused.
  '20261024084448_pay_business_categories.sql',
  // openCheckoutSession reads the business's payment methods (M-adv-payments-core-11). Empty here: the default offer.
  '20261024233504_pay_checkout_methods.sql',
].map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const SECRET = 'svc-pay-test-secret-at-least-32-characters';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

/** Test-only operator-declared fractions — never baked into REFERENCE profiles. */
function withDeclaredRates(profiles: readonly RailRoutingProfile[], rates: Readonly<Record<string, string>>): RailRoutingProfile[] {
  return profiles.map((p) => {
    const successRate = rates[p.railId];
    return successRate === undefined ? { ...p } : { ...p, successRate };
  });
}

const TEST_CHECKOUT_PROFILES = withDeclaredRates(REFERENCE_RAIL_ROUTING_PROFILES, {
  'crypto-native': '0.90',
  'card-sandbox': '0.88',
});

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
      `H8a: svc-pay money is PG-hard (no skip-green). ` + `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay money (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

/**
 * 30 s per test, not vitest's 5 s default. Measured locally, idle Postgres,
 * five runs of "keeps the books closed and reconciled after a long mixed run":
 * the test body was 87 to 236 ms and the file was 1.6 to 2.7 s, and every run
 * closed the book (asset net zero, replay agrees, chain intact). On CI the
 * pay package runs about 145 files against one Postgres. The metrics suite
 * on that runner took 45 to 106 s for a file that is 3 s on a laptop, and its
 * seeded tests alone sat at 2.3 to 6.2 s, so a 5 s limit failed about one run
 * in five on speed (PR 4786). Run 38834356222 reported this mixed run red
 * on a frontend-only pull request.
 *
 * vitest does not cancel a test body that has timed out. The body keeps
 * posting while the next test's beforeEach TRUNCATE takes ACCESS EXCLUSIVE
 * on the pay tables, and the two deadlock. A timeout generous enough not to
 * trip keeps that from starting.
 */
describe('svc-pay money PG-hard', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let card: CardSandboxAdapter;
  let crypto: CryptoNativeAdapter;
  let rails: RailRegistry;
  let pay: PayService;
  let dests: ReturnType<typeof memoryPayoutDestinations>;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    crypto = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    rails = new RailRegistry([card, crypto, new BankPayoutAbsentAdapter()]);
    dests = memoryPayoutDestinations();
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      payoutDestinations: dests,
      routingProfiles: TEST_CHECKOUT_PROFILES,
      // Owner-explicit 30 / 365 / 900 / 25 — never the old constructor invention.
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    restorePayoutShim = installPayoutDestinationShim(sql);
  }, 30_000);

  let restorePayoutShim: (() => void) | undefined;
  afterEach(() => {
    restorePayoutShim?.();
    restorePayoutShim = undefined;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── helpers ───────────────────────────────────────────────────────────────

  async function merchant(feeBps = 250, userId = MERCHANT_USER) {
    return pay.createMerchant({ userId, pricing: { feeBps } });
  }

  async function beginMerchantCutoff(merchantId: string, cutoff: 'rejected' | 'suspended') {
    let announceLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => (announceLocked = resolve));
    const mayCommit = new Promise<void>((resolve) => (release = resolve));
    const done = sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE`;
      if (cutoff === 'rejected') {
        await tx`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${merchantId}`;
      } else {
        await tx`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantId}`;
      }
      announceLocked();
      await mayCommit;
    });
    await locked;
    return {
      async commit() {
        release();
        await done;
      },
    };
  }

  async function expectEligibilityReadWaiting(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await sql<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%FROM pay.merchants%FOR SHARE%'
      `;
      if ((row?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('money door never waited on the concurrent merchant cutoff lock');
  }

  /** A card payment, authorized and ready to capture. */
  async function cardPayment(merchantId: string, amount = '100', assetId = 'USDT'): Promise<PaymentView> {
    const payment = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    return pay.authorize(payment.id);
  }

  /** A crypto payment with the payer's transfer already confirmed on chain. */
  async function cryptoPayment(merchantId: string, amount = '100', assetId = 'USDT'): Promise<PaymentView> {
    const payment = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId,
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    const address = await chain.acceptanceAddress(payment.id, assetId);
    chain.credit({ address, assetId, amount: amt(amount), from: '0xbuyer', confirmations: 12 });
    return pay.authorize(payment.id);
  }

  /** A pre-cutover settlement post: net debits the owner's userAvailable. Fee is zero. */
  async function postLegacySettlement(merchantId: string, window: string, gross: string, assetId = 'USDT') {
    await ledger.post({
      idempotencyKey: `settlement:${merchantId}:${window}:${assetId}`,
      module: 'pay',
      reason: 'pay.settled',
      meta: { merchantId, window, assetId },
      entries: [
        { account: merchantClearing(merchantId, assetId), direction: 'credit', amount: amt(gross) },
        { account: userAvailable(MERCHANT_USER, assetId), direction: 'debit', amount: amt(gross) },
      ],
    });
  }

  /** Settle with wide explicit bounds so the test never straddles UTC midnight. */
  async function settle(merchantId: string, window: string, assetId = 'USDT') {
    return pay.settleWindow({
      merchantId,
      window,
      assetId,
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
  }

  const availableOf = async (userId: string, assetId = 'USDT') =>
    formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const proceedsOf = async (merchantId: string, assetId = 'USDT') =>
    formatAmount((await ledger.balance(merchantProceeds(merchantId, assetId))).amount);
  const proceedsHeldOf = async (merchantId: string, assetId = 'USDT') => {
    const all = await ledger.balances('module', `pay:proceeds:${merchantId}`);
    return formatAmount(
      all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n),
    );
  };
  const clearingOf = async (merchantId: string, assetId = 'USDT') =>
    formatAmount((await ledger.balance(merchantClearing(merchantId, assetId))).amount);
  /**
   * Everything held for a user in an asset, across every purpose (P0-3).
   *
   * Stronger than the single-account read it replaces: "nothing is held" now
   * means no hold under ANY purpose, rather than none under one chosen key.
   */
  const heldTotalOf = async (userId: string, assetId = 'USDT') => {
    const all = await ledger.balances('user', userId);
    return formatAmount(
      all.filter((b) => b.account.kind === 'hold' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n),
    );
  };
  const feesOf = async (assetId = 'USDT') => formatAmount((await ledger.balance(houseFees('pay', assetId))).amount);
  const boundaryOf = async (rail: string, assetId = 'USDT') => formatAmount((await ledger.balance(railBoundary(rail, assetId))).amount);

  const events = async (paymentId: string) => (await pay.history(paymentId, 50)).map((e) => e.event);

  function signed(rail: 'card-sandbox' | 'crypto-native', payload: Record<string, unknown>, at = new Date()) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(at.getTime() / 1000).toString();
    const prefix = rail === 'card-sandbox' ? 'x-sandbox' : 'x-chain';
    return {
      headers: { [`${prefix}-signature`]: signPayload(SECRET, timestamp, body), [`${prefix}-timestamp`]: timestamp },
      body,
    };
  }

  // ── The lifecycle, on both v1 adapters ────────────────────────────────────

  describe('lifecycle — card-sandbox', () => {
    it('runs created → authorized → captured → settled, and the merchant can spend it', async () => {
      const m = await merchant(250);
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      expect(payment.status).toBe('created');
      // Nothing has moved. A created payment is a statement of intent.
      expect(await clearingOf(m.id)).toBe('0');

      const authorized = await pay.authorize(payment.id);
      expect(authorized.status).toBe('authorized');
      expect(authorized.railRef).toBe(`ch_${payment.id}`);
      // Still nothing: an authorization is a promise, not a movement.
      expect(await clearingOf(m.id)).toBe('0');

      const captured = await pay.capture(payment.id);
      expect(captured.status).toBe('captured');
      expect(formatAmount(captured.capturedAmount)).toBe('100');
      // Value is in the book now, waiting in clearing — not yet the merchant's
      // to spend, which is exactly what "captured but not settled" means.
      expect(await clearingOf(m.id)).toBe('100');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await boundaryOf('card-sandbox')).toBe('-100');

      const settlement = await settle(m.id, '2026-07-27');
      expect(settlement.status).toBe('posted');
      expect(formatAmount(settlement.gross)).toBe('100');
      expect(formatAmount(settlement.fees)).toBe('2.5');
      expect(formatAmount(settlement.net)).toBe('97.5');

      // Settled net is this merchant's proceeds, not the owner's trading balance.
      expect(await proceedsOf(m.id)).toBe('97.5');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await clearingOf(m.id)).toBe('0');
      expect(await feesOf()).toBe('2.5');

      expect((await pay.getPayment(payment.id)).status).toBe('settled');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a capture retried on a disputed payment returns it as it is: still disputed, nothing captured again', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '12');
      await pay.capture(payment.id);
      await pay.markDisputed(payment.id, { disputeId: 'dp-capture-retry' });
      const clearing = await clearingOf(m.id);
      const boundary = await boundaryOf('card-sandbox');
      const history = await events(payment.id);

      const again = await pay.capture(payment.id);

      expect(again.status).toBe('disputed');
      expect(formatAmount(again.capturedAmount)).toBe('12');
      expect(await events(payment.id)).toEqual(history);
      expect(await clearingOf(m.id)).toBe(clearing);
      expect(await boundaryOf('card-sandbox')).toBe(boundary);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a capture that finds the payment disputed inside its transaction books nothing and appends nothing', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '12');
      // The capture read `authorized` before admission; a concurrent capture and a dispute land before its transaction reads again.
      const racing = new PayService(sql, ledger, rails, {
        guards: {
          ...NOOP_GUARDS,
          beforePaymentAdmit: async (ctx) => {
            if (ctx.kind === 'payment.capture') await ctx.tx`UPDATE pay.payments SET status = 'disputed' WHERE id = ${ctx.paymentId}`;
          },
        },
      });
      const clearing = await clearingOf(m.id);
      const boundary = await boundaryOf('card-sandbox');

      const result = await racing.capture(payment.id);

      expect(result.status).toBe('disputed');
      expect((await events(payment.id)).filter((e) => e === 'captured')).toHaveLength(0);
      expect(await clearingOf(m.id)).toBe(clearing);
      expect(await boundaryOf('card-sandbox')).toBe(boundary);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses to capture a payment that was never authorized', async () => {
      const m = await merchant();
      const created = await pay.createPayment({
        merchantId: m.id,
        amount: amt('12'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });

      await expect(pay.capture(created.id)).rejects.toMatchObject({ code: 'pay.invalid_transition' });
      expect((await pay.getPayment(created.id)).status).toBe('created');
    });

    it('appends every transition and overwrites nothing', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id);
      await pay.capture(payment.id);
      await settle(m.id, 'w-history');

      expect(await events(payment.id)).toEqual([
        'created',
        'rail.authorize',
        'authorized',
        'rail.capture',
        'captured',
        'settlement.included',
        'settled',
      ]);
    });
  });

  describe('lifecycle — crypto-native', () => {
    it('runs the same flow on a real on-chain rail', async () => {
      const m = await merchant(100);
      const payment = await cryptoPayment(m.id, '2.5', 'USDT');

      expect(payment.status).toBe('authorized');
      expect(payment.railRef).toContain('addr_usdt_');

      await pay.capture(payment.id);
      expect(await clearingOf(m.id)).toBe('2.5');
      expect(await boundaryOf('crypto-native')).toBe('-2.5');

      const settlement = await settle(m.id, '2026-07-27');
      expect(formatAmount(settlement.net)).toBe('2.475');
      expect(await proceedsOf(m.id)).toBe('2.475');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('stays in `created` while the transfer is not yet final, and moves nothing', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      });
      const address = await chain.acceptanceAddress(payment.id, 'USDT');
      chain.credit({ address, assetId: 'USDT', amount: amt('100'), confirmations: 1 });

      const pending = await pay.authorize(payment.id);
      expect(pending.status).toBe('created');
      expect(pending.railRef).toBe(address);
      expect(await events(payment.id)).toContain('rail.pending');
      expect(ledger.journal()).toHaveLength(0);

      // Deep enough now — the same call authorizes.
      chain.setConfirmations(address, 12);
      expect((await pay.authorize(payment.id)).status).toBe('authorized');
    });

    it('books an on-chain overpayment at what actually arrived', async () => {
      const m = await merchant(0);
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      });
      const address = await chain.acceptanceAddress(payment.id, 'USDT');
      chain.credit({ address, assetId: 'USDT', amount: amt('150'), confirmations: 12 });

      const authorized = await pay.authorize(payment.id);
      expect(formatAmount(authorized.amount)).toBe('150');

      await pay.capture(payment.id);
      // Booking 100 would leave 50 at an address nothing points at.
      expect(await clearingOf(m.id)).toBe('150');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });
  });

  // ── Refunds ───────────────────────────────────────────────────────────────

  describe('refunds', () => {
    it('refunds in full before settlement, out of clearing', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      const refunded = await pay.refund(payment.id, amt('100'));

      expect(refunded.status).toBe('refunded');
      expect(formatAmount(refunded.refundedAmount)).toBe('100');
      // The merchant was never paid, so nothing comes out of their balance.
      expect(await clearingOf(m.id)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await boundaryOf('card-sandbox')).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refunds in part, leaves the payment settleable, and settles only the remainder', async () => {
      const m = await merchant(1000); // 10%
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      const partial = await pay.refund(payment.id, amt('40'));
      expect(partial.status).toBe('captured');
      expect(formatAmount(partial.refundedAmount)).toBe('40');
      expect(await clearingOf(m.id)).toBe('60');

      const settlement = await settle(m.id, 'w-partial');
      expect(formatAmount(settlement.gross)).toBe('60');
      expect(formatAmount(settlement.fees)).toBe('6');
      expect(await proceedsOf(m.id)).toBe('54');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refunds several times until the captured amount is exhausted', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      await pay.refund(payment.id, amt('25'));
      await pay.refund(payment.id, amt('25'));
      const last = await pay.refund(payment.id, amt('50'));

      expect(last.status).toBe('refunded');
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('REFUSES A REFUND EXCEEDING WHAT WAS CAPTURED, and moves nothing', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      await expect(pay.refund(payment.id, amt('100.000000000000000001'))).rejects.toMatchObject({
        code: 'pay.refund_exceeds_captured',
      });

      expect(await clearingOf(m.id)).toBe('100');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses to over-refund across several partial refunds', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      await pay.refund(payment.id, amt('70'));
      await expect(pay.refund(payment.id, amt('31'))).rejects.toMatchObject({ code: 'pay.refund_exceeds_captured' });
      expect(await clearingOf(m.id)).toBe('30');
    });

    it('refuses when nothing is captured — nothing posted', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      const journalBefore = ledger.journal().map((tx) => tx.idempotencyKey);

      await expect(pay.refund(payment.id, amt('10'))).rejects.toMatchObject({ code: 'pay.nothing_captured' });

      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(formatAmount((await pay.getPayment(payment.id)).refundedAmount)).toBe('0');
    });

    it('refunds a captured payment through ledger-client', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      const refunded = await pay.refund(payment.id, amt('40'));

      expect(formatAmount(refunded.refundedAmount)).toBe('40');
      expect(refunded.status).toBe('captured');
      expect(ledger.journal().some((tx) => tx.idempotencyKey.startsWith(`payment.refund:${payment.id}:`))).toBe(true);
      expect(await clearingOf(m.id)).toBe('60');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('draws a post-settlement refund on the merchant, not on the clearing account', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await settle(m.id, 'w-post');
      expect(await proceedsOf(m.id)).toBe('100');

      await pay.refund(payment.id, amt('40'));

      expect(await proceedsOf(m.id)).toBe('60');
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('fails a post-settlement refund the merchant cannot cover, rather than inventing the money', async () => {
      const m = await merchant(1000); // 10% — the merchant nets 90 of 100
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await settle(m.id, 'w-short');
      expect(await proceedsOf(m.id)).toBe('90');

      // The fee is not returned on a refund, so the merchant is 10 short. The
      // ledger refuses, and the refund does not happen at the rail either —
      // which is the entire reason the ledger moves first.
      await expect(pay.refund(payment.id, amt('100'))).rejects.toThrow();

      expect(await proceedsOf(m.id)).toBe('90');
      expect(await feesOf()).toBe('10');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('reverses the ledger when the rail refuses the refund, leaving the merchant whole', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      expect(await clearingOf(m.id)).toBe('100');

      card.failNext('acquirer.unavailable', 'Simulated acquirer failure');
      await expect(pay.refund(payment.id, amt('60'))).rejects.toMatchObject({ code: 'pay.rail_failed' });

      // Debited, then put back. Both postings are in the journal — a ledger
      // reverses, it does not amend.
      expect(await clearingOf(m.id)).toBe('100');
      expect(await boundaryOf('card-sandbox')).toBe('-100');
      expect(await events(payment.id)).toContain('refund.reversed');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });

      // And the merchant can still be refunded afterwards.
      const retry = await pay.refund(payment.id, amt('60'));
      expect(formatAmount(retry.refundedAmount)).toBe('60');
      expect(await clearingOf(m.id)).toBe('40');
    });

    /**
     * Cross-payment residual — explicit refundId used to be a GLOBAL ledger key
     * (`payment.refund:<refundId>`). Payment B reusing A's id would no-op the
     * book while the rail still paid B. Keys are now namespaced by paymentId.
     */
    it('two payments may share an explicit refundId — both debit the merchant', async () => {
      const m = await merchant(0);
      const a = await cardPayment(m.id, '100');
      const b = await cardPayment(m.id, '100');
      await pay.capture(a.id);
      await pay.capture(b.id);
      expect(await clearingOf(m.id)).toBe('200');

      await pay.refund(a.id, amt('10'), { refundId: 'shared-biz-rf' });
      await pay.refund(b.id, amt('10'), { refundId: 'shared-biz-rf' });

      expect(await clearingOf(m.id)).toBe('180');
      expect(formatAmount((await pay.getPayment(a.id)).refundedAmount)).toBe('10');
      expect(formatAmount((await pay.getPayment(b.id)).refundedAmount)).toBe('10');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * W8 residual — same explicit refundId after reverse must NOT free-rail.
     * Ledger key `payment.refund:<paymentId>:<id>` is spent (idempotent no-op on re-post);
     * card-sandbox ignores refundId and would still advance the charge.
     * Refuse so a public body refundId / derived rest key cannot desync book vs rail.
     */
    it('refuses the same explicit refundId after reverse (no free rail refund)', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      card.failNext('acquirer.unavailable', 'Simulated acquirer failure');
      await expect(pay.refund(payment.id, amt('60'), { refundId: 'biz-refund-1' })).rejects.toMatchObject({
        code: 'pay.rail_failed',
      });
      expect(await clearingOf(m.id)).toBe('100');
      expect(await events(payment.id)).toContain('refund.reversed');

      await expect(pay.refund(payment.id, amt('60'), { refundId: 'biz-refund-1' })).rejects.toMatchObject({
        code: 'pay.refund_id_spent',
      });
      // Nothing moved a second time; no refunded event under that id.
      expect(await clearingOf(m.id)).toBe('100');
      expect(formatAmount((await pay.getPayment(payment.id)).refundedAmount)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });

      // A NEW business key is a genuine re-attempt and still works.
      const ok = await pay.refund(payment.id, amt('60'), { refundId: 'biz-refund-2' });
      expect(formatAmount(ok.refundedAmount)).toBe('60');
      expect(await clearingOf(m.id)).toBe('40');
    });

    /**
     * W9 residual — completed refundId is bound to its amount.
     * Same id + different amount must not silent-200 with the old refund.
     */
    it('refuses the same refundId with a different amount (no silent replay)', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      await pay.refund(payment.id, amt('10'), { refundId: 'amt-bind-1' });
      expect(await clearingOf(m.id)).toBe('90');

      await expect(pay.refund(payment.id, amt('50'), { refundId: 'amt-bind-1' })).rejects.toMatchObject({
        code: 'pay.refund_id_conflict',
      });
      // Money still the single first refund; projection still 10.
      expect(await clearingOf(m.id)).toBe('90');
      expect(formatAmount((await pay.getPayment(payment.id)).refundedAmount)).toBe('10');
      expect(ledger.reconcile()).toEqual({ ok: true });

      // Same amount is a true replay.
      const replay = await pay.refund(payment.id, amt('10'), { refundId: 'amt-bind-1' });
      expect(formatAmount(replay.refundedAmount)).toBe('10');
      expect(await clearingOf(m.id)).toBe('90');
    });

    it('sends an on-chain refund back to the address that paid', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '5');
      await pay.capture(payment.id);

      await pay.refund(payment.id, amt('2'));

      const outbound = chain.outboundTransfers();
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toMatchObject({ to: '0xbuyer' });
      expect(formatAmount(outbound[0]!.amount)).toBe('2');
      expect(await clearingOf(m.id)).toBe('3');
    });

    /**
     * THE LOST ACKNOWLEDGEMENT. The ledger books a refund, the reply never reaches pay, pay's transaction rolls back (no
     * `refund.posted`), the payment then settles, and the merchant retries the SAME refundId. `source` is recomputed from
     * the live status (clearing -> settled) but the ledger key does not contain it, so the ledger answers with the ORIGINAL
     * booking (detect mode) or refuses the key (refuse mode). Every retry would fail, and a new refundId would debit twice.
     */
    describe.each(['detect', 'refuse'] as const)('a refund booked but never acknowledged (ledger conflict mode: %s)', (mode) => {
      const REFUND_ID = 'r-lost-reply';

      /** Over the in-process ledger, or the real HTTP client against the fake door (every attempt of the first post is lost). */
      const transports = {
        memory: (book: MemoryLedger, gate: { lose: boolean }): LedgerClient => ({
          post: async (request: PostRequest) => {
            const tx = await book.post(request);
            if (gate.lose && request.reason === 'payment.refunded') {
              gate.lose = false;
              throw new Error('simulated lost acknowledgement');
            }
            return tx;
          },
          balance: (ref) => book.balance(ref),
          balances: (ownerType, ownerId) => book.balances(ownerType, ownerId),
          getTx: (txId) => book.getTx(txId),
          getTxByKey: (key) => book.getTxByKey(key),
        }),
        http: (book: MemoryLedger, gate: { lose: boolean }): LedgerClient => {
          const door = fakeLedgerDoor(book, SECRET);
          let lost = 0;
          globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const isRefundPost =
              new URL(String(input)).pathname === '/trpc/post' && JSON.parse(String(init?.body ?? '{}')).reason === 'payment.refunded';
            if (gate.lose && isRefundPost) {
              lost += 1;
              // The first attempt reaches the ledger and books; all three attempts then fail, so the client gives up.
              if (lost === 1) await door(input, init);
              if (lost === 3) gate.lose = false;
              throw new TypeError('fetch failed');
            }
            return door(input, init);
          }) as typeof fetch;
          return createLedgerClient('http://ledger.test', SECRET);
        },
      };

      for (const [name, build] of Object.entries(transports)) {
        describe(name, () => {
          const realFetch = globalThis.fetch;
          afterEach(() => {
            globalThis.fetch = realFetch;
          });

          async function lostRefund() {
            const book = new MemoryLedger({ idempotencyConflict: mode });
            const gate = { lose: true };
            const svc = new PayService(sql, build(book, gate), rails);
            const m = await svc.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
            const capture = async () => {
              const created = await svc.createPayment({
                merchantId: m.id,
                amount: amt('100'),
                assetId: 'USDT',
                method: 'card',
                railAdapter: 'card-sandbox',
                instrument: { kind: 'card', token: 'tok_ok' },
              });
              await svc.authorize(created.id);
              await svc.capture(created.id);
              return created;
            };
            const p1 = await capture();
            await capture();

            await expect(svc.refund(p1.id, amt('40'), { refundId: REFUND_ID })).rejects.toThrow();
            const key = `payment.refund:${p1.id}:${REFUND_ID}`;
            const refundTxs = () => book.journal().filter((tx) => tx.idempotencyKey === key);
            expect(refundTxs()).toHaveLength(1);
            expect((await svc.history(p1.id, 50)).some((e) => e.event === 'refund.posted')).toBe(false);
            return { book, svc, m, p1, refundTxs };
          }

          it('recovers with the ORIGINAL source after the payment settles, booking exactly one refund', async () => {
            const { book, svc, m, p1, refundTxs } = await lostRefund();
            // Another capture refills clearing so the window can settle what the database says was captured.
            await book.post(
              recipes.paymentCapture({
                paymentId: 'p-topup',
                merchantId: m.id,
                assetId: 'USDT',
                amount: amt('40'),
                rail: 'card-sandbox',
                railRef: 'ch_topup',
              }),
            );
            await svc.settleWindow({
              merchantId: m.id,
              window: 'w-lost-reply',
              assetId: 'USDT',
              from: new Date(Date.now() - 24 * 3600_000),
              to: new Date(Date.now() + 24 * 3600_000),
            });
            expect((await svc.getPayment(p1.id)).status).toBe('settled');

            const view = await svc.refund(p1.id, amt('40'), { refundId: REFUND_ID });

            expect(formatAmount(view.refundedAmount)).toBe('40');
            expect(refundTxs()).toHaveLength(1);
            const events = await svc.history(p1.id, 50);
            expect(events.find((e) => e.event === 'refund.posted')?.payload).toMatchObject({ refundId: REFUND_ID, source: 'clearing' });
            expect(events.find((e) => e.event === 'refunded')?.payload).toMatchObject({ refundId: REFUND_ID, source: 'clearing' });
            expect(book.reconcile()).toEqual({ ok: true });
          });

          it('refuses the same refundId for a different amount as pay.refund_id_conflict, with no second booking', async () => {
            const { book, svc, p1, refundTxs } = await lostRefund();

            await expect(svc.refund(p1.id, amt('41'), { refundId: REFUND_ID })).rejects.toMatchObject({ code: 'pay.refund_id_conflict' });

            expect(refundTxs()).toHaveLength(1);
            expect((await svc.history(p1.id, 50)).some((e) => e.event === 'refund.posted')).toBe(false);
            // The honest retry (same amount) still completes, exactly once.
            const view = await svc.refund(p1.id, amt('40'), { refundId: REFUND_ID });
            expect(formatAmount(view.refundedAmount)).toBe('40');
            expect(refundTxs()).toHaveLength(1);
            expect(book.reconcile()).toEqual({ ok: true });
          });
        });
      }
    });
  });

  it('a pre-cutover settled refund draws on userAvailable, and a lost reply recovers that booking', async () => {
    const realPost = ledger.post.bind(ledger);
    const gate = { lose: true };
    ledger.post = async (request) => {
      const tx = await realPost(request);
      if (gate.lose && request.reason === 'payment.refunded') {
        gate.lose = false;
        throw new Error('simulated lost acknowledgement');
      }
      return tx;
    };
    try {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, 'w-legacy-refund', '40');
      await settle(m.id, 'w-legacy-refund');
      expect(await availableOf(MERCHANT_USER)).toBe('40');
      expect(await proceedsOf(m.id)).toBe('0');
      card.failNext('acquirer.unavailable', 'Simulated acquirer failure');
      await expect(pay.refund(payment.id, amt('15'), { refundId: 'legacy-lost' })).rejects.toThrow(/lost acknowledgement/);
      await expect(pay.refund(payment.id, amt('15'), { refundId: 'legacy-lost' })).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(await availableOf(MERCHANT_USER)).toBe('40');
      expect(await proceedsOf(m.id)).toBe('0');
      const personalId = (await ledger.balance(userAvailable(MERCHANT_USER, 'USDT'))).accountId;
      const refunds = ledger.journal().filter((tx) => tx.reason === 'payment.refunded');
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.entries.find((entry) => entry.direction === 'credit')?.accountId).toBe(personalId);
      const reversed = ledger.journal().filter((tx) => tx.reason === 'payment.refund.reversed');
      expect(reversed).toHaveLength(1);
      expect(reversed[0]!.entries.find((entry) => entry.direction === 'debit')?.accountId).toBe(personalId);
      expect(ledger.reconcile()).toEqual({ ok: true });
    } finally {
      ledger.post = realPost;
    }
  });

  // ── Capture rules ─────────────────────────────────────────────────────────

  describe('chargeback opening replay', () => {
    const open = (m: { id: string }, paymentId: string, disputeId: string, amount: string) =>
      pay.openChargeback({ disputeId, paymentId, merchantId: m.id, amount, assetId: 'USDT' });

    it('replays a legacy stored chargeback plan from userAvailable without a second booking', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '80');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, 'w-legacy-cb', '80');
      await settle(m.id, 'w-legacy-cb');
      const disputeId = 'dp-legacy-replay';
      const booked = await ledger.post(
        recipes.chargebackOpen({
          disputeId,
          paymentId: payment.id,
          merchantId: m.id,
          merchantUserId: MERCHANT_USER,
          assetId: 'USDT',
          rail: 'card-sandbox',
          fromClearing: amt('0'),
          fromMerchantBalance: amt('30'),
          settledPot: 'user',
        }),
      );
      await sql`
        INSERT INTO pay.payment_events (payment_id, event, payload)
        VALUES (
          ${payment.id},
          'chargeback.opening_planned',
          ${sql.json({ disputeId, amount: '30', fromClearing: '0', fromMerchantBalance: '30' } as never)}
        )
      `;
      const replayed = await pay.openChargeback({
        disputeId,
        paymentId: payment.id,
        merchantId: m.id,
        amount: '30',
        assetId: 'USDT',
      });
      expect(replayed.txId).toBe(booked.id);
      expect(await availableOf(MERCHANT_USER)).toBe('50');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('replays a legacy stored plan after the payment is marked disputed, on the same pot', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '80');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, 'w-legacy-cb-disputed', '80');
      await settle(m.id, 'w-legacy-cb-disputed');
      const disputeId = 'dp-legacy-marked';
      const personal = userAvailable(MERCHANT_USER, 'USDT');
      const booked = await ledger.post(
        recipes.chargebackOpen({
          disputeId,
          paymentId: payment.id,
          merchantId: m.id,
          merchantUserId: MERCHANT_USER,
          assetId: 'USDT',
          rail: 'card-sandbox',
          fromClearing: amt('0'),
          fromMerchantBalance: amt('30'),
          settledPot: 'user',
        }),
      );
      await sql`
        INSERT INTO pay.payment_events (payment_id, event, payload)
        VALUES (
          ${payment.id},
          'chargeback.opening_planned',
          ${sql.json({ disputeId, amount: '30', fromClearing: '0', fromMerchantBalance: '30' } as never)}
        )
      `;
      await pay.markDisputed(payment.id, { disputeId });
      expect((await pay.getPayment(payment.id)).status).toBe('disputed');
      const realPost = ledger.post.bind(ledger);
      const bodies: PostRequest[] = [];
      ledger.post = async (request) => {
        if (request.reason === 'pay.chargeback.opened') bodies.push(request);
        return realPost(request);
      };
      try {
        const replayed = await pay.openChargeback({
          disputeId,
          paymentId: payment.id,
          merchantId: m.id,
          amount: '30',
          assetId: 'USDT',
        });
        expect(replayed.txId).toBe(booked.id);
      } finally {
        ledger.post = realPost;
      }
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.entries.find((entry) => entry.direction === 'credit')?.account).toEqual(personal);
      expect(await availableOf(MERCHANT_USER)).toBe('50');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('replays the stored split after the first opening has moved the balances it was computed from', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      expect(await clearingOf(m.id)).toBe('100');

      const first = await open(m, payment.id, 'dp-replay-1', '100');
      expect(await clearingOf(m.id)).toBe('0');

      // The delivery marker was never written (crash), so the rail redelivers. Clearing is now 0 and the merchant holds
      // nothing: re-splitting from live balances would read "uncovered". The frozen plan posts the same recipe again.
      const second = await open(m, payment.id, 'dp-replay-1', '100');
      expect(second.txId).toBe(first.txId);
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect((await events(payment.id)).filter((e) => e === 'chargeback.opening_planned')).toHaveLength(1);
    });

    it('refuses a redelivery that names a different amount than the dispute already planned', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await open(m, payment.id, 'dp-replay-2', '60');
      await expect(open(m, payment.id, 'dp-replay-2', '100')).rejects.toMatchObject({ code: 'pay.chargeback_plan_conflict' });
      expect(await clearingOf(m.id)).toBe('40');
    });

    it('plans once when two deliveries race', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const [a, b] = await Promise.all([open(m, payment.id, 'dp-replay-3', '100'), open(m, payment.id, 'dp-replay-3', '100')]);
      expect(a.txId).toBe(b.txId);
      expect((await events(payment.id)).filter((e) => e === 'chargeback.opening_planned')).toHaveLength(1);
      expect(await clearingOf(m.id)).toBe('0');
    });

    it('replays the booked opening when the other delivery has already posted before this one reads the pots', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const args = { disputeId: 'dp-replay-posted', paymentId: payment.id, merchantId: m.id, amount: '100', assetId: 'USDT' };
      const realBalance = ledger.balance.bind(ledger);
      let nested = false;
      let booked: { txId: string } | undefined;
      // The first clearing read is the pot split, which happens after the unlocked plan read.
      // Finish the other delivery there: it stores the plan and posts, so this read sees an empty clearing.
      ledger.balance = async (ref) => {
        if (!nested && ref.ownerType === 'module' && ref.ownerId.startsWith('pay:clearing:')) {
          nested = true;
          booked = await pay.openChargeback(args);
        }
        return realBalance(ref);
      };
      try {
        const outer = await pay.openChargeback(args);
        expect(booked?.txId).toBeTruthy();
        expect(outer.txId).toBe(booked!.txId);
      } finally {
        ledger.balance = realBalance;
      }
      expect((await events(payment.id)).filter((e) => e === 'chargeback.opening_planned')).toHaveLength(1);
      expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses an unfunded shortfall before planning, and plans nothing', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await expect(open(m, payment.id, 'dp-replay-4', '500')).rejects.toMatchObject({ code: 'pay.chargeback_shortfall_unfunded' });
      expect((await events(payment.id)).filter((e) => e === 'chargeback.opening_planned')).toHaveLength(0);
    });

    const count = async (paymentId: string, event: string) => (await events(paymentId)).filter((e) => e === event).length;

    /**
     * A PayService over the same book whose chargeback-open post misbehaves once, in the way the test asks:
     * `insufficient` refuses for funds, `down` fails like a 5xx with nothing booked, `lost-reply` books it and loses the reply,
     * `after-post` books it and then runs `during` (a concurrent writer landing between the ledger commit and the caller).
     * `during` also runs before an `insufficient` refusal, so a test can let another delivery book the same plan meanwhile.
     */
    function flakyPay(
      mode: 'insufficient' | 'down' | 'lost-reply' | 'after-post',
      during?: () => Promise<void>,
      opts: { productionLookup?: boolean } = {},
    ) {
      let armed = true;
      const flaky = new Proxy(ledger, {
        get(target, prop, receiver) {
          // A settlement key is answered: the pot is decided from that post. Any other key throws.
          // Opening and reverse lookups propagate that as pay.chargeback_ledger_failed.
          // voidChargebackPlan still swallows its own lookup.
          if (prop === 'getTxByKey' && opts.productionLookup) {
            const read = target.getTxByKey.bind(target);
            return async (key: string) => {
              if (key.startsWith('settlement:')) return read(key);
              throw new Error('getTxByKey is not exposed over the internal ledger API — query svc-ledger directly');
            };
          }
          if (prop !== 'post') {
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          }
          return async (request: Parameters<MemoryLedger['post']>[0]) => {
            if (armed && request.reason === 'pay.chargeback.opened') {
              armed = false;
              if (mode === 'insufficient') {
                await during?.();
                throw new InsufficientFundsError('acct', 'USDT', '100', '0');
              }
              if (mode === 'down') throw new Error('svc-ledger /post failed (503): upstream unavailable');
              const posted = await target.post(request); // committed
              if (mode === 'after-post') {
                await during?.();
                return posted;
              }
              throw new Error('svc-ledger /post failed (503): upstream timeout'); // lost reply
            }
            return target.post(request);
          };
        },
      });
      return new PayService(sql, flaky, rails, {
        checkoutRiskBand: 'low',
        payoutDestinations: dests,
        routingProfiles: TEST_CHECKOUT_PROFILES,
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      });
    }

    const openedTxs = () => ledger.journal().filter((t) => t.reason === 'pay.chargeback.opened');
    const disputeWebhook = (payment: PaymentView, disputeId: string, id: string) =>
      signed('card-sandbox', {
        id,
        type: 'dispute.opened',
        ref: payment.railRef,
        amount: '100',
        assetId: 'USDT',
        disputeId,
      });

    it('re-plans from live balances after a post that ran out of funds, instead of replaying a split that can no longer be covered', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('insufficient');
      const openVia = (svc: PayService) =>
        svc.openChargeback({ disputeId: 'dp-void-1', paymentId: payment.id, merchantId: m.id, amount: '100', assetId: 'USDT' });

      // Planned 100-from-clearing, then the post is refused for funds: nothing posted under the key.
      await expect(openVia(flaky)).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(ledger.journal().map((t) => t.reason)).not.toContain('pay.chargeback.opened');

      // Money moves between planning and posting: settlement drains clearing into the merchant's available balance.
      await settle(m.id, 'w-void-1');
      expect(await clearingOf(m.id)).toBe('0');

      // The redelivery does not throw forever on the stale plan; it re-plans (100 now comes from available) and books.
      const posted = await openVia(flaky);
      expect(posted.txId).toBeTruthy();
      expect(ledger.journal().filter((t) => t.reason === 'pay.chargeback.opened')).toHaveLength(1);
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(2);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(1);
      // And now that it is booked, a further redelivery replays the live plan and returns the same transaction.
      expect((await openVia(flaky)).txId).toBe(posted.txId);
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(2);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('turns an insufficient-funds post on the webhook door into the named uncovered refusal, and keeps one planned and one voided event', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('insufficient');
      const disputeId = `dsp-void-wh-${payment.id}`;
      const outcome = await flaky.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', {
          id: 'evt_void_wh',
          type: 'dispute.opened',
          ref: payment.railRef,
          amount: '100',
          assetId: 'USDT',
          disputeId,
        }),
      );
      expect(outcome.applied).toBe(true);
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('refused');
      expect(c?.ledgerRefuse?.code).toBe('pay.chargeback_uncovered');
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(1);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(1);
    });

    it('does NOT void when the outcome is unknown: the post may have committed, so the redelivery replays the same plan', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('lost-reply');
      const openVia = () =>
        flaky.openChargeback({ disputeId: 'dp-void-2', paymentId: payment.id, merchantId: m.id, amount: '100', assetId: 'USDT' });

      await expect(openVia()).rejects.toThrow(/upstream timeout/);
      // The post did commit (clearing is drained); the plan must survive.
      expect(await clearingOf(m.id)).toBe('0');
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(0);

      const replay = await openVia();
      const booked = ledger.journal().filter((t) => t.reason === 'pay.chargeback.opened');
      expect(booked).toHaveLength(1);
      expect(replay.txId).toBe(booked[0]!.id);
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(1);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('webhook: a stored plan that went stale after a 5xx is re-planned from live balances and books, not refused as uncovered', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('down');
      const disputeId = `dsp-stale-${payment.id}`;
      const delivery = disputeWebhook(payment, disputeId, 'evt_stale');

      // First delivery: the plan (100 from clearing) is stored, the post fails with nothing booked, the marker is not written.
      await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toThrow(/upstream unavailable/);
      expect(openedTxs()).toHaveLength(0);
      expect(defaultDisputeCaseStore.get(disputeId)).toBeNull();

      // Settlement moves clearing into the merchant's available balance, which still covers the dispute.
      await settle(m.id, 'w-stale');
      expect(await clearingOf(m.id)).toBe('0');

      const outcome = await flaky.handleWebhook('card-sandbox', delivery);
      expect(outcome.applied).toBe(true);
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('posted');
      expect(c?.ledgerTxId).toBe(openedTxs()[0]!.id);
      expect(openedTxs()).toHaveLength(1);
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(2);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('webhook: when even the freshly computed plan is short, the redelivery records a refused dispute and posts nothing', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('down');
      const disputeId = `dsp-stale-short-${payment.id}`;
      const delivery = disputeWebhook(payment, disputeId, 'evt_stale_short');

      await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toThrow(/upstream unavailable/);
      const settlement = await settle(m.id, 'w-stale-short');
      // The merchant then withdraws everything: nothing is left anywhere to cover the dispute.
      await ledger.post(
        recipes.merchantProceedsPayoutHold({
          merchantId: m.id,
          assetId: 'USDT',
          amount: settlement.net,
          rail: 'crypto-native',
          withdrawalId: `${settlement.id}:short`,
        }),
      );

      const outcome = await flaky.handleWebhook('card-sandbox', delivery);
      expect(outcome.applied).toBe(true);
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('refused');
      expect(c?.ledgerRefuse?.code).toBe('pay.chargeback_shortfall_unfunded');
      expect((await pay.getPayment(payment.id)).status).toBe('disputed');
      await expect(pay.refund(payment.id, amt('1'))).rejects.toMatchObject({ code: 'pay.nothing_captured' });
      expect(openedTxs()).toHaveLength(0);
      expect(ledger.journal().some((t) => t.reason.includes('shortfall'))).toBe(false);
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(1);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(1);
    });

    it('production client (getTxByKey throws): a stale stored plan is not voided when the lookup fails', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('down', undefined, { productionLookup: true });
      const disputeId = `dsp-prod-stale-${payment.id}`;
      const delivery = disputeWebhook(payment, disputeId, 'evt_prod_stale');

      await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toThrow(/upstream unavailable/);
      await settle(m.id, 'w-prod-stale');

      await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toMatchObject({
        code: 'pay.chargeback_ledger_failed',
      });
      expect(defaultDisputeCaseStore.get(disputeId)).toBeNull();
      expect(openedTxs()).toHaveLength(0);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(0);
    });

    it('production client (getTxByKey throws): a fresh plan that is still short records a refused dispute and posts nothing', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('down');
      const disputeId = `dsp-prod-short-${payment.id}`;
      const delivery = disputeWebhook(payment, disputeId, 'evt_prod_short');

      await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toThrow(/upstream unavailable/);
      const settlement = await settle(m.id, 'w-prod-short');
      await ledger.post(
        recipes.merchantProceedsPayoutHold({
          merchantId: m.id,
          assetId: 'USDT',
          amount: settlement.net,
          rail: 'crypto-native',
          withdrawalId: `${settlement.id}:prod-short`,
        }),
      );

      const outcome = await flaky.handleWebhook('card-sandbox', delivery);
      expect(outcome.applied).toBe(true);
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('refused');
      expect(c?.ledgerRefuse?.code).toBe('pay.chargeback_shortfall_unfunded');
      expect((await pay.getPayment(payment.id)).status).toBe('disputed');
      await expect(pay.refund(payment.id, amt('1'))).rejects.toMatchObject({ code: 'pay.nothing_captured' });
      expect(openedTxs()).toHaveLength(0);
      expect(ledger.journal().some((t) => t.reason.includes('shortfall'))).toBe(false);
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(1);
    });

    it('unfunded-shortfall branch with a throwing lookup does not void the plan and rejects pay.chargeback_ledger_failed', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('down');
      const disputeId = `dsp-lookup-short-${payment.id}`;
      const delivery = disputeWebhook(payment, disputeId, 'evt_lookup_short');

      await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toThrow(/upstream unavailable/);
      const settlement = await settle(m.id, 'w-lookup-short');
      await ledger.post(
        recipes.merchantProceedsPayoutHold({
          merchantId: m.id,
          assetId: 'USDT',
          amount: settlement.net,
          rail: 'crypto-native',
          withdrawalId: `${settlement.id}:lookup-short`,
        }),
      );
      const real = ledger.getTxByKey.bind(ledger);
      ledger.getTxByKey = async (key: string) => {
        if (key.startsWith('pay.chargeback.')) throw new Error('ledger lookup down');
        return real(key);
      };
      try {
        await expect(flaky.handleWebhook('card-sandbox', delivery)).rejects.toMatchObject({
          code: 'pay.chargeback_ledger_failed',
        });
      } finally {
        ledger.getTxByKey = real;
      }
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(0);
      expect(defaultDisputeCaseStore.get(disputeId)).toBeNull();
      expect(openedTxs()).toHaveLength(0);
    });

    it('production client (getTxByKey throws): a funds refusal does not treat the lookup failure as an empty book', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const flaky = flakyPay('insufficient', undefined, { productionLookup: true });
      await expect(
        flaky.openChargeback({ disputeId: 'dp-prod-3', paymentId: payment.id, merchantId: m.id, amount: '100', assetId: 'USDT' }),
      ).rejects.toMatchObject({ code: 'pay.chargeback_ledger_failed' });
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(0);
    });

    it('does not void a plan that another delivery booked while this one was being refused for funds', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const args = { disputeId: 'dp-race-1', paymentId: payment.id, merchantId: m.id, amount: '100', assetId: 'USDT' };
      // Delivery A's post is refused for funds, but delivery B (same plan) books it first.
      const a = flakyPay('insufficient', async () => {
        await pay.openChargeback(args);
      });

      const fromA = await a.openChargeback(args);
      expect(openedTxs()).toHaveLength(1);
      expect(fromA.txId).toBe(openedTxs()[0]!.id);
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(1);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(0);
      expect((await pay.openChargeback(args)).txId).toBe(fromA.txId);
    });

    it('restores the plan when a concurrent void lands between the ledger commit and the caller', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const args = { disputeId: 'dp-race-2', paymentId: payment.id, merchantId: m.id, amount: '100', assetId: 'USDT' };
      // The post commits; before the caller returns, a refused sibling delivery's void is appended.
      const a = flakyPay('after-post', async () => {
        await sql`
          INSERT INTO pay.payment_events (payment_id, event, payload)
          VALUES (${payment.id}, 'chargeback.opening_plan_voided', ${sql.json({ disputeId: 'dp-race-2' } as never)})
        `;
      });

      const posted = await a.openChargeback(args);
      expect(await count(payment.id, 'chargeback.opening_plan_voided')).toBe(1);
      // The booked plan is live again (one restore), so the next delivery replays it instead of re-planning into a conflict.
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(2);
      expect((await pay.openChargeback(args)).txId).toBe(posted.txId);
      expect(await count(payment.id, 'chargeback.opening_planned')).toBe(2);
      expect(openedTxs()).toHaveLength(1);
    });

    it('answers a conflicting redelivery on the webhook door with a named refusal, so the rail stops redelivering', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      const disputeId = `dsp-conflict-${payment.id}`;
      await open(m, payment.id, disputeId, '60');

      const outcome = await pay.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', {
          id: 'evt_conflict',
          type: 'dispute.opened',
          ref: payment.railRef,
          amount: '100',
          assetId: 'USDT',
          disputeId,
        }),
      );
      expect(outcome.applied).toBe(true);
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('refused');
      expect(c?.ledgerRefuse?.code).toBe('pay.chargeback_plan_conflict');
      // The first plan stands and moved the only money there is.
      expect(await clearingOf(m.id)).toBe('40');
      expect(ledger.journal().filter((t) => t.reason === 'pay.chargeback.opened')).toHaveLength(1);
    });
  });

  describe('operator dispute on a legacy settlement', () => {
    const confirm = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const auth = {
      secret: 'a-test-signing-secret-that-is-long-enough',
      issuer: 'intafaced',
      audience: 'intafaced.api',
      accessTtlSeconds: 900,
    };

    async function openDisputeCaller() {
      const money = new UserMoneyService(sql, ledger, rails, { operatorCreditRails: ['card-sandbox'] });
      const router = createPayRouter(pay, rails, money, null, undefined, stubApprovalConsumer(confirm));
      const { token } = await issueAccessToken(
        {
          userId: MERCHANT_USER,
          sessionId: '77777777-7777-4777-8777-777777777777',
          scopes: ['admin:treasury'],
          tier: 'full',
          mfa: true,
        },
        auth,
      );
      const principal = await verifyAccessToken(token, auth);
      return router.createCaller({ principal, service: null, region: 'DE', requestId: 'req-legacy-dispute' });
    }

    async function legacySettled(window: string) {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, window, '40');
      await settle(m.id, window);
      return { m, payment };
    }

    it('marks a legacy-settled payment disputed and books the chargeback on userAvailable', async () => {
      const { m, payment } = await legacySettled('w-legacy-router');
      const api = await openDisputeCaller();
      const disputeId = `dsp-legacy-${payment.id}`;
      const opened = await api.fraud.openDispute({
        disputeId,
        paymentId: payment.id,
        merchantId: m.id,
        amount: '30',
        assetId: 'USDT',
        markPaymentDisputed: true,
        confirmOperatorId: confirm,
        approvalId: 'appr-1',
        operationId: 'op-1',
      });
      expect(opened).toMatchObject({ disputeId, ledgerWire: 'posted', paymentMarkedDisputed: true });
      expect((await pay.getPayment(payment.id)).status).toBe('disputed');
      expect(await availableOf(MERCHANT_USER)).toBe('10');
      expect(await proceedsOf(m.id)).toBe('0');
      const personalId = (await ledger.balance(userAvailable(MERCHANT_USER, 'USDT'))).accountId;
      const openedTx = ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened');
      expect(openedTx).toHaveLength(1);
      expect(openedTx[0]!.entries.find((entry) => entry.direction === 'credit')?.accountId).toBe(personalId);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a retry after PRECONDITION_FAILED posts the same chargeback body', async () => {
      const { m, payment } = await legacySettled('w-legacy-retry');
      const api = await openDisputeCaller();
      const disputeId = `dsp-legacy-retry-${payment.id}`;
      const input = {
        disputeId,
        paymentId: payment.id,
        merchantId: m.id,
        amount: '30',
        assetId: 'USDT',
        markPaymentDisputed: true as const,
        confirmOperatorId: confirm,
        approvalId: 'appr-1',
        operationId: 'op-1',
      };
      const personal = userAvailable(MERCHANT_USER, 'USDT');
      const realPost = ledger.post.bind(ledger);
      const bodies: PostRequest[] = [];
      let refuse = true;
      ledger.post = async (request) => {
        if (request.reason === 'pay.chargeback.opened') {
          bodies.push(request);
          if (refuse) {
            refuse = false;
            throw new InsufficientFundsError('acct', 'USDT', '30', '0');
          }
        }
        return realPost(request);
      };
      try {
        await expect(api.fraud.openDispute(input)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining('pay.chargeback_uncovered'),
        });
        expect(defaultDisputeCaseStore.get(disputeId)).toBeNull();
        const retried = await api.fraud.openDispute(input);
        expect(retried).toMatchObject({ disputeId, ledgerWire: 'posted' });
      } finally {
        ledger.post = realPost;
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0]!.entries.find((entry) => entry.direction === 'credit')?.account).toEqual(personal);
      expect(await availableOf(MERCHANT_USER)).toBe('10');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('capture', () => {
    it('REJECTS A CAPTURE EXCEEDING THE AUTHORIZED AMOUNT, before touching the rail', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      await expect(pay.capture(payment.id, { amount: amt('150') })).rejects.toMatchObject({
        code: 'pay.capture_exceeds_authorized',
      });

      // Nothing booked, and the payment is still capturable for the right amount.
      expect(ledger.journal()).toHaveLength(0);
      expect((await pay.getPayment(payment.id)).status).toBe('authorized');
      expect((await pay.capture(payment.id)).status).toBe('captured');
    });

    it('refuses a partial capture rather than pretending the interface supports one', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await expect(pay.capture(payment.id, { amount: amt('60') })).rejects.toMatchObject({
        code: 'pay.partial_capture_unsupported',
      });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('is idempotent — capturing twice books once', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      await pay.capture(payment.id);
      await pay.capture(payment.id);
      await pay.capture(payment.id);

      expect(await clearingOf(m.id)).toBe('100');
      expect(ledger.journal().filter((t) => t.reason === 'payment.captured')).toHaveLength(1);
    });

    it('refuses to capture a payment that was never authorized', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('10'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
      });
      await expect(pay.capture(payment.id)).rejects.toMatchObject({ code: 'pay.invalid_transition' });
    });

    it('leaves the payment capturable when the rail fails mid-capture', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      card.failNext();
      await expect(pay.capture(payment.id)).rejects.toMatchObject({ code: 'pay.rail_failed' });

      // NOT failed. An authorization whose capture failed is still an
      // authorization, and abandoning it would strand the buyer's held funds.
      expect((await pay.getPayment(payment.id)).status).toBe('authorized');
      expect(ledger.journal()).toHaveLength(0);

      const captured = await pay.capture(payment.id);
      expect(captured.status).toBe('captured');
      expect(await clearingOf(m.id)).toBe('100');
    });
  });

  // ── Declines ──────────────────────────────────────────────────────────────

  describe('declines', () => {
    it('marks a declined authorization failed and moves nothing', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: SANDBOX_DECLINE_TOKEN },
      });

      await expect(pay.authorize(payment.id)).rejects.toMatchObject({ code: 'pay.rail_declined' });

      const after = await pay.getPayment(payment.id);
      expect(after.status).toBe('failed');
      expect(await events(payment.id)).toEqual(['created', 'rail.authorize', 'failed']);
      expect(ledger.journal()).toHaveLength(0);
    });

    it('will not resurrect a failed payment', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: SANDBOX_DECLINE_TOKEN },
      });
      await expect(pay.authorize(payment.id)).rejects.toThrow();
      await expect(pay.authorize(payment.id)).rejects.toMatchObject({ code: 'pay.invalid_transition' });
    });

    it('an adapter health refusal during authorize leaves the payment created', async () => {
      class AuthorizeHealthRefusalCard extends CardSandboxAdapter {
        override async authorize(intent: Parameters<CardSandboxAdapter['authorize']>[0]) {
          return railFailure({
            railRef: `ch_${intent.paymentId}`,
            amount: intent.amount,
            assetId: intent.assetId,
            failureCode: 'rail.health_stale',
            failureReason: 'rail.health_stale',
          });
        }
      }

      const refusalCard = new AuthorizeHealthRefusalCard({ secret: SECRET, toleranceSeconds: 300 });
      expect(refusalCard.health().healthy).toBe(true);
      const local = new PayService(sql, ledger, new RailRegistry([refusalCard, crypto, new BankPayoutAbsentAdapter()]), {
        checkoutRiskBand: 'low',
        payoutDestinations: dests,
        routingProfiles: TEST_CHECKOUT_PROFILES,
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      });
      const m = await local.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 250 } });
      const payment = await local.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });

      await expect(local.authorize(payment.id)).rejects.toMatchObject({
        code: 'pay.rail_failed',
        detail: { failureCode: 'rail.health_stale' },
      });
      expect((await local.getPayment(payment.id)).status).toBe('created');
      expect((await local.history(payment.id, 50)).map((event) => event.event)).toEqual(['created']);
    });

    it('a marked-down rail refuses authorize before the adapter is called', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      let authorizeCalls = 0;
      const realAuthorize = card.authorize.bind(card);
      card.authorize = async (intent) => {
        authorizeCalls += 1;
        return realAuthorize(intent);
      };
      card.setHealthy(false);

      await expect(pay.authorize(payment.id)).rejects.toMatchObject({
        code: 'pay.rail_failed',
        detail: { failureCode: 'rail.marked_down' },
      });
      expect(authorizeCalls).toBe(0);
      expect((await pay.getPayment(payment.id)).status).toBe('created');
      expect(await events(payment.id)).toEqual(['created']);
    });
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────

  describe('webhooks', () => {
    it('A WEBHOOK DELIVERED TWICE CHANGES NOTHING', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      const delivery = signed('card-sandbox', {
        id: 'evt_capture_1',
        type: 'captured',
        ref: payment.railRef,
        amount: '100',
        assetId: 'USDT',
      });

      const first = await pay.handleWebhook('card-sandbox', delivery);
      expect(first.duplicate).toBe(false);
      expect(first.applied).toBe(true);
      expect(await clearingOf(m.id)).toBe('100');

      const journalBefore = ledger.journal().length;
      const eventsBefore = (await pay.history(payment.id, 50)).length;

      const second = await pay.handleWebhook('card-sandbox', delivery);
      expect(second.duplicate).toBe(true);
      expect(second.applied).toBe(false);

      // Nothing. Not a second ledger transaction, not a second event row, not a
      // penny more in clearing.
      expect(ledger.journal()).toHaveLength(journalBefore);
      expect(await pay.history(payment.id, 50)).toHaveLength(eventsBefore);
      expect(await clearingOf(m.id)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('is unmoved by ten deliveries of the same event', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      const delivery = signed('card-sandbox', { id: 'evt_burst', type: 'captured', ref: payment.railRef, amount: '100' });

      for (let i = 0; i < 10; i++) await pay.handleWebhook('card-sandbox', delivery);

      expect(await clearingOf(m.id)).toBe('100');
      expect(ledger.journal().filter((t) => t.reason === 'payment.captured')).toHaveLength(1);
    });

    it('takes a payment from created to captured in one delivery when the rail says both', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('40'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      // Authorize so the rail reference exists, then let a webhook drive capture.
      await pay.authorize(payment.id);

      const outcome = await pay.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', { id: 'evt_both', type: 'captured', ref: `ch_${payment.id}`, amount: '40' }),
      );

      expect(outcome.applied).toBe(true);
      expect((await pay.getPayment(payment.id)).status).toBe('captured');
      expect(await clearingOf(m.id)).toBe('40');
    });

    it('rejects a forged delivery without saying why', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      const genuine = signed('card-sandbox', { id: 'evt_x', type: 'captured', ref: payment.railRef, amount: '100' });
      const tampered = { ...genuine, body: genuine.body.replace('100', '100000') };

      await expect(pay.handleWebhook('card-sandbox', tampered)).rejects.toMatchObject({ code: 'pay.webhook_invalid' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('rejects a delivery signed for a different rail', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      // Correct secret, wrong header names — crypto-native's headers on the
      // card endpoint. There is no cross-rail credential.
      const delivery = signed('crypto-native', { id: 'evt_y', type: 'captured', ref: payment.railRef });
      await expect(pay.handleWebhook('card-sandbox', delivery)).rejects.toMatchObject({ code: 'pay.webhook_invalid' });
    });

    it('refuses to invent a payment from a verified event about an unknown reference', async () => {
      const delivery = signed('card-sandbox', { id: 'evt_ghost', type: 'captured', ref: 'ch_nobody', amount: '999' });
      await expect(pay.handleWebhook('card-sandbox', delivery)).rejects.toMatchObject({ code: 'pay.webhook_unmatched' });
      expect(ledger.journal()).toHaveLength(0);
    });

    describe('a chain delivery to a customer deposit address (W-deposit-05)', () => {
      const chainEvent = {
        id: 'chain:0xabc:0xcustomer:2',
        type: 'captured',
        ref: '0xcustomer',
        amount: '25',
        assetId: 'USDT',
        txHash: '0xabc',
        logIndex: 2,
        confirmations: 12,
      };

      it('goes to the deposit record with its chain position, and creates no payment', async () => {
        const seen: unknown[] = [];
        const routed = new PayService(sql, ledger, rails, {
          custodyDeposits: {
            receive: async (input) => {
              seen.push(input);
              return { state: 'recorded' };
            },
          },
        });
        const outcome = await routed.handleWebhook('crypto-native', signed('crypto-native', chainEvent));
        expect(outcome).toMatchObject({ applied: true, duplicate: false, paymentId: null });
        expect(seen).toEqual([
          { address: '0xcustomer', txHash: '0xabc', outputIndex: 2, assetId: 'USDT', amount: amt('25'), confirmations: 12 },
        ]);
        expect(ledger.journal()).toHaveLength(0);
      });

      it('stays unmatched when the address is no customer address, or no deposit record is wired, or the position is missing', async () => {
        const none = new PayService(sql, ledger, rails, { custodyDeposits: { receive: async () => ({ state: 'unmatched' }) } });
        await expect(none.handleWebhook('crypto-native', signed('crypto-native', chainEvent))).rejects.toMatchObject({
          code: 'pay.webhook_unmatched',
        });
        await expect(pay.handleWebhook('crypto-native', signed('crypto-native', chainEvent))).rejects.toMatchObject({
          code: 'pay.webhook_unmatched',
        });
        const { txHash: _t, ...noPosition } = chainEvent;
        const wired = new PayService(sql, ledger, rails, {
          custodyDeposits: {
            receive: async () => {
              throw new Error('must not be asked');
            },
          },
        });
        await expect(wired.handleWebhook('crypto-native', signed('crypto-native', noPosition))).rejects.toMatchObject({
          code: 'pay.webhook_unmatched',
        });
      });
    });

    describe('a chain reorg of a customer deposit (W-deposit-06)', () => {
      const reorgEvent = {
        id: 'reorg:0xabc:0xcustomer:2',
        type: 'chain.reorged',
        ref: '0xcustomer',
        txHash: '0xabc',
        logIndex: 2,
        confirmations: 0,
      };
      const receive = async () => {
        throw new Error('a reorg is not a sighting');
      };

      it('goes to the deposit record by chain position; a transfer it never recorded is answered, not acted on', async () => {
        const seen: unknown[] = [];
        let answer: 'recorded' | 'unknown' = 'recorded';
        const routed = new PayService(sql, ledger, rails, {
          custodyDeposits: {
            receive,
            reverse: async (input) => {
              seen.push(input);
              return { state: answer };
            },
          },
        });
        expect(await routed.handleWebhook('crypto-native', signed('crypto-native', reorgEvent))).toMatchObject({
          type: 'chain.reorged',
          applied: true,
          paymentId: null,
        });
        expect(seen).toEqual([{ address: '0xcustomer', txHash: '0xabc', outputIndex: 2 }]);
        answer = 'unknown';
        expect(await routed.handleWebhook('crypto-native', signed('crypto-native', reorgEvent))).toMatchObject({ applied: false });
        expect(ledger.journal()).toHaveLength(0);
      });

      it('a reorg naming a merchant payment is not acted on and not recorded as handled: it stays an operator signal', async () => {
        const m = await merchant();
        const payment = await cryptoPayment(m.id, '100');
        const event = { ...reorgEvent, id: `reorg:${payment.railRef}`, ref: payment.railRef };
        for (let i = 0; i < 2; i++) {
          await expect(pay.handleWebhook('crypto-native', signed('crypto-native', event))).rejects.toMatchObject({
            code: 'pay.webhook_unmatched',
          });
        }
        expect(await sql`SELECT 1 FROM pay.payment_events WHERE rail_event_id = ${`crypto-native:${event.id}`}`).toHaveLength(0);
        expect((await pay.getPayment(payment.id)).status).toBe(payment.status);
      });

      it('stays unmatched for an address no customer holds, or with no reversal wired', async () => {
        const none = new PayService(sql, ledger, rails, { custodyDeposits: { receive, reverse: async () => ({ state: 'unmatched' }) } });
        await expect(none.handleWebhook('crypto-native', signed('crypto-native', reorgEvent))).rejects.toMatchObject({
          code: 'pay.webhook_unmatched',
        });
        const unwired = new PayService(sql, ledger, rails, { custodyDeposits: { receive } });
        await expect(unwired.handleWebhook('crypto-native', signed('crypto-native', reorgEvent))).rejects.toMatchObject({
          code: 'pay.webhook_unmatched',
        });
      });
    });

    it('records a refund webhook without acting on it', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      const outcome = await pay.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', { id: 'evt_refund_ext', type: 'refunded', ref: payment.railRef, amount: '100' }),
      );

      // Recorded, not acted on: moving money because a rail said so, without a
      // refund we initiated, is a rail's bug becoming our liability.
      expect(outcome.duplicate).toBe(false);
      expect(outcome.applied).toBe(false);
      expect(await clearingOf(m.id)).toBe('100');
      expect(await events(payment.id)).toContain('webhook.refunded');
    });

    it('fails a payment on a failure webhook, and moves nothing', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      await pay.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', { id: 'evt_fail', type: 'failed', ref: payment.railRef, failureCode: 'card.lost_stolen' }),
      );

      expect((await pay.getPayment(payment.id)).status).toBe('failed');
      expect(ledger.journal()).toHaveLength(0);
    });

    it('dispute.opened posts chargebackOpen from clearing and marks disputed', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      expect(await clearingOf(m.id)).toBe('100');

      const disputeId = `dsp-wh-${payment.id}`;
      const outcome = await pay.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', {
          id: 'evt_cb_open',
          type: 'dispute.opened',
          ref: payment.railRef,
          amount: '100',
          assetId: 'USDT',
          disputeId,
          reasonCode: '4855',
        }),
      );

      expect(outcome.applied).toBe(true);
      expect((await pay.getPayment(payment.id)).status).toBe('disputed');
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.journal().map((t) => t.reason)).toContain('pay.chargeback.opened');
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('posted');
      expect(c?.ledgerTxId).toBeTruthy();
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('dispute.opened records an unfunded shortfall as a refused dispute and posts nothing', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await settle(m.id, 'w-cb-uncovered');
      // After 250 bps, merchant available is 97.5 and clearing is empty.
      // The house fund is empty, so the shortfall is refused before a plan is stored.
      const disputeId = `dsp-uncovered-${payment.id}`;
      const outcome = await pay.handleWebhook(
        'card-sandbox',
        signed('card-sandbox', {
          id: 'evt_cb_uncovered',
          type: 'dispute.opened',
          ref: payment.railRef,
          amount: '100',
          assetId: 'USDT',
          disputeId,
        }),
      );
      expect(outcome.applied).toBe(true);
      const c = defaultDisputeCaseStore.get(disputeId);
      expect(c?.ledgerWire).toBe('refused');
      expect(c?.ledgerRefuse?.code).toBe('pay.chargeback_shortfall_unfunded');
      expect((await pay.getPayment(payment.id)).status).toBe('disputed');
      await expect(pay.refund(payment.id, amt('1'))).rejects.toMatchObject({ code: 'pay.nothing_captured' });
      expect(ledger.journal().some((t) => t.reason === 'pay.chargeback.opened' || t.reason.includes('shortfall'))).toBe(false);
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect((await events(payment.id)).filter((event) => event === 'chargeback.opening_planned')).toHaveLength(0);
    });
  });

  // ── Settlement ────────────────────────────────────────────────────────────

  describe('settlement', () => {
    it('uses merchant → payment lock order when capture races a settlement freeze', async () => {
      const m = await merchant(0);
      const included = await cardPayment(m.id, '40');
      await pay.capture(included.id);
      const toCapture = await cardPayment(m.id, '15');

      let announceMerchantLock!: () => void;
      let releaseSettlement!: () => void;
      const merchantLocked = new Promise<void>((resolve) => (announceMerchantLock = resolve));
      const mayContinue = new Promise<void>((resolve) => (releaseSettlement = resolve));
      const racing = new PayService(sql, ledger, rails, {
        checkoutRiskBand: 'low',
        payoutDestinations: dests,
        routingProfiles: TEST_CHECKOUT_PROFILES,
        afterSettlementMerchantLock: async () => {
          announceMerchantLock();
          await mayContinue;
        },
      });

      const settling = racing.settleWindow({
        merchantId: m.id,
        window: 'w-capture-race',
        assetId: 'USDT',
        from: new Date(Date.now() - 24 * 3600_000),
        to: new Date(Date.now() + 24 * 3600_000),
      });
      await merchantLocked;
      const capturing = racing.capture(toCapture.id);
      await expectEligibilityReadWaiting();
      releaseSettlement();

      const [settled, captured] = await Promise.all([settling, capturing]);
      expect(settled.status).toBe('posted');
      expect(formatAmount(settled.gross)).toBe('40');
      expect(captured.status).toBe('captured');
      expect(await proceedsOf(m.id)).toBe('40');
      expect(await clearingOf(m.id)).toBe('15');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('sweeps every captured payment in the window into one posting', async () => {
      const m = await merchant(200); // 2%
      for (const value of ['10', '20', '30']) {
        const payment = await cardPayment(m.id, value);
        await pay.capture(payment.id);
      }

      const settlement = await settle(m.id, 'w-sweep');

      expect(formatAmount(settlement.gross)).toBe('60');
      expect(formatAmount(settlement.fees)).toBe('1.2');
      expect(await proceedsOf(m.id)).toBe('58.8');
      expect(await clearingOf(m.id)).toBe('0');
    });

    it('is idempotent — re-running a window pays nobody twice', async () => {
      const m = await merchant(250);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      const first = await settle(m.id, 'w-idem');
      const second = await settle(m.id, 'w-idem');
      const third = await settle(m.id, 'w-idem');

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(await proceedsOf(m.id)).toBe('97.5');
      expect(ledger.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * Dual-book lag: MemoryLedger post succeeds, then we throw so the SQL
     * transaction rolls back (settlement stays pending / payments stay captured).
     * Re-run must finish projection; recipe idempotency must not double-credit.
     */
    it('heals projection after ledger post when the DB transaction rolled back', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);

      const realPost = ledger.post.bind(ledger);
      let crashAfterSettle = true;
      (ledger as { post: typeof ledger.post }).post = async (req) => {
        const result = await realPost(req);
        if (crashAfterSettle && req.reason === 'pay.settled') {
          crashAfterSettle = false;
          throw new Error('injected crash after merchantSettlement');
        }
        return result;
      };

      await expect(settle(m.id, 'w-heal-lag')).rejects.toThrow(/injected crash after merchantSettlement/);

      // Ledger moved; SQL projection did not.
      expect(await proceedsOf(m.id)).toBe('40');
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);
      const pending = await sql<{ status: string }[]>`
        SELECT status FROM pay.settlements WHERE merchant_id = ${m.id} AND "window" = 'w-heal-lag'
      `;
      expect(pending[0]?.status).toBe('pending');
      expect((await pay.getPayment(payment.id)).status).toBe('captured');

      // Restore real post; re-run heals projection.
      ledger.post = realPost;
      const healed = await settle(m.id, 'w-heal-lag');
      expect(healed.status).toBe('posted');
      expect(await proceedsOf(m.id)).toBe('40');
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);
      expect((await pay.getPayment(payment.id)).status).toBe('settled');
      expect(await events(payment.id)).toContain('settled');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('settles each asset separately — one window, two currencies, two settlements', async () => {
      const m = await merchant(0);
      const usdt = await cardPayment(m.id, '100', 'USDT');
      await pay.capture(usdt.id);
      const btc = await cardPayment(m.id, '0.5', 'BTC');
      await pay.capture(btc.id);

      const a = await settle(m.id, 'w-multi', 'USDT');
      const b = await settle(m.id, 'w-multi', 'BTC');

      expect(a.id).not.toBe(b.id);
      expect(await proceedsOf(m.id, 'USDT')).toBe('100');
      expect(await proceedsOf(m.id, 'BTC')).toBe('0.5');
      expect(await availableOf(MERCHANT_USER, 'USDT')).toBe('0');
      expect(await availableOf(MERCHANT_USER, 'BTC')).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.totalsByAsset().BTC).toBe('0');
    });

    it('does not settle one merchant’s takings into another’s account', async () => {
      const a = await merchant(0, MERCHANT_USER);
      const b = await merchant(0, OTHER_USER);

      const paymentA = await cardPayment(a.id, '100');
      await pay.capture(paymentA.id);
      const paymentB = await cardPayment(b.id, '70');
      await pay.capture(paymentB.id);

      await settle(a.id, 'w-sep');

      expect(await proceedsOf(a.id)).toBe('100');
      expect(await proceedsOf(b.id)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await availableOf(OTHER_USER)).toBe('0');
      // B's money is untouched and still theirs, in their own clearing account.
      expect(await clearingOf(b.id)).toBe('70');
    });

    it('refuses an empty window rather than recording a payout obligation of nothing', async () => {
      const m = await merchant();
      await expect(settle(m.id, 'w-empty')).rejects.toMatchObject({ code: 'pay.nothing_to_settle' });
    });

    it('does not settle a payment that has not been captured', async () => {
      const m = await merchant();
      await cardPayment(m.id, '100'); // authorized only
      await expect(settle(m.id, 'w-uncaptured')).rejects.toMatchObject({ code: 'pay.nothing_to_settle' });
    });

    it('excludes a fully refunded payment from the window', async () => {
      const m = await merchant(0);
      const keep = await cardPayment(m.id, '30');
      await pay.capture(keep.id);
      const refunded = await cardPayment(m.id, '70');
      await pay.capture(refunded.id);
      await pay.refund(refunded.id, amt('70'));

      const settlement = await settle(m.id, 'w-refunded');
      expect(formatAmount(settlement.gross)).toBe('30');
      expect(await proceedsOf(m.id)).toBe('30');
    });

    it('REFUSES a pre-settlement refund once the payment is frozen in a pending window', async () => {
      // prepareSettlement commits independently of the ledger post. A freeze
      // that has not yet posted must not allow clearing to be drained under the
      // frozen gross — that is how another payment's capture funds the window.
      const base = new MemoryLedger();
      const gate = { blockSettle: true };
      const ledgerProxy: LedgerClient = {
        post: async (request: PostRequest) => {
          if (gate.blockSettle && request.reason === 'pay.settled') {
            throw new Error('simulated ledger outage during settlement post');
          }
          return base.post(request);
        },
        balance: (ref) => base.balance(ref),
        balances: (ownerType, ownerId) => base.balances(ownerType, ownerId),
        getTx: (txId) => base.getTx(txId),
        getTxByKey: (key) => base.getTxByKey(key),
      };
      const gated = new PayService(sql, ledgerProxy, rails);

      const m = await gated.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
      const payment = await gated.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      await gated.authorize(payment.id);
      await gated.capture(payment.id);

      await expect(
        gated.settleWindow({
          merchantId: m.id,
          window: 'w-freeze',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        }),
      ).rejects.toThrow(/simulated ledger outage/);

      // Freeze landed; payment still captured; refund must wait for post.
      expect((await gated.getPayment(payment.id)).status).toBe('captured');
      await expect(gated.refund(payment.id, amt('40'))).rejects.toMatchObject({
        code: 'pay.settlement_in_flight',
      });
      expect(formatAmount((await base.balance(merchantClearing(m.id, 'USDT'))).amount)).toBe('100');

      // After the outage clears, the same window posts and a post-settlement
      // refund draws on available — the path that was always safe.
      gate.blockSettle = false;
      const settlement = await gated.settleWindow({
        merchantId: m.id,
        window: 'w-freeze',
        assetId: 'USDT',
        from: new Date(Date.now() - 24 * 3600_000),
        to: new Date(Date.now() + 24 * 3600_000),
      });
      expect(settlement.status).toBe('posted');
      expect((await gated.getPayment(payment.id)).status).toBe('settled');
      await gated.refund(payment.id, amt('40'));
      expect(formatAmount((await base.balance(merchantProceeds(m.id, 'USDT'))).amount)).toBe('60');
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
      expect(base.reconcile()).toEqual({ ok: true });
    });

    it('excludes a payment with an open refund.posted from the freeze set', async () => {
      const m = await merchant(0);
      const keep = await cardPayment(m.id, '30');
      await pay.capture(keep.id);
      const inflight = await cardPayment(m.id, '70');
      await pay.capture(inflight.id);

      // Operator-visible half-state: ledger refund posted, rail not finished.
      // Simulate with a refund.posted event and no sibling — prepare must not
      // freeze this payment into a window the pool no longer fully holds.
      await sql`
        INSERT INTO pay.payment_events (payment_id, event, payload)
        VALUES (
          ${inflight.id},
          'refund.posted',
          ${sql.json({ refundId: `${inflight.id}:1`, amount: '70', source: 'clearing' } as never)}
        )
      `;

      const settlement = await settle(m.id, 'w-open-refund');
      expect(formatAmount(settlement.gross)).toBe('30');
      expect(await proceedsOf(m.id)).toBe('30');
      // Still captured — not swallowed by a window it did not join.
      expect((await pay.getPayment(inflight.id)).status).toBe('captured');
    });

    it('REFUSES to post when frozen gross no longer matches live nets', async () => {
      const base = new MemoryLedger();
      const gate = { blockSettle: true };
      const ledgerProxy: LedgerClient = {
        post: async (request: PostRequest) => {
          if (gate.blockSettle && request.reason === 'pay.settled') {
            throw new Error('simulated ledger outage during settlement post');
          }
          return base.post(request);
        },
        balance: (ref) => base.balance(ref),
        balances: (ownerType, ownerId) => base.balances(ownerType, ownerId),
        getTx: (txId) => base.getTx(txId),
        getTxByKey: (key) => base.getTxByKey(key),
      };
      const gated = new PayService(sql, ledgerProxy, rails);

      const m = await gated.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
      const payment = await gated.createPayment({
        merchantId: m.id,
        amount: amt('100'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      await gated.authorize(payment.id);
      await gated.capture(payment.id);

      await expect(
        gated.settleWindow({
          merchantId: m.id,
          window: 'w-desync',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        }),
      ).rejects.toThrow(/simulated ledger outage/);

      // Adversarial: force a refunded total the freeze did not account for
      // (service path now blocks this; the re-check is the last line of defence).
      await sql`
        INSERT INTO pay.payment_events (payment_id, event, payload)
        VALUES (
          ${payment.id},
          'refunded',
          ${sql.json({ refundId: 'forced', amount: '25', source: 'clearing' } as never)}
        )
      `;

      gate.blockSettle = false;
      await expect(
        gated.settleWindow({
          merchantId: m.id,
          window: 'w-desync',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        }),
      ).rejects.toMatchObject({ code: 'pay.settlement_desynced' });

      // Nothing moved to the merchant — clearing still holds the capture.
      expect(formatAmount((await base.balance(merchantClearing(m.id, 'USDT'))).amount)).toBe('100');
      expect(formatAmount((await base.balance(merchantProceeds(m.id, 'USDT'))).amount)).toBe('0');
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
    });

    /**
     * G3 — stuck pending has an ops release path.
     *
     * When the ledger post never landed (outage before any credit), release used
     * to be the only recovery. Heal-first now prefers settleWindow re-run once
     * the ledger is healthy again — release is reserved for true desync.
     * Ledger-outage recovery: unblock + release → heals to posted (no double credit).
     */
    it('heals a ledger-outage pending settlement on release (does not free for double credit)', async () => {
      const base = new MemoryLedger();
      const gate = { blockSettle: true };
      const ledgerProxy: LedgerClient = {
        post: async (request: PostRequest) => {
          if (gate.blockSettle && request.reason === 'pay.settled') {
            throw new Error('simulated ledger outage during settlement post');
          }
          return base.post(request);
        },
        balance: (ref) => base.balance(ref),
        balances: (ownerType, ownerId) => base.balances(ownerType, ownerId),
        getTx: (txId) => base.getTx(txId),
        getTxByKey: (key) => base.getTxByKey(key),
      };
      const gated = new PayService(sql, ledgerProxy, rails);

      const m = await gated.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
      const payment = await gated.createPayment({
        merchantId: m.id,
        amount: amt('55'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      await gated.authorize(payment.id);
      await gated.capture(payment.id);

      await expect(
        gated.settleWindow({
          merchantId: m.id,
          window: 'w-g3-stuck',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        }),
      ).rejects.toThrow(/simulated ledger outage/);

      const stuck = await gated.getSettlement(
        (
          await sql<Array<{ id: string }>>`
            SELECT id FROM pay.settlements WHERE merchant_id = ${m.id} AND "window" = 'w-g3-stuck'
          `
        )[0]!.id,
      );
      expect(stuck.status).toBe('pending');

      // Ledger healthy again — release prefers heal over free-and-re-window.
      gate.blockSettle = false;
      const healed = await gated.releasePendingSettlement({
        settlementId: stuck.id,
        reason: 'ops: retry after ledger outage',
      });
      expect(healed.status).toBe('posted');
      expect(formatAmount((await base.balance(merchantProceeds(m.id, 'USDT'))).amount)).toBe('55');
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
      expect(base.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);
      expect(base.reconcile()).toEqual({ ok: true });

      // Posted cannot be released.
      await expect(gated.releasePendingSettlement({ settlementId: healed.id, reason: 'nope' })).rejects.toMatchObject({
        code: 'pay.settlement_not_pending',
      });
    });

    it('adopts a pre-cutover settlement post instead of conflicting, and release heals onto it', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);
      const window = 'w-adopt-legacy';
      await postLegacySettlement(m.id, window, '40');
      const posted = await settle(m.id, window);
      expect(posted.status).toBe('posted');
      expect(await availableOf(MERCHANT_USER)).toBe('40');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason === 'pay.settled')).toHaveLength(1);
      expect((await pay.getPayment(payment.id)).status).toBe('settled');

      const stuckMerchant = await merchant(0);
      const stuckPayment = await cardPayment(stuckMerchant.id, '25');
      await pay.capture(stuckPayment.id);
      const blocked = new PayService(
        sql,
        {
          post: async () => {
            throw new Error('ledger down');
          },
          balance: (ref) => ledger.balance(ref),
          balances: (ownerType, ownerId) => ledger.balances(ownerType, ownerId),
          getTx: (id) => ledger.getTx(id),
          getTxByKey: (key) => ledger.getTxByKey(key),
        },
        rails,
      );
      await expect(
        blocked.settleWindow({
          merchantId: stuckMerchant.id,
          window: 'w-adopt-release',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        }),
      ).rejects.toThrow(/ledger down/);
      await postLegacySettlement(stuckMerchant.id, 'w-adopt-release', '25');
      const healed = await pay.releasePendingSettlement({
        settlementId: (await pay.listSettlements({ merchantId: stuckMerchant.id, limit: 50 })).items[0]!.id,
        reason: 'adopt legacy post',
      });
      expect(healed.status).toBe('posted');
      expect(await availableOf(MERCHANT_USER)).toBe('65');
      expect(await proceedsOf(stuckMerchant.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason === 'pay.settled')).toHaveLength(2);
    });

    /**
     * W8 residual — dual-book lag (ledger ahead of SQL) then ops release must
     * heal, not free payments into a later window that double-credits.
     */
    it('release after dual-book lag heals projection — no double credit on later window', async () => {
      const base = new MemoryLedger();
      let crashAfterSettle = true;
      const ledgerProxy: LedgerClient = {
        post: async (request: PostRequest) => {
          const tx = await base.post(request);
          if (crashAfterSettle && request.reason === 'pay.settled') {
            crashAfterSettle = false;
            throw new Error('injected crash after merchantSettlement');
          }
          return tx;
        },
        balance: (ref) => base.balance(ref),
        balances: (ownerType, ownerId) => base.balances(ownerType, ownerId),
        getTx: (txId) => base.getTx(txId),
        getTxByKey: (key) => base.getTxByKey(key),
      };
      const gated = new PayService(sql, ledgerProxy, rails);

      const m = await gated.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
      const payment = await gated.createPayment({
        merchantId: m.id,
        amount: amt('80'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      await gated.authorize(payment.id);
      await gated.capture(payment.id);

      await expect(
        gated.settleWindow({
          merchantId: m.id,
          window: 'w-lag-release',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        }),
      ).rejects.toThrow(/injected crash after merchantSettlement/);

      // Ledger already credited; row still pending.
      expect(formatAmount((await base.balance(merchantProceeds(m.id, 'USDT'))).amount)).toBe('80');
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
      expect(base.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);
      const lagRow = (
        await sql<Array<{ id: string; status: string }>>`
          SELECT id, status FROM pay.settlements WHERE merchant_id = ${m.id} AND "window" = 'w-lag-release'
        `
      )[0]!;
      expect(lagRow.status).toBe('pending');

      const healed = await gated.releasePendingSettlement({
        settlementId: lagRow.id,
        reason: 'ops thought it was stuck',
      });
      expect(healed.status).toBe('posted');
      // Still one settle credit — not zeroed and not doubled.
      expect(formatAmount((await base.balance(merchantProceeds(m.id, 'USDT'))).amount)).toBe('80');
      expect(base.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);

      // New capture settles under a later window only for the new amount.
      const payment2 = await gated.createPayment({
        merchantId: m.id,
        amount: amt('20'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      await gated.authorize(payment2.id);
      await gated.capture(payment2.id);
      const later = await gated.settleWindow({
        merchantId: m.id,
        window: 'w-lag-later',
        assetId: 'USDT',
        from: new Date(Date.now() - 24 * 3600_000),
        to: new Date(Date.now() + 24 * 3600_000),
      });
      expect(later.status).toBe('posted');
      expect(formatAmount(later.gross)).toBe('20');
      expect(formatAmount((await base.balance(merchantProceeds(m.id, 'USDT'))).amount)).toBe('100');
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
      expect(base.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(2);
      expect(base.reconcile()).toEqual({ ok: true });
    });

    it('refuses to settle a merchant with no fee rate and no configured default', async () => {
      await sql`
        INSERT INTO pay.merchants (user_id, mode, pricing, status)
        VALUES (${'33333333-3333-4333-8333-333333333333'}, 'gateway', '{}'::jsonb, 'active')
      `;
      const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM pay.merchants WHERE user_id = ${'33333333-3333-4333-8333-333333333333'}
      `;
      const merchantId = rows[0]!.id;

      const payment = await cardPayment(merchantId, '100');
      await pay.capture(payment.id);

      // Settling at zero would be revenue that is not merely lost but invisible.
      await expect(settle(merchantId, 'w-nofee')).rejects.toMatchObject({ code: 'pay.fee_bps_unset' });
      expect(await clearingOf(merchantId)).toBe('100');
    });

    it('refuses a fee that consumes the whole window', async () => {
      // 100% can no longer be set (MAX_FEE_BPS is 9999), so the settlement guard is proved on the
      // largest rate a merchant can hold, with a gross small enough that the ceiling eats all of it.
      const m = await merchant(9_999);
      const payment = await cardPayment(m.id, '0.000000000000000001');
      await pay.capture(payment.id);
      await expect(settle(m.id, 'w-allfee')).rejects.toMatchObject({ code: 'pay.fee_exceeds_gross' });
      expect(await clearingOf(m.id)).toBe('0.000000000000000001');
    });

    /**
     * THE OUTBOUND HOLE the inbound gates left open.
     *
     * `createPayment` and public checkout already refuse non-active merchants.
     * Settlement did not. A merchant could take payments while active, get
     * suspended, and still freeze + post a window — money leaving clearing into
     * their available balance after the cut-off. Same code as inbound, same
     * refusal. Captured volume stays in clearing until the merchant is active
     * again (or an owner process decides otherwise).
     */
    it('refuses to settle a window for a suspended merchant', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      await expect(settle(m.id, 'w-suspended')).rejects.toMatchObject({ code: 'pay.merchant_inactive' });

      // Nothing froze, nothing posted. Clearing still holds the capture; the
      // merchant's spendable balance never grew after the cut-off.
      expect(await clearingOf(m.id)).toBe('40');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await sql`SELECT id FROM pay.settlements WHERE merchant_id = ${m.id}`).toHaveLength(0);
      expect((await pay.getPayment(payment.id)).status).toBe('captured');
    });

    it('refuses to settle for closed and pending merchants the same way', async () => {
      const cases: Array<{ status: 'closed' | 'pending'; userId: string }> = [
        { status: 'closed', userId: OTHER_USER },
        { status: 'pending', userId: '44444444-4444-4444-8444-444444444444' },
      ];
      for (const { status, userId } of cases) {
        const row = await pay.createMerchant({ userId, pricing: { feeBps: 0 } });
        const payment = await cardPayment(row.id, '10');
        await pay.capture(payment.id);
        await sql`UPDATE pay.merchants SET status = ${status} WHERE id = ${row.id}`;
        await expect(settle(row.id, `w-${status}`)).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
        expect(await clearingOf(row.id)).toBe('10');
      }
    });

    it('still returns an already-posted settlement when the merchant is later suspended', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '15');
      await pay.capture(payment.id);
      const posted = await settle(m.id, 'w-then-suspend');
      expect(posted.status).toBe('posted');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      // Idempotent re-read: no value moves, so suspension does not invent a new
      // refusal for a window that already finished.
      const again = await settle(m.id, 'w-then-suspend');
      expect(again.id).toBe(posted.id);
      expect(again.status).toBe('posted');
      expect(await proceedsOf(m.id)).toBe('15');
    });

    it('rounds the fee in the house’s favour by at most one unit of precision', async () => {
      const m = await merchant(1); // 0.01%
      const payment = await cardPayment(m.id, '0.000000000000000101');
      await pay.capture(payment.id);

      const settlement = await settle(m.id, 'w-dust');
      // gross × 1bps = 1.01e-20, which rounds up to one unit at 18dp.
      expect(formatAmount(settlement.fees)).toBe('0.000000000000000001');
      expect(formatAmount(settlement.net)).toBe('0.0000000000000001');
      expect(settlement.fees + settlement.net).toBe(settlement.gross);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });
  });

  // ── Payout ────────────────────────────────────────────────────────────────

  describe('identity-owned fresh payment admission', () => {
    it('legacy creation replay validates original parameters before requesting identity or attaching an intent', async () => {
      const m = await merchant(0),
        request = {
          requestId: randomUUID(),
          merchantId: m.id,
          amount: amt('8'),
          assetId: 'USDT',
          method: 'card',
          railAdapter: 'card-sandbox',
          instrument: { kind: 'card', token: 'tok_ok' },
        };
      await pay.createPayment(request);
      let decisions = 0;
      const owner = admittedService({
        decide: async ({ intent }) => {
          decisions++;
          return { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
        },
      });
      await expect(owner.createPayment({ ...request, amount: amt('9') })).rejects.toMatchObject({
        code: 'pay.identity_admission_conflict',
      });
      expect(decisions).toBe(0);
      expect(await sql`SELECT business_id FROM pay.payment_admissions`).toHaveLength(0);
      expect((await owner.createPayment(request)).id).toBe(request.requestId);
      expect(decisions).toBe(1);
    });
    function admittedService(identity: IdentityOperationDecisionPort) {
      return new PayService(sql, ledger, rails, {
        payoutDestinations: dests,
        identityOperationAdmission: identity,
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      });
    }
    const paymentInput = (merchantId: string) => ({
      requestId: randomUUID(),
      merchantId,
      amount: amt('8'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    it('public checkout admits server-derived creation and authorization separately before handing out instructions', async () => {
      const kinds: string[] = [];
      const owner = admittedService({
        decide: async ({ intent }) => {
          kinds.push(intent.operation.kind);
          expect(intent.authority).toEqual({
            kind: 'merchant_policy',
            merchantId: intent.operation.service === 'svc-pay' ? intent.operation.merchantId : '',
          });
          return { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
        },
      });
      const m = await merchant(0),
        link = await owner.createPaymentLink({ merchantId: m.id, label: 'Identity checkout', amount: amt('8'), currency: 'USDT' });
      const opened = await owner.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });
      expect(opened.sessionToken).toBeTruthy();
      expect(opened.session.instruction?.reference).toBeTruthy();
      expect(kinds).toEqual(['payment.create', 'payment.authorize']);
    });
    it('cancelled public creation never exposes an instruction or admits authorization on retry', async () => {
      const kinds: string[] = [];
      const owner = admittedService({
        decide: async ({ intent }) => {
          kinds.push(intent.operation.kind);
          return { status: 'cancelled', intent, code: 'auth.account_frozen', decidedAt: new Date().toISOString() };
        },
      });
      const m = await merchant(0),
        link = await owner.createPaymentLink({ merchantId: m.id, label: 'Frozen checkout', amount: amt('8'), currency: 'USDT' });
      await expect(owner.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' })).rejects.toMatchObject({
        code: 'pay.identity_admission_denied',
      });
      const rows = await sql`SELECT payment_id,status,instruction FROM pay.checkout_sessions`;
      expect(rows[0]).toMatchObject({ status: 'cancelled', instruction: {} });
      await expect(owner.authorize(String(rows[0]!.payment_id))).rejects.toMatchObject({ code: 'pay.identity_admission_denied' });
      expect(kinds).toEqual(['payment.create']);
      expect(ledger.journal()).toHaveLength(0);
    });
    it('create, authorize, capture and payout require separate committed original intents before grants', async () => {
      const kinds: string[] = [];
      const owner = admittedService({
        decide: async ({ intent }) => {
          kinds.push(intent.operation.kind);
          if (intent.operation.kind === 'payout') {
            expect(await sql`SELECT id FROM pay.payout_admissions WHERE business_id=${intent.businessId}`).toHaveLength(1);
            expect(
              await sql`SELECT kind FROM pay.payout_outcomes o JOIN pay.payout_admissions a ON a.id=o.admission_id WHERE a.business_id=${intent.businessId} AND o.kind='identity_requested'`,
            ).toHaveLength(1);
          } else {
            expect(await sql`SELECT payload FROM pay.payment_admissions WHERE business_id=${intent.businessId}`).toHaveLength(1);
            expect(
              await sql`SELECT kind FROM pay.payment_admission_outcomes WHERE business_id=${intent.businessId} AND kind='identity_requested'`,
            ).toHaveLength(1);
          }
          return { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
        },
      });
      const m = await merchant(0),
        request = paymentInput(m.id);
      const p = await owner.createPayment(request);
      expect((await owner.createPayment(request)).id).toBe(p.id);
      await owner.authorize(p.id);
      await owner.capture(p.id);
      const settlement = await settle(m.id, 'identity-all-fresh');
      await owner.payoutSettlement({
        settlementId: settlement.id,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'DE89370400440532013000' },
      });
      expect(kinds).toEqual(['payment.create', 'payment.authorize', 'payment.capture', 'payout']);
      await expect(sql`UPDATE pay.payment_admissions SET payload=payload`).rejects.toThrow('pay.control_record_immutable');
      await expect(sql`DELETE FROM pay.payment_admission_outcomes`).rejects.toThrow('pay.control_record_immutable');
      await expect(
        sql`INSERT INTO pay.payment_admission_outcomes(business_id,kind,payload) VALUES(${`payment.create:${p.id}`},'identity_cancelled','{}')`,
      ).rejects.toThrow('pay_payment_identity_terminal');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it.each(['payment.authorize', 'payment.capture'] as const)(
      'identity freeze refuses fresh %s without rail or ledger effects',
      async (kind) => {
        let frozen = false;
        const kinds: string[] = [];
        const owner = admittedService({
          decide: async ({ intent }) => {
            kinds.push(intent.operation.kind);
            return frozen
              ? { status: 'cancelled', intent, code: 'auth.account_frozen', decidedAt: new Date().toISOString() }
              : { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
          },
        });
        const m = await merchant(0),
          p = await owner.createPayment(paymentInput(m.id));
        if (kind === 'payment.capture') await owner.authorize(p.id);
        frozen = true;
        const before = ledger.journal().length;
        await expect(kind === 'payment.capture' ? owner.capture(p.id) : owner.authorize(p.id)).rejects.toMatchObject({
          code: 'pay.identity_admission_denied',
        });
        expect((await owner.getPayment(p.id)).status).toBe(kind === 'payment.capture' ? 'authorized' : 'created');
        expect(ledger.journal()).toHaveLength(before);
        expect(kinds.at(-1)).toBe(kind);
      },
    );
    it('missing owner transport refuses fresh creation and preserves unresolved original intent without payment effects', async () => {
      const owner = admittedService(createIdentityOperationDecisionClient({ owner: 'svc-pay' })),
        m = await merchant(0);
      await expect(owner.createPayment(paymentInput(m.id))).rejects.toMatchObject({ code: 'pay.identity_admission_unavailable' });
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
      expect(await sql`SELECT business_id FROM pay.payment_admissions`).toHaveLength(1);
      expect(await sql`SELECT kind FROM pay.payment_admission_outcomes WHERE kind='identity_requested'`).toHaveLength(1);
      expect(ledger.journal()).toHaveLength(0);
    });
    it('merchant cutoff cancels pending original creation and prevents late grant retry or changed payload', async () => {
      const identity: IdentityOperationDecisionPort = {
        decide: async ({ mode, intent }) =>
          mode === 'grant'
            ? { status: 'unavailable', code: 'authority.unavailable' }
            : { status: 'cancelled', intent, code: 'admission.cancelled', decidedAt: new Date().toISOString() },
      };
      const owner = admittedService(identity),
        m = await merchant(0),
        request = paymentInput(m.id);
      await expect(owner.createPayment(request)).rejects.toMatchObject({ code: 'pay.identity_admission_unavailable' });
      const founder = randomUUID(),
        ctx: Context = {
          principal: {
            userId: founder,
            sub: founder,
            sid: randomUUID(),
            scopes: ['admin:write'],
            mfa: true,
            tier: 'full',
            expiresAt: new Date(Date.now() + 60000),
          },
          service: null,
          region: 'ID',
          requestId: randomUUID(),
        };
      const controls = new MerchantAccountControls(
        sql,
        async () => founder,
        (tx, id) => drainPendingPaymentIdentityIntents(tx, id, identity),
      );
      const cutoff = await controls.change(ctx, {
        requestId: randomUUID(),
        target: { area: 'merchant', merchantId: m.id },
        action: 'restrict',
        reason: 'Review merchant policy',
        expectedVersion: '0',
      });
      expect(cutoff.outcome).toBe('changed');
      await expect(owner.createPayment(request)).rejects.toMatchObject({ code: 'pay.identity_admission_denied' });
      await expect(owner.createPayment({ ...request, amount: amt('9') })).rejects.toMatchObject({
        code: 'pay.identity_admission_conflict',
      });
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });
    it('original capture grant recovers ledger success before SQL crash after identity freeze and merchant suspension', async () => {
      let frozen = false,
        decisions = 0;
      const owner = admittedService({
        decide: async ({ intent }) => {
          decisions++;
          return frozen
            ? { status: 'cancelled', intent, code: 'auth.account_frozen', decidedAt: new Date().toISOString() }
            : { status: 'granted', intent, grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() };
        },
      });
      const m = await merchant(0),
        p = await owner.createPayment(paymentInput(m.id));
      await owner.authorize(p.id);
      await sql.unsafe(
        `CREATE FUNCTION pay.test_capture_projection_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='captured' THEN RAISE EXCEPTION 'test.capture_projection_crash'; END IF; RETURN NEW; END; $$; CREATE TRIGGER test_capture_projection_crash BEFORE UPDATE ON pay.payments FOR EACH ROW EXECUTE FUNCTION pay.test_capture_projection_crash();`,
      );
      try {
        await expect(owner.capture(p.id)).rejects.toThrow('test.capture_projection_crash');
      } finally {
        await sql.unsafe('DROP TRIGGER test_capture_projection_crash ON pay.payments;DROP FUNCTION pay.test_capture_projection_crash();');
      }
      expect(decisions).toBe(3);
      frozen = true;
      await sql`UPDATE pay.merchants SET status='suspended' WHERE id=${m.id}`;
      expect((await owner.capture(p.id)).status).toBe('captured');
      expect(decisions).toBe(3);
      expect(ledger.journal().filter((row) => row.reason === 'payment.captured')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('payout', () => {
    it('a first payout runs over the HTTP ledger client, which used to throw on getTxByKey (#4694)', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '9');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'payout-over-http-ledger');
      // The same book, reached the way production reaches it: the real HTTP
      // client, signing every request, against a fake svc-ledger door.
      const calls: DoorCall[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = fakeLedgerDoor(ledger, SECRET, calls);
      try {
        const overHttp = new PayService(sql, createLedgerClient('http://ledger.test', SECRET), rails, { payoutDestinations: dests });
        const paid = await overHttp.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
        });
        expect(paid.status).toBe('paid_out');
      } finally {
        globalThis.fetch = realFetch;
      }
      // Hold keys are read before admission and again inside it. The settlement
      // key is read between those, before the admission row exists, so an
      // unrecognised book refuses with no pending exposure.
      const asked = calls.filter((c) => c.path === '/trpc/txByKey').map((c) => c.body.idempotencyKey);
      const legacy = `withdraw.hold:${settlement.id}:0`;
      const proceeds = `pay.proceeds.payout.hold:${settlement.id}:0`;
      const settlementKey = `settlement:${m.id}:payout-over-http-ledger:USDT`;
      expect(asked).toEqual([legacy, proceeds, settlementKey, legacy, proceeds]);
      expect(calls.every((c) => c.service === 'svc-pay')).toBe(true);
      expect(calls.some((c) => c.path === '/trpc/post')).toBe(true);
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('recovers an admitted payout over the HTTP ledger client after a crash before the hold (#4694)', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '8');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'recover-over-http-ledger');
      const calls: DoorCall[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = fakeLedgerDoor(ledger, SECRET, calls);
      try {
        const http = createLedgerClient('http://ledger.test', SECRET);
        const crashing = new PayService(sql, http, rails, {
          payoutDestinations: dests,
          afterPayoutAdmission: () => {
            throw new Error('test.admission_crash');
          },
        });
        const request = {
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
        };
        // First attempt: no admission yet, so both hold lookups run (payment-service.ts:3192 and :3213) and admit it.
        await expect(crashing.payoutSettlement(request)).rejects.toThrow('test.admission_crash');
        expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(1);
        // Retry: the admission is recovered and the payout completes.
        const retried = await new PayService(sql, http, rails, { payoutDestinations: dests }).payoutSettlement(request);
        expect(retried.status).toBe('paid_out');
      } finally {
        globalThis.fetch = realFetch;
      }
      // First attempt reads both hold keys, then the settlement post (before the
      // admission), then both hold keys again inside the admission, then crashes.
      // The retry reads the settlement post once more to choose the pot, then the chosen hold.
      expect(calls.filter((c) => c.path === '/trpc/txByKey')).toHaveLength(7);
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('an old ledger hold without an owner record refuses recovery without guessing a destination', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '5');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'legacy-unowned-hold');
      await ledger.post(
        recipes.deposit({
          userId: MERCHANT_USER,
          assetId: 'USDT',
          amount: settlement.net,
          rail: 'test',
          railRef: `legacy-hold-${settlement.id}`,
        }),
      );
      await ledger.post(
        recipes.withdrawHold({
          userId: MERCHANT_USER,
          assetId: 'USDT',
          amount: settlement.net,
          rail: 'crypto-native',
          withdrawalId: `${settlement.id}:0`,
        }),
      );
      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
        }),
      ).rejects.toMatchObject({ code: 'pay.payout_admission_missing' });
      expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(0);
      expect(chain.outboundTransfers()).toHaveLength(0);
      expect(await heldTotalOf(MERCHANT_USER)).toBe('5');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('fresh payout waits behind merchant restriction and refuses without admission or hold', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '7');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'payout-cutoff-race');
      const destinations = new MerchantPayoutDestinationStore(sql);
      const originalDestination = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f02' };
      await destinations.seedVerified({ merchantId: m.id, railId: 'crypto-native', ...originalDestination });
      const guardedPay = new PayService(sql, ledger, rails, { payoutDestinations: destinations });
      const cutoff = await beginMerchantCutoff(m.id, 'suspended');
      const payout = guardedPay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
      });
      const result = expect(payout).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      try {
        await expectEligibilityReadWaiting();
      } finally {
        await cutoff.commit();
      }
      await result;
      expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(0);
      expect(chain.outboundTransfers()).toHaveLength(0);
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(await proceedsOf(m.id)).toBe('7');
      expect(await destinations.require({ merchantId: m.id, railId: 'crypto-native' })).toEqual(originalDestination);
    });
    it('recovers original durable admission after a crash before hold and later suspension', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '6');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'admission-before-hold-crash');
      const crashing = new PayService(sql, ledger, rails, {
        payoutDestinations: dests,
        afterPayoutAdmission: () => {
          throw new Error('test.admission_crash');
        },
      });
      const request = {
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      };
      await expect(crashing.payoutSettlement(request)).rejects.toThrow('test.admission_crash');
      expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(1);
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      await sql`UPDATE pay.merchants SET status='suspended' WHERE id=${m.id}`;
      expect((await pay.payoutSettlement(request)).status).toBe('paid_out');
      expect(chain.outboundTransfers()).toHaveLength(1);
      await expect(sql`DELETE FROM pay.payout_outcomes`).rejects.toThrow('pay.control_record_immutable');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('concurrent payout retries create one immutable admission and one rail transfer', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '11');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'parallel-payout');
      const request = {
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      };
      const results = await Promise.all([pay.payoutSettlement(request), pay.payoutSettlement(request)]);
      expect(results.every((r) => r.status === 'paid_out')).toBe(true);
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('recovery binds the original rail/destination before any mutable destination store writes', async () => {
      const m = await merchant(0),
        payment = await cryptoPayment(m.id, '9');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'recover-original');
      const originalPost = ledger.post.bind(ledger);
      let crash = true;
      ledger.post = async (request) => {
        const result = await originalPost(request);
        if (crash && request.reason === 'pay.proceeds.payout.held') {
          crash = false;
          throw new Error('test.hold_crash');
        }
        return result;
      };
      const request = {
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      };
      await expect(pay.payoutSettlement(request)).rejects.toThrow('test.hold_crash');
      await sql`UPDATE pay.merchants SET status='suspended' WHERE id=${m.id}`;
      await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'card-sandbox' })).rejects.toMatchObject({
        code: 'pay.payout_recovery_conflict',
      });
      expect((await dests.require({ merchantId: m.id, railId: 'crypto-native' })).ref).toBe(request.destination.ref);
      await dests.persist({ merchantId: m.id, railId: 'crypto-native', kind: 'crypto', ref: '0x0000000000000000000000000000000000000f03' });
      const recovered = await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' });
      expect(recovered.status).toBe('paid_out');
      expect(chain.outboundTransfers()[0]?.to).toBe(request.destination.ref);
      await expect(sql`UPDATE pay.payout_admissions SET destination_ref='another'`).rejects.toThrow('pay.control_record_immutable');
    });
    it('recovers rail and ledger success before SQL projection after suspension', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '15');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'repro-success-before-projection');
      const request = {
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      };
      await sql.unsafe(`CREATE FUNCTION pay.test_fail_payout_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'paid_out' THEN RAISE EXCEPTION 'test.crash_after_ledger_settle'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER test_fail_payout_projection BEFORE UPDATE ON pay.settlements FOR EACH ROW EXECUTE FUNCTION pay.test_fail_payout_projection();`);
      try {
        await expect(pay.payoutSettlement(request)).rejects.toThrow('test.crash_after_ledger_settle');
      } finally {
        await sql.unsafe('DROP TRIGGER test_fail_payout_projection ON pay.settlements; DROP FUNCTION pay.test_fail_payout_projection();');
      }
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
      await sql`UPDATE pay.merchants SET status='suspended' WHERE id=${m.id}`;
      expect((await pay.payoutSettlement(request)).status).toBe('paid_out');
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses to pay out a window that was released before it posted', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '10');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-released-payout');
      // The state releasePendingSettlement leaves on a window that never posted.
      await sql`UPDATE pay.settlements SET status='failed', failure_code='pay.settlement_released' WHERE id=${settlement.id}`;
      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' },
        }),
      ).rejects.toMatchObject({ code: 'pay.settlement_released' });
      expect(chain.totalSent('USDT')).toBe('0');
      expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('moves a settled window out of the book to a chain address', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '10');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout');
      const journalBeforePayout = ledger.journal().length;

      const paid = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' },
      });

      expect(paid.status).toBe('paid_out');
      expect(paid.payoutRef).toBeTruthy();
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await proceedsHeldOf(m.id)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(chain.totalSent('USDT')).toBe('10');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(
        ledger
          .journal()
          .slice(journalBeforePayout)
          .map((tx) => ({ key: tx.idempotencyKey, reason: tx.reason })),
      ).toEqual([
        { key: `pay.proceeds.payout.hold:${settlement.id}:0`, reason: 'pay.proceeds.payout.held' },
        { key: `pay.proceeds.payout.settle:${settlement.id}:0`, reason: 'pay.proceeds.payout.settled' },
      ]);
    });

    it('refuses bank settlement before any recipe posts while the bank rail is absent', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '50');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-bank-absent');
      const journalBeforePayout = ledger.journal().map((tx) => tx.idempotencyKey);

      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'bank-payout',
          destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
        }),
      ).rejects.toMatchObject({ code: 'pay.rail_not_live' });

      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBeforePayout);
      expect(await proceedsOf(m.id)).toBe('50');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('recovers reversal before SQL projection under suspension without asking the rail again', async () => {
      const m = await merchant(0),
        payment = await cardPayment(m.id, '12');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'reverse-before-sql');
      const request = { settlementId: settlement.id, railId: 'card-sandbox', destination: { kind: 'bank', ref: 'DE89370400440532013000' } };
      card.failNext('bank.rejected', 'Beneficiary closed');
      await sql.unsafe(
        `CREATE FUNCTION pay.test_fail_reverse_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'test.reverse_projection_crash'; END IF;RETURN NEW;END;$$; CREATE TRIGGER test_fail_reverse_projection BEFORE UPDATE ON pay.settlements FOR EACH ROW EXECUTE FUNCTION pay.test_fail_reverse_projection();`,
      );
      try {
        await expect(pay.payoutSettlement(request)).rejects.toThrow('test.reverse_projection_crash');
      } finally {
        await sql.unsafe('DROP TRIGGER test_fail_reverse_projection ON pay.settlements;DROP FUNCTION pay.test_fail_reverse_projection();');
      }
      expect(await proceedsOf(m.id)).toBe('12');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      await sql`UPDATE pay.merchants SET status='suspended' WHERE id=${m.id}`;
      await expect(pay.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(await pay.getSettlement(settlement.id)).toMatchObject({ status: 'failed', payoutAttempts: 1 });
      expect(await sql`SELECT kind FROM pay.payout_outcomes WHERE kind='rail_accepted'`).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
    it('returns the funds to the merchant when the payout rail refuses', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '50');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-fail');

      card.failNext('bank.rejected', 'Beneficiary account closed');
      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'card-sandbox',
          destination: { kind: 'bank', ref: 'DE89370400440532013000' },
        }),
      ).rejects.toMatchObject({ code: 'pay.rail_failed' });

      // Held, then released. There is no state in which the merchant's money is
      // neither available, nor held, nor gone with a reference against it.
      expect(await proceedsOf(m.id)).toBe('50');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('failed');
      const failedRead = await pay.readSettlement(settlement.id);
      expect(failedRead.failure).toEqual({ code: 'bank.rejected', message: 'The payout was rejected.' });
      expect(failedRead.failedAt).toBeInstanceOf(Date);
      expect(ledger.reconcile()).toEqual({ ok: true });

      // And it can be retried onto a working destination.
      const retried = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
      });
      expect(retried.status).toBe('paid_out');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      const paidRead = await pay.readSettlement(settlement.id);
      expect(paidRead.status).toBe('paid_out');
      expect(paidRead.failure).toBeNull();
      expect(paidRead.failedAt).toBeNull();
      const [cleared] = await sql<Array<{ failed_at: Date | null; failure_code: string | null }>>`
        SELECT failed_at, failure_code FROM pay.settlements WHERE id = ${settlement.id}`;
      expect(cleared!.failed_at).toBeNull();
      expect(cleared!.failure_code).toBeNull();
    });

    it('overwrites the settlement failure on each refusal instead of keeping the first', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '50');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-fail-overwrite');
      const request = {
        settlementId: settlement.id,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'DE89370400440532013000' },
      };
      card.failNext('bank.rejected', 'Beneficiary account closed');
      await expect(pay.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.rail_failed' });
      await sql`
        UPDATE pay.settlements
           SET failed_at = '2000-01-01T00:00:00.000Z', failure_code = 'card.declined'
         WHERE id = ${settlement.id}`;
      card.failNext('acquirer.unavailable', 'rail text that must not become the stored code');
      await expect(pay.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.rail_failed' });
      const [row] = await sql<Array<{ failed_at: Date; failure_code: string }>>`
        SELECT failed_at, failure_code FROM pay.settlements WHERE id = ${settlement.id}`;
      expect(row!.failure_code).toBe('acquirer.unavailable');
      expect(row!.failed_at.toISOString().startsWith('2000-01-01')).toBe(false);
      const read = await pay.readSettlement(settlement.id);
      expect(read.status).toBe('failed');
      expect(read.failure?.code).toBe('acquirer.unavailable');
    });

    it('a pre-cutover settlement pays out from userAvailable', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '18');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, 'w-legacy-payout', '18');
      const settlement = await settle(m.id, 'w-legacy-payout');
      expect(await availableOf(MERCHANT_USER)).toBe('18');
      expect(await proceedsOf(m.id)).toBe('0');
      const paid = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f11' },
      });
      expect(paid.status).toBe('paid_out');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(
        ledger
          .journal()
          .filter((tx) => tx.reason.startsWith('withdraw.') || tx.reason.startsWith('pay.proceeds.payout'))
          .map((tx) => tx.reason),
      ).toEqual(['withdraw.held', 'withdraw.settled']);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('an in-flight pre-cutover hold finishes on the personal withdraw trio', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '14');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, 'w-legacy-hold', '14');
      const settlement = await settle(m.id, 'w-legacy-hold');
      const originalPost = ledger.post.bind(ledger);
      let crash = true;
      ledger.post = async (request) => {
        const result = await originalPost(request);
        if (crash && request.reason === 'withdraw.held') {
          crash = false;
          throw new Error('test.legacy_hold_crash');
        }
        return result;
      };
      const request = {
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f12' },
      };
      await expect(pay.payoutSettlement(request)).rejects.toThrow('test.legacy_hold_crash');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('14');
      expect(await proceedsOf(m.id)).toBe('0');
      ledger.post = originalPost;
      const paid = await pay.payoutSettlement(request);
      expect(paid.status).toBe('paid_out');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason.startsWith('pay.proceeds.payout'))).toHaveLength(0);
      expect(ledger.journal().filter((tx) => tx.reason === 'withdraw.settled')).toHaveLength(1);
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a refused pre-cutover payout returns to userAvailable and the next attempt settles from there', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '16');
      await pay.capture(payment.id);
      await postLegacySettlement(m.id, 'w-legacy-reverse', '16');
      const settlement = await settle(m.id, 'w-legacy-reverse');
      card.failNext('bank.rejected', 'Beneficiary closed');
      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'card-sandbox',
          destination: { kind: 'bank', ref: 'DE89370400440532013000' },
        }),
      ).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(await availableOf(MERCHANT_USER)).toBe('16');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      const paid = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
      });
      expect(paid.status).toBe('paid_out');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason.startsWith('pay.proceeds.payout'))).toHaveLength(0);
      expect(ledger.journal().map((tx) => tx.reason)).toEqual(
        expect.arrayContaining(['withdraw.held', 'withdraw.reversed', 'withdraw.settled']),
      );
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses an unrecognised settlement book before a payout admission exists', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '12');
      await pay.capture(payment.id);
      const window = 'w-unrecognised-book';
      await ledger.post({
        idempotencyKey: `settlement:${m.id}:${window}:USDT`,
        module: 'pay',
        reason: 'pay.settled',
        meta: { merchantId: m.id, window, assetId: 'USDT' },
        entries: [
          { account: merchantClearing(m.id, 'USDT'), direction: 'credit', amount: amt('12') },
          { account: railBoundary('crypto-native', 'USDT'), direction: 'debit', amount: amt('12') },
        ],
      });
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
        VALUES (${m.id}, ${window}, 'USDT', 12, 0, 12, 'posted')
        RETURNING id
      `;
      await expect(
        pay.payoutSettlement({
          settlementId: row!.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f21' },
        }),
      ).rejects.toMatchObject({ code: 'pay.settlement_book_unrecognised' });
      expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(0);
      expect(chain.outboundTransfers()).toHaveLength(0);
      expect((await pay.getSettlement(row!.id)).status).toBe('posted');
    });

    it('is idempotent — paying out twice pays once', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '10');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-idem');

      const request = {
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x000000000000000000000000000000000000dEaD' },
      };
      await pay.payoutSettlement(request);
      await pay.payoutSettlement(request);

      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(chain.totalSent('USDT')).toBe('10');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses to pay out a settlement that has not been posted', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '10');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-early');

      await sql`UPDATE pay.settlements SET status = 'pending' WHERE id = ${settlement.id}`;
      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'card-sandbox',
          destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
        }),
      ).rejects.toMatchObject({ code: 'pay.invalid_transition' });
    });

    /**
     * Suspension stops money LEAVING, not only money arriving.
     *
     * Posted settlement funds sit in the merchant's available balance. Without
     * this gate they could still call payout onto a chain/bank after cut-off —
     * the exact hole the PAY lane harvest named. Funds stay available; only the
     * rail drain is refused. An already-paid-out settlement remains paid_out
     * (idempotent early return, no second rail call).
     */
    it('refuses to pay out a posted settlement for a suspended merchant', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '25');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-suspended');
      expect(settlement.status).toBe('posted');
      expect(await proceedsOf(m.id)).toBe('25');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000001' },
        }),
      ).rejects.toMatchObject({ code: 'pay.merchant_inactive' });

      // No hold, no rail send, settlement still posted, balance still theirs.
      expect(await proceedsOf(m.id)).toBe('25');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
      expect(chain.totalSent('USDT')).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('still returns paid_out idempotently after the merchant is suspended', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '8');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-then-suspend');
      const paid = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000002' },
      });
      expect(paid.status).toBe('paid_out');
      expect(chain.totalSent('USDT')).toBe('8');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      const again = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000002' },
      });
      expect(again.status).toBe('paid_out');
      expect(chain.outboundTransfers()).toHaveLength(1);
    });

    /**
     * G4 — hold + suspend strand.
     *
     * Crash after withdrawHold leaves funds in the purpose hold while the
     * settlement is still posted. If the merchant is then suspended, resume
     * must finish (idempotent hold + rail + settle), not refuse with
     * merchant_inactive and leave held > 0 forever. A brand-new payout while
     * suspended still refuses before any NEW hold.
     */
    it('after withdrawHold, suspend does not strand — resume finishes the open hold', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '15');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-g4-hold');
      expect(settlement.status).toBe('posted');
      expect(await proceedsOf(m.id)).toBe('15');

      // Drive the actual admission + hold path, then crash before the rail.
      const originalPost = ledger.post.bind(ledger);
      let crash = true;
      ledger.post = async (request) => {
        const result = await originalPost(request);
        if (crash && request.reason === 'pay.proceeds.payout.held') {
          crash = false;
          throw new Error('test.crash_after_hold');
        }
        return result;
      };
      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
        }),
      ).rejects.toThrow('test.crash_after_hold');
      expect(await proceedsHeldOf(m.id)).toBe('15');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      const paid = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
        // Must be a real EVM address shape — destination validation rejects non-hex.
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      });
      expect(paid.status).toBe('paid_out');
      expect(await proceedsHeldOf(m.id)).toBe('0');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(chain.totalSent('USDT')).toBe('15');
      expect(ledger.reconcile()).toEqual({ ok: true });

      // Brand-new payout still blocked while suspended (no second hold from available).
      // Use a second posted window that was never held.
      await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${m.id}`;
      const payment2 = await cryptoPayment(m.id, '7');
      await pay.capture(payment2.id);
      const settlement2 = await settle(m.id, 'w-payout-g4-new');
      expect(await proceedsOf(m.id)).toBe('7');
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      await expect(
        pay.payoutSettlement({
          settlementId: settlement2.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000b01' },
        }),
      ).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(await proceedsOf(m.id)).toBe('7');
    });

    /**
     * Crypto used to accept kind:'bank' + an IBAN and hand the ref to
     * chain.send. MemoryChain "succeeded"; live EVM failed after withdrawHold.
     * Kind must match the rail BEFORE any ledger movement.
     */
    it('refuses a bank IBAN on crypto-native before any hold posts', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '12');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-iban');
      expect(await proceedsOf(m.id)).toBe('12');

      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
        }),
      ).rejects.toMatchObject({ code: 'pay.payout_destination_not_allowed' });

      expect(await proceedsOf(m.id)).toBe('12');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
      expect(chain.totalSent('USDT')).toBe('0');
      expect(chain.outboundTransfers()).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses crypto payout when no EVM dest is stored — nothing held', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '9');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-no-dest');
      const journalBefore = ledger.journal().map((tx) => tx.idempotencyKey);

      await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' })).rejects.toMatchObject({
        code: 'pay.payout_destination_missing',
      });

      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(await proceedsOf(m.id)).toBe('9');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
      expect(chain.totalSent('USDT')).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('pays crypto to the stored EVM dest through ledger-client', async () => {
      const m = await merchant(0);
      const payment = await cryptoPayment(m.id, '11');
      await pay.capture(payment.id);
      const settlement = await settle(m.id, 'w-payout-stored');
      await dests.seedVerified({
        merchantId: m.id,
        railId: 'crypto-native',
        kind: 'crypto',
        ref: '0x000000000000000000000000000000000000dEaD',
      });

      const paid = await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' });
      expect(paid.status).toBe('paid_out');
      expect(chain.totalSent('USDT')).toBe('11');
      expect(chain.outboundTransfers()[0]?.to).toBe('0x000000000000000000000000000000000000dEaD');
      expect(await proceedsOf(m.id)).toBe('0');
      expect(await proceedsHeldOf(m.id)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  // ── Doctrine and invariants ───────────────────────────────────────────────

  describe('doctrine §0.6 — no balance outside the ledger', () => {
    it('keeps the books closed and reconciled after a long mixed run', async () => {
      const a = await merchant(250, MERCHANT_USER);
      const b = await merchant(75, OTHER_USER);

      // Card and crypto, captures, partial and full refunds, a decline, a
      // pending transfer, two settlements and a payout — all interleaved.
      for (let i = 0; i < 6; i++) {
        const cardPay = await cardPayment(a.id, `${10 + i}`);
        await pay.capture(cardPay.id);
        if (i % 3 === 0) await pay.refund(cardPay.id, amt('2'));

        const cryptoPay = await cryptoPayment(b.id, `${1 + i}`);
        await pay.capture(cryptoPay.id);
        if (i % 4 === 0) await pay.refund(cryptoPay.id, amt('1'));
      }

      const declined = await pay.createPayment({
        merchantId: a.id,
        amount: amt('99'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: SANDBOX_DECLINE_TOKEN },
      });
      await expect(pay.authorize(declined.id)).rejects.toThrow();

      const settlementA = await settle(a.id, 'w-mixed');
      const settlementB = await settle(b.id, 'w-mixed');

      await pay.payoutSettlement({
        settlementId: settlementB.id,
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000003' },
      });

      // THE TWO CHECKS THAT MATTER. Every asset nets to zero across the whole
      // book, and a full replay of the journal agrees with every live balance.
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.verifyChain()).toEqual({ ok: true });

      // And the merchant's own account holds exactly what was settled to it.
      expect(await proceedsOf(a.id)).toBe(formatAmount(settlementA.net));
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await clearingOf(a.id)).toBe('0');
      expect(await clearingOf(b.id)).toBe('0');
    });

    it('answers “what do we owe this merchant” from the ledger, not from our tables', async () => {
      const m = await merchant(0);
      const first = await cardPayment(m.id, '30');
      await pay.capture(first.id);
      const second = await cardPayment(m.id, '70');
      await pay.capture(second.id);

      // The clearing account is the answer, and it is reachable without reading
      // a single svc-pay table — which is what makes reconciliation meaningful.
      expect(formatAmount(await pay.clearingBalance(m.id, 'USDT'))).toBe('100');
    });

    it('reads settled proceeds from the merchant proceeds account', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);
      await settle(m.id, 'w-proceeds-balance');
      expect(formatAmount(await pay.merchantBalance(m.id, 'USDT'))).toBe('40');
      expect(await proceedsOf(m.id)).toBe('40');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
    });

    it('holds no numeric balance column of its own', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      const before = await sql<Array<{ amount: string }>>`SELECT amount FROM pay.payments WHERE id = ${payment.id}`;
      await pay.refund(payment.id, amt('40'));
      const after = await sql<Array<{ amount: string }>>`SELECT amount FROM pay.payments WHERE id = ${payment.id}`;

      // `amount` is the authorized amount and never moves. What was captured and
      // refunded is summed from the event log, which is why the two can never
      // disagree.
      expect(after[0]!.amount).toBe(before[0]!.amount);
      const view = await pay.getPayment(payment.id);
      expect(formatAmount(view.capturedAmount)).toBe('100');
      expect(formatAmount(view.refundedAmount)).toBe('40');
    });
  });

  describe('payment_events is append-only, enforced by the database', () => {
    it('refuses an UPDATE', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);

      await expect(sql`UPDATE pay.payment_events SET event = 'tampered' WHERE payment_id = ${payment.id}`).rejects.toThrow(/append-only/);
    });

    it('refuses a DELETE', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');

      await expect(sql`DELETE FROM pay.payment_events WHERE payment_id = ${payment.id}`).rejects.toThrow(/append-only/);
      expect((await pay.history(payment.id, 50)).length).toBeGreaterThan(0);
    });
  });

  describe('merchants and rails', () => {
    it('onboards a merchant idempotently', async () => {
      const first = await merchant(250);
      const second = await merchant(250);
      expect(second.id).toBe(first.id);

      const rows = await sql`SELECT id FROM pay.merchants WHERE user_id = ${MERCHANT_USER}`;
      expect(rows).toHaveLength(1);
    });

    it('refuses a payment on an unknown rail before a row exists', async () => {
      const m = await merchant();
      await expect(
        pay.createPayment({ merchantId: m.id, amount: amt('1'), assetId: 'USDT', method: 'card', railAdapter: 'stripe' }),
      ).rejects.toThrow(/stripe/);

      const rows = await sql`SELECT id FROM pay.payments`;
      expect(rows).toHaveLength(0);
    });

    it('refuses a payment for a suspended merchant', async () => {
      const m = await merchant();
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      await expect(
        pay.createPayment({ merchantId: m.id, amount: amt('1'), assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
      ).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
    });

    /**
     * Mid-flight suspend: payment already created, then merchant cut off.
     * Authorize and capture must stop; refund is not gated (payer return).
     */
    it('refuses authorize and capture after the merchant is suspended mid-flight', async () => {
      const m = await merchant();
      // create only — cryptoPayment() already authorizes, which would skip this gate.
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('15'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      expect(payment.status).toBe('created');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      await expect(pay.authorize(payment.id)).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect((await pay.getPayment(payment.id)).status).toBe('created');

      // Reinstate, authorize, suspend again — capture must refuse.
      await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${m.id}`;
      const authorized = await pay.authorize(payment.id);
      expect(authorized.status).toBe('authorized');
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      await expect(pay.capture(payment.id)).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect((await pay.getPayment(payment.id)).status).toBe('authorized');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('serializes a concurrent KYB rejection ahead of payment creation', async () => {
      const m = await merchant();
      const cutoff = await beginMerchantCutoff(m.id, 'rejected');
      const creating = pay
        .createPayment({
          merchantId: m.id,
          amount: amt('10'),
          assetId: 'USDT',
          method: 'card',
          railAdapter: 'card-sandbox',
          instrument: { kind: 'card', token: 'tok_ok' },
        })
        .then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

      await expectEligibilityReadWaiting();
      await cutoff.commit();
      const outcome = await creating;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'fulfilled') throw new Error('payment creation unexpectedly succeeded');
      expect(outcome.error).toMatchObject({ code: 'pay.kyb_required' });
      expect(await sql`SELECT id FROM pay.payments WHERE merchant_id = ${m.id}`).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('serializes a concurrent KYB rejection ahead of authorization', async () => {
      const m = await merchant();
      const payment = await pay.createPayment({
        merchantId: m.id,
        amount: amt('10'),
        assetId: 'USDT',
        method: 'card',
        railAdapter: 'card-sandbox',
        instrument: { kind: 'card', token: 'tok_ok' },
      });
      const cutoff = await beginMerchantCutoff(m.id, 'rejected');
      const authorizing = pay.authorize(payment.id);
      // Observe the outcome now: the call can reject while the cutoff commit is still in flight, before the assertion below attaches.
      authorizing.catch(() => undefined);

      await expectEligibilityReadWaiting();
      await cutoff.commit();
      await expect(authorizing).rejects.toMatchObject({ code: 'pay.kyb_required' });
      expect((await pay.getPayment(payment.id)).status).toBe('created');
      expect((await pay.history(payment.id, 50)).map((event) => event.event)).toEqual(['created']);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('serializes suspension ahead of capture, while a completed capture retry stays idempotent', async () => {
      const m = await merchant();
      const authorized = await cardPayment(m.id, '25');
      const cutoff = await beginMerchantCutoff(m.id, 'suspended');
      const capturing = pay.capture(authorized.id);
      // Observe the outcome now: the call can reject while the cutoff commit is still in flight, before the assertion below attaches.
      capturing.catch(() => undefined);

      await expectEligibilityReadWaiting();
      await cutoff.commit();
      await expect(capturing).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect((await pay.getPayment(authorized.id)).status).toBe('authorized');
      expect(await availableOf(MERCHANT_USER)).toBe('0');

      await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${m.id}`;
      const captured = await pay.capture(authorized.id);
      await sql`UPDATE pay.merchants SET status = 'suspended', kyb_status = 'rejected' WHERE id = ${m.id}`;
      const replay = await pay.capture(authorized.id);
      expect(replay).toEqual(captured);
      // Capture credits the merchant clearing account; settlement is the
      // separate transition that moves net value into merchant proceeds.
      // A completed retry must not perform either move again.
      expect(await availableOf(MERCHANT_USER)).toBe('0');
      expect(await clearingOf(m.id)).toBe('25');
      expect((await pay.history(authorized.id, 50)).filter((event) => event.event === 'captured')).toHaveLength(1);
      expect(ledger.journal().filter((entry) => entry.reason === 'payment.captured')).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.verifyChain()).toEqual({ ok: true });
    });

    it('refuses a new payment link for a suspended merchant', async () => {
      const m = await merchant();
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      await expect(
        pay.createPaymentLink({ merchantId: m.id, label: 'After cut-off', amount: amt('10'), currency: 'USDT' }),
      ).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`).toHaveLength(0);
    });

    it('refuses a zero or negative payment', async () => {
      const m = await merchant();
      for (const value of [0n, amt('-5')]) {
        await expect(
          pay.createPayment({ merchantId: m.id, amount: value, assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
        ).rejects.toMatchObject({ code: 'pay.invalid_amount' });
      }
    });

    it('rejects malformed merchant pricing at onboarding', async () => {
      await expect(pay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 20_000 } })).rejects.toMatchObject({
        code: 'pay.merchant_pricing_invalid',
      });
      await expect(pay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: -1 } })).rejects.toMatchObject({
        code: 'pay.merchant_pricing_invalid',
      });
    });

    it('reports an unknown payment rather than returning an empty one', async () => {
      await expect(pay.getPayment('44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(PayError);
    });
  });

  // ── PAYMENT LINKS AS CAPABILITY URLS ──────────────────────────────────────
  //
  // A payment link is a bearer credential that anyone holding can pay against,
  // and it survives in email threads, screenshots and browser history. Every
  // test here fails if one becomes issuable without an end.

  describe('payment links', () => {
    it('always has an expiry, even when the merchant does not ask for one', async () => {
      const m = await merchant();
      const before = Date.now();
      const link = await pay.createPaymentLink({ merchantId: m.id, label: 'Invoice 1', amount: amt('10'), currency: 'USDT' });

      expect(link.expiresAt).toBeInstanceOf(Date);
      const day = 24 * 3600_000;
      expect(link.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * day - 2_000);
      expect(link.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * day + 2_000);

      const rows = await sql<Array<{ expires_at: Date | null }>>`SELECT expires_at FROM pay.payment_links WHERE id = ${link.id}`;
      expect(rows[0]!.expires_at).not.toBeNull();
    });

    it('REFUSES omitted expiry when PAY_LINK_DEFAULT_TTL_DAYS is unset — never 30', async () => {
      const m = await merchant();
      const unset = new PayService(sql, ledger, rails, {
        payoutDestinations: dests,
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        // Isolate default-TTL refuse; max is owner-explicit so this is not a max hole.
        linkMaxTtlDays: 365,
      });
      await expect(
        unset.createPaymentLink({ merchantId: m.id, label: 'Invoice 1', amount: amt('10'), currency: 'USDT' }),
      ).rejects.toMatchObject({ code: 'pay.link_ttl_unset' });
      expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`).toHaveLength(0);
    });

    it('REFUSES mint when PAY_LINK_MAX_TTL_DAYS is unset — never 365', async () => {
      const m = await merchant();
      const unset = new PayService(sql, ledger, rails, {
        payoutDestinations: dests,
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        linkDefaultTtlDays: 30,
      });
      await expect(
        unset.createPaymentLink({
          merchantId: m.id,
          label: 'Invoice 1',
          amount: amt('10'),
          currency: 'USDT',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        }),
      ).rejects.toMatchObject({ code: 'pay.link_max_ttl_unset' });
      expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`).toHaveLength(0);
    });

    it('REFUSES a link that never expires', async () => {
      const m = await merchant();
      await expect(
        pay.createPaymentLink({ merchantId: m.id, label: 'Forever', amount: amt('10'), currency: 'USDT', expiresAt: null }),
      ).rejects.toMatchObject({ code: 'pay.link_expiry_invalid' });

      // And nothing was written. A refusal that leaves a row behind is not one.
      const rows = await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`;
      expect(rows).toHaveLength(0);
    });

    it('caps a lifetime the merchant asked to be longer than the ceiling', async () => {
      const m = await merchant();
      const capped = new PayService(sql, ledger, rails, { linkMaxTtlDays: 7 });
      const tenYears = new Date(Date.now() + 3650 * 24 * 3600_000);
      const link = await capped.createPaymentLink({
        merchantId: m.id,
        label: 'Long',
        amount: amt('1'),
        currency: 'USDT',
        expiresAt: tenYears,
      });

      expect(link.expiresAt.getTime()).toBeLessThan(Date.now() + 8 * 24 * 3600_000);
    });

    it('refuses to resolve an expired link', async () => {
      const m = await merchant();
      const link = await pay.createPaymentLink({ merchantId: m.id, label: 'Old', amount: amt('5'), currency: 'USDT' });
      await sql`UPDATE pay.payment_links SET expires_at = now() - interval '1 day' WHERE id = ${link.id}`;

      await expect(pay.resolvePaymentLink(link.token)).rejects.toMatchObject({ code: 'pay.link_expired' });
    });

    it('reports a REVOKED link as not found, never as revoked', async () => {
      const m = await merchant();
      const link = await pay.createPaymentLink({ merchantId: m.id, label: 'Gone', amount: amt('5'), currency: 'USDT' });
      expect(await pay.deactivatePaymentLink(m.id, link.id)).toEqual({ deactivated: true });

      // Whoever holds this URL is anonymous. Confirming the token was once real
      // tells them the merchant exists and that the link was worth something.
      await expect(pay.resolvePaymentLink(link.token)).rejects.toMatchObject({ code: 'pay.link_not_found' });
    });

    it('counts down a bounded link and then refuses it', async () => {
      const m = await merchant();
      const link = await pay.createPaymentLink({
        merchantId: m.id,
        label: 'One-shot invoice',
        amount: amt('5'),
        currency: 'USDT',
        maxUses: 1,
      });

      expect((await pay.resolvePaymentLink(link.token)).remainingUses).toBe(1);

      await sql`UPDATE pay.payment_links SET uses = 1 WHERE id = ${link.id}`;
      await expect(pay.resolvePaymentLink(link.token)).rejects.toMatchObject({ code: 'pay.link_exhausted' });
    });
  });

  // ── HOSTED CHECKOUT ───────────────────────────────────────────────────────
  //
  // THE PUBLIC, UNAUTHENTICATED, VALUE-BEARING SURFACE. Every test in here is
  // about somebody who is not logged in and may be hostile.

  describe('hosted checkout', () => {
    /** A link and a service configured for the public checkout path. */
    async function linked(options: { amount?: string; currency?: string; maxUses?: number } = {}) {
      const m = await merchant();
      const link = await pay.createPaymentLink({
        merchantId: m.id,
        label: 'Order 1001',
        amount: options.amount === undefined ? undefined : amt(options.amount),
        currency: options.currency,
        maxUses: options.maxUses,
      });
      return { merchant: m, link };
    }

    /** Operator risk band is on the service; tests still must pass a real country. */
    const geo = { geoCountry: 'DE' };

    const paymentIdFor = async (reference: string) => {
      const rows = await sql<Array<{ id: string }>>`SELECT id FROM pay.payments WHERE rail_ref = ${reference}`;
      return rows[0]!.id;
    };

    it('REFUSES open checkout when PAY_CHECKOUT_SESSION_TTL_SECONDS is unset — never 900', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      const unset = new PayService(sql, ledger, rails, {
        payoutDestinations: dests,
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        maxOpenSessionsPerLink: 25,
      });
      await expect(unset.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.checkout_session_ttl_unset',
      });
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('REFUSES open checkout when PAY_CHECKOUT_MAX_OPEN_SESSIONS is unset — never 25', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      const unset = new PayService(sql, ledger, rails, {
        payoutDestinations: dests,
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
      });
      await expect(unset.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.checkout_max_open_sessions_unset',
      });
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('opens a session, freezes the amount, and hands the payer a rail reference', async () => {
      const { link } = await linked({ amount: '25.5', currency: 'USDT' });

      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });

      expect(session.status).toBe('open');
      expect(session.amount).toBe('25.5');
      expect(session.currency).toBe('USDT');
      expect(session.instruction?.reference).toBeTruthy();
      expect(sessionToken.startsWith('cs_')).toBe(true);

      // NOTHING IN THE PAYER'S VIEW IDENTIFIES ANYTHING BUT THIS SESSION.
      const keys = Object.keys(session);
      expect(keys).not.toContain('merchantId');
      expect(keys).not.toContain('paymentId');
      expect(keys).not.toContain('railAdapter');
      expect(keys).not.toContain('linkId');
    });

    /**
     * THE FRAUD TEST. A payer who edits the form cannot lower what they owe.
     *
     * The supplied amount is not merged, not compared, not validated against the
     * link — it is IGNORED. Comparing would mean there exists a request in which
     * the client's number is read, and the property this surface needs is that
     * there is not.
     */
    it('IGNORES a payer-supplied amount on a fixed-amount link', async () => {
      const { link } = await linked({ amount: '100', currency: 'USDT' });

      const { session } = await pay.openCheckoutSession({
        linkToken: link.token,
        amount: amt('0.01'),
        assetId: 'BTC',
        ...geo,
      });

      expect(session.amount).toBe('100');
      expect(session.currency).toBe('USDT');

      // And the PAYMENT — the row the ledger will eventually be posted from —
      // carries the merchant's number, not the payer's.
      const payment = await pay.getPayment(await paymentIdFor(session.instruction!.reference));
      expect(formatAmount(payment.amount)).toBe('100');
      expect(payment.assetId).toBe('USDT');
    });

    it('needs the payer to state an amount on a variable-amount link, and freezes what they said', async () => {
      const { link } = await linked({ currency: 'USDT' });

      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.checkout_amount_required',
      });

      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, amount: amt('7.25'), ...geo });
      expect(session.amount).toBe('7.25');

      // Frozen: a later read renders the session's number, never a new one.
      expect((await pay.getCheckoutSession(sessionToken)).amount).toBe('7.25');
    });

    /**
     * THE RAIL IS NOT THE CALLER'S TO CHOOSE.
     *
     * `card-sandbox` is registered, healthy, and supports the whole inbound
     * lifecycle — and it is not what a public checkout lands on, because it is
     * not in `checkoutRails`. There is no input on `openCheckoutSession` that
     * could make it one.
     */
    it('chooses the rail server-side; the payer cannot name one', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });

      const { session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const payment = await pay.getPayment(await paymentIdFor(session.instruction!.reference));

      expect(payment.railAdapter).toBe('crypto-native');
      expect(rails.has('card-sandbox')).toBe(true);
    });

    it('D26-P1-P3: refuses checkout when country is missing — writes nothing', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      await expect(pay.openCheckoutSession({ linkToken: link.token })).rejects.toMatchObject({
        code: 'pay.routing_input_missing',
      });
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('D26-P1-P3: refuses checkout when operator risk band is blank — writes nothing', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      const blank = new PayService(sql, ledger, rails);
      await expect(blank.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.routing_input_missing',
      });
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
    });

    it('D26-P1-P3: method that no checkout rail accepts refuses without inventing a fallback', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo, method: 'card' })).rejects.toMatchObject({
        code: 'pay.routing_no_rail',
      });
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('M-adv-payments-core-11: opens on the one method the business offers for this payment, and refuses any other before a row', async () => {
      const { link, merchant: m } = await linked({ amount: '10', currency: 'USDT' });
      const rule = (method: string, enabled: boolean) => ({ method, enabled, ruleAsset: null, minAmount: null, maxAmount: null });
      // Bank debit first and on: it has no rail and is not for USDT, so the payer is still offered crypto alone.
      await sql`
        INSERT INTO pay.checkout_methods (merchant_id, methods, updated_by)
        VALUES (${m.id}, ${sql.json([rule('bank_debit', true), rule('crypto', true), rule('card', false), rule('pay_later', false)] as never)}, 'test-owner')`;
      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo, method: 'card' })).rejects.toMatchObject({
        code: 'pay.checkout_method_not_offered',
      });
      await expect(pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'XXX', method: 'card' })).rejects.toMatchObject({
        code: 'pay.routing_input_missing',
      });
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      expect(opened.session).toMatchObject({ method: 'crypto', amount: '10', currency: 'USDT' });

      // Crypto off: nothing the business offers can take a USDT payment, and nothing is written.
      await sql`UPDATE pay.checkout_methods SET methods = ${sql.json([rule('bank_debit', true), rule('crypto', false), rule('card', false), rule('pay_later', false)] as never)} WHERE merchant_id = ${m.id}`;
      const before = (await sql`SELECT id FROM pay.payments`).length;
      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({ code: 'pay.checkout_no_method' });
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(before);
    });

    /**
     * THE P0 GATE, ON THE PUBLIC SURFACE.
     *
     * `authorize` and `capture` are deliberately NOT in
     * `VALUE_LEAVING_CAPABILITIES`, because a sandbox capture on a merchant's
     * own integration leaves the platform short and reconciliation catches it.
     * That reasoning does not survive contact with an anonymous payer who is
     * shown "paid" and a merchant who is credited clearing they can withdraw —
     * so `live-only` refuses the public path outright.
     */
    it('REFUSES to open a checkout on a sandbox rail under live-only, and writes nothing', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      const strict = new PayService(sql, ledger, rails, {
        valueMovement: 'live-only',
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
      });

      await expect(strict.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.checkout_rail_not_live',
      });

      // NOTHING WAS CREATED. No session for a payer to poll, no payment row for
      // a settlement sweep to find, and nothing to reconcile.
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('REFUSES hosted checkout when rails are unset — typed code, no ledger post', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      const unset = new PayService(sql, ledger, rails, {
        checkoutRails: [],
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
      });

      await expect(unset.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.checkout_rails_unset',
      });

      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
      expect(ledger.journal()).toHaveLength(0);
    });

    it('REFUSES hosted checkout when PSP/card acquiring is unset — typed code, no ledger post', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });
      const noPsp = new PayService(sql, ledger, rails, {
        checkoutRails: [{ railId: 'card-acquirer', method: 'card' }],
        routingProfiles: [{ railId: 'card-acquirer', methods: ['card'], countries: ['*'], riskBands: ['low'], successRate: '0.80' }],
        checkoutRiskBand: 'low',
      });

      await expect(noPsp.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.psp_unset',
      });

      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
      expect(ledger.journal()).toHaveLength(0);
    });

    it('refuses when the link is exhausted, expired or revoked — before any row exists', async () => {
      const { merchant: m, link } = await linked({ amount: '10', currency: 'USDT', maxUses: 1 });
      await sql`UPDATE pay.payment_links SET uses = 1 WHERE id = ${link.id}`;
      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({ code: 'pay.link_exhausted' });

      const second = await pay.createPaymentLink({ merchantId: m.id, label: 'Old', amount: amt('1'), currency: 'USDT' });
      await sql`UPDATE pay.payment_links SET expires_at = now() - interval '1 hour' WHERE id = ${second.id}`;
      await expect(pay.openCheckoutSession({ linkToken: second.token, ...geo })).rejects.toMatchObject({ code: 'pay.link_expired' });

      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
    });

    it('gives every payer their own session token and their own payment', async () => {
      const { link } = await linked({ amount: '10', currency: 'USDT' });

      const first = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const second = await pay.openCheckoutSession({ linkToken: link.token, ...geo });

      expect(first.sessionToken).not.toBe(second.sessionToken);
      expect(first.session.id).not.toBe(second.session.id);
      // Two payers, two acceptance references. One shared reference would merge
      // two people's money into one payment.
      expect(first.session.instruction!.reference).not.toBe(second.session.instruction!.reference);
    });

    it('puts a floor under an anonymous caller opening sessions off one URL', async () => {
      const { link } = await linked({ amount: '1', currency: 'USDT' });
      const bounded = new PayService(sql, ledger, rails, {
        maxOpenSessionsPerLink: 2,
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        checkoutSessionTtlSeconds: 900,
      });

      await bounded.openCheckoutSession({ linkToken: link.token, ...geo });
      await bounded.openCheckoutSession({ linkToken: link.token, ...geo });

      await expect(bounded.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({ code: 'pay.checkout_busy' });
    });

    /**
     * THE §5 QUESTION FOR THIS FEATURE: if the browser gives up, whose money is
     * stranded?
     *
     * NOBODY'S — and this test is the proof. The session expires; the PAYMENT
     * does not. Funds sent to the acceptance address after the tab timed out are
     * still matched to the payment by the rail's own webhook, still booked, and
     * still credited to the merchant. Expiring the payment alongside the session
     * is the change that WOULD strand a late payer, and this test is what stops
     * somebody making it.
     */
    it('expires the SESSION without expiring the PAYMENT — a late payer is still paid in', async () => {
      const { merchant: m, link } = await linked({ amount: '40', currency: 'USDT' });
      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;

      // The payer wanders off. The handoff window closes.
      await sql`UPDATE pay.checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${session.id}`;
      expect((await pay.getCheckoutSession(sessionToken)).status).toBe('expired');
      expect(await pay.clearingBalance(m.id, 'USDT')).toBe(0n);

      // And then they pay anyway. The chain does not know about our tab.
      chain.credit({ address, assetId: 'USDT', amount: amt('40'), from: '0xlatepayer', confirmations: 12 });
      const outcome = await pay.handleWebhook(
        'crypto-native',
        signed('crypto-native', { id: 'evt-late-1', type: 'captured', ref: address, occurredAt: new Date().toISOString() }),
      );

      expect(outcome.applied).toBe(true);
      // The merchant has the money. That is the whole assertion.
      expect(await clearingOf(m.id)).toBe('40');
      // And the payer's record of their own attempt says paid, rather than
      // sitting `expired` next to a captured payment.
      expect((await pay.getCheckoutSession(sessionToken)).status).toBe('completed');
    });

    it('counts a completed payment against the link exactly once, however many times the webhook is delivered', async () => {
      const { link } = await linked({ amount: '15', currency: 'USDT', maxUses: 2 });
      const { session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;

      chain.credit({ address, assetId: 'USDT', amount: amt('15'), from: '0xbuyer', confirmations: 12 });
      const delivery = signed('crypto-native', {
        id: 'evt-dup-1',
        type: 'captured',
        ref: address,
        occurredAt: new Date().toISOString(),
      });

      await pay.handleWebhook('crypto-native', delivery);
      const second = await pay.handleWebhook('crypto-native', delivery);
      expect(second.duplicate).toBe(true);

      const rows = await sql<Array<{ uses: number }>>`SELECT uses FROM pay.payment_links WHERE id = ${link.id}`;
      expect(Number(rows[0]!.uses)).toBe(1);
      expect((await pay.resolvePaymentLink(link.token)).remainingUses).toBe(1);
    });

    it('takes a payment in two transfers: part shown, nothing credited, then completed once (J-merchant-04 step 5)', async () => {
      const { merchant: m, link } = await linked({ amount: '100', currency: 'USDT', maxUses: 3 });
      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;
      const deliver = (id: string) =>
        pay.handleWebhook(
          'crypto-native',
          signed('crypto-native', { id, type: 'captured', ref: address, occurredAt: new Date().toISOString() }),
        );

      chain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0xpart1' });
      const first = await deliver('evt-part-1');
      expect(first).toMatchObject({ applied: false, duplicate: false });
      const part = await pay.getCheckoutSession(sessionToken);
      expect(part.status).toBe('open');
      expect(part.progress).toEqual({ received: '60', missing: '40', confirming: '0' });
      // No credit yet: the merchant is paid once, for the whole amount.
      expect(await pay.clearingBalance(m.id, 'USDT')).toBe(0n);
      const paid = await sql<Array<{ status: string }>>`
        SELECT p.status FROM pay.payments p JOIN pay.checkout_sessions s ON s.payment_id = p.id WHERE s.id = ${session.id}
      `;
      expect(paid[0]!.status).toBe('created');

      chain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), from: '0xbuyer', confirmations: 12, txHash: '0xpart2' });
      expect(await deliver('evt-part-2')).toMatchObject({ applied: true });
      expect(await clearingOf(m.id)).toBe('100');
      expect((await pay.getCheckoutSession(sessionToken)).status).toBe('completed');

      // Either delivery again changes nothing: one capture, one use of the link.
      await deliver('evt-part-1');
      await deliver('evt-part-2');
      expect(await clearingOf(m.id)).toBe('100');
      const rows = await sql<Array<{ uses: number }>>`SELECT uses FROM pay.payment_links WHERE id = ${link.id}`;
      expect(Number(rows[0]!.uses)).toBe(1);
    });

    it('books nothing when a part is reorganised away between authorize and capture, and books once when it is back', async () => {
      const { merchant: m, link } = await linked({ amount: '100', currency: 'USDT' });
      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;
      const [row] = await sql<Array<{ payment_id: string }>>`SELECT payment_id FROM pay.checkout_sessions WHERE id = ${session.id}`;
      chain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0xr1' });
      chain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), from: '0xbuyer', confirmations: 12, txHash: '0xr2' });
      expect((await pay.authorize(row!.payment_id)).status).toBe('authorized');

      chain.setConfirmations(address, 0, '0xr1');
      await expect(pay.capture(row!.payment_id)).rejects.toMatchObject({ code: 'pay.rail_amount_mismatch' });
      expect(await pay.clearingBalance(m.id, 'USDT')).toBe(0n);

      chain.setConfirmations(address, 12, '0xr1');
      await pay.capture(row!.payment_id);
      expect(await clearingOf(m.id)).toBe('100');
      expect((await pay.getCheckoutSession(sessionToken)).status).toBe('completed');
    });

    it('captures exactly the authorization when dust lands at the address after authorize, and stops asking for the rest', async () => {
      const { merchant: m, link } = await linked({ amount: '100', currency: 'USDT' });
      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;
      const [row] = await sql<Array<{ payment_id: string }>>`SELECT payment_id FROM pay.checkout_sessions WHERE id = ${session.id}`;
      chain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0xd1' });
      await pay.authorize(row!.payment_id);
      expect((await pay.getCheckoutSession(sessionToken)).progress).toEqual({ received: '60', missing: '40', confirming: '0' });

      chain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), from: '0xbuyer', confirmations: 12, txHash: '0xd2' });
      expect((await pay.authorize(row!.payment_id)).status).toBe('authorized');
      // Authorized: the page no longer asks for anything.
      expect((await pay.getCheckoutSession(sessionToken)).progress).toBeNull();

      chain.creditAnother({ address, assetId: 'USDT', amount: amt('0.000001'), from: '0xanyone', confirmations: 12, txHash: '0xdust' });
      await pay.capture(row!.payment_id);
      expect(await clearingOf(m.id)).toBe('100');
    });

    it('still shows a payer what arrived and where the rest goes after the window closes', async () => {
      const { link } = await linked({ amount: '100', currency: 'USDT' });
      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;
      chain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), from: '0xbuyer', confirmations: 12, txHash: '0xe1' });
      await pay.handleWebhook(
        'crypto-native',
        signed('crypto-native', { id: 'evt-closed-1', type: 'captured', ref: address, occurredAt: new Date().toISOString() }),
      );

      await sql`UPDATE pay.checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${session.id}`;
      const closed = await pay.getCheckoutSession(sessionToken);
      expect(closed.status).toBe('expired');
      expect(closed.progress).toEqual({ received: '60', missing: '40', confirming: '0' });
      expect(closed.instruction!.reference).toBe(address);
    });

    it('acts on a transfer delivered again once it is final, after a delivery that came too early', async () => {
      const { merchant: m, link } = await linked({ amount: '20', currency: 'USDT' });
      const { session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;
      const delivery = signed('crypto-native', { id: 'evt-early-1', type: 'captured', ref: address, occurredAt: new Date().toISOString() });

      chain.credit({ address, assetId: 'USDT', amount: amt('20'), from: '0xbuyer', confirmations: 1 });
      expect(await pay.handleWebhook('crypto-native', delivery)).toMatchObject({ applied: false, duplicate: false });
      expect(await pay.clearingBalance(m.id, 'USDT')).toBe(0n);

      // The same delivery, now deep enough, is not a duplicate of the early one.
      chain.setConfirmations(address, 12);
      expect(await pay.handleWebhook('crypto-native', delivery)).toMatchObject({ applied: true, duplicate: false });
      expect(await clearingOf(m.id)).toBe('20');
    });

    /**
     * THE OTHER CRASH POINT: the process dies after the session and payment are
     * committed and before the rail was ever asked.
     *
     * Whose money is stranded? Nobody's — no payer has been handed anywhere to
     * send funds yet. The session sits `open` with no instruction, and the next
     * read completes it, because `authorize` is idempotent on the payment id and
     * the acceptance address is derived from it.
     */
    it('resumes a session that was committed before the rail was asked', async () => {
      const { link } = await linked({ amount: '12', currency: 'USDT' });
      const { sessionToken, session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const address = session.instruction!.reference;

      // Simulate the crash: the row as it was between the two phases.
      await sql`UPDATE pay.checkout_sessions SET instruction = '{}'::jsonb WHERE id = ${session.id}`;

      const resumed = await pay.getCheckoutSession(sessionToken);
      expect(resumed.status).toBe('open');
      // The SAME address. A second one would split one payer across two
      // payments and strand whichever they did not use.
      expect(resumed.instruction!.reference).toBe(address);
    });

    it('refuses a public checkout for a suspended merchant, exactly as the integration path does', async () => {
      const { merchant: m, link } = await linked({ amount: '10', currency: 'USDT' });
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
    });

    it('refuses a public checkout when merchant KYB is rejected', async () => {
      const { merchant: m, link } = await linked({ amount: '10', currency: 'USDT' });
      await sql`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${m.id}`;

      await expect(pay.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.kyb_required',
      });
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('serializes a concurrent KYB rejection ahead of public checkout open', async () => {
      const { merchant: m, link } = await linked({ amount: '10', currency: 'USDT' });
      const cutoff = await beginMerchantCutoff(m.id, 'rejected');
      const opening = pay.openCheckoutSession({ linkToken: link.token, ...geo });
      // Observe the outcome now: the call can reject while the cutoff commit is still in flight, before the assertion below attaches.
      opening.catch(() => undefined);

      await expectEligibilityReadWaiting();
      await cutoff.commit();
      await expect(opening).rejects.toMatchObject({ code: 'pay.kyb_required' });
      expect(await sql`SELECT id FROM pay.checkout_sessions WHERE link_id = ${link.id}`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments WHERE merchant_id = ${m.id}`).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('live-only createPaymentLink refuses when KYB is not approved', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      await expect(
        livePay.createPaymentLink({ merchantId: m.id, label: 'Invoice', amount: amt('10'), currency: 'USDT' }),
      ).rejects.toMatchObject({ code: 'pay.kyb_required' });
      expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`).toHaveLength(0);
    });

    it('live-only createPaymentLink refuses KYB before an unset lifetime, and does not keep the key', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      await expect(
        livePay.createPaymentLink({
          merchantId: m.id,
          label: 'Invoice',
          amount: amt('10'),
          currency: 'USDT',
          idempotencyKey: 'kyb-before-ttl',
        }),
      ).rejects.toMatchObject({ code: 'pay.kyb_required' });
      expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`).toHaveLength(0);
      expect(await sql`SELECT idempotency_key FROM pay.payment_link_create_idempotency WHERE merchant_id = ${m.id}`).toHaveLength(0);
    });

    it('reports an unknown session token as not found rather than an empty session', async () => {
      await expect(pay.getCheckoutSession('cs_nothing_here_at_all')).rejects.toMatchObject({
        code: 'pay.checkout_session_not_found',
      });
    });

    it('sweeps lapsed sessions without touching a payment or a balance', async () => {
      const { merchant: m, link } = await linked({ amount: '10', currency: 'USDT' });
      const { session } = await pay.openCheckoutSession({ linkToken: link.token, ...geo });
      const paymentId = await paymentIdFor(session.instruction!.reference);

      await sql`UPDATE pay.checkout_sessions SET expires_at = now() - interval '1 second' WHERE id = ${session.id}`;
      expect(await pay.expireCheckoutSessions()).toEqual({ expired: 1 });

      // The payment is untouched. Sweeping a browser handoff is not an opinion
      // about anybody's money.
      expect((await pay.getPayment(paymentId)).status).toBe('created');
      expect(await pay.clearingBalance(m.id, 'USDT')).toBe(0n);
    });
  });

  // ── M1 pay.gateway Done bar: KYB stub + durable payment list ───────────────

  describe('merchant KYB stub + payment list', () => {
    async function identityHashOf(merchantId: string): Promise<string> {
      const binding = await loadKybDecisionBinding(sql, merchantId);
      if (!binding) throw new Error(`merchant ${merchantId} has no KYB binding`);
      return binding.identityHash;
    }

    it('submits KYB then decideKybStub approves under allow-sandbox', async () => {
      const m = await merchant();
      expect(m.kybStatus).toBe('none');
      expect(m.kybRef).toBeNull();

      const pending = await pay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-abc' });
      expect(pending.kybStatus).toBe('pending');
      expect(pending.kybRef).toBe('case-abc');

      const approved = await pay.decideKybStub({ actor: KYB_ACTOR, merchantId: m.id, decision: 'approved' });
      expect(approved.kybStatus).toBe('approved');
      expect(approved.kybRef).toBe('case-abc');
    });

    it('every KYB move writes its history row with who made it; a refused move writes none', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      const operator = { id: 'op-compliance-1', scope: 'admin:compliance' };
      await livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-h1' });
      await expect(livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-h1b' })).rejects.toMatchObject({
        code: 'pay.kyb_invalid',
      });
      await expect(livePay.decideKybStub({ actor: KYB_ACTOR, merchantId: m.id, decision: 'approved' })).rejects.toMatchObject({
        code: 'pay.kyb_operator_required',
      });
      await livePay.decideKyb({ actor: operator, merchantId: m.id, decision: 'rejected', identityHash: await identityHashOf(m.id) });
      await livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-h2' });
      await livePay.decideKyb({ actor: operator, merchantId: m.id, decision: 'approved', identityHash: await identityHashOf(m.id) });
      const events = await sql<
        Array<{ from_status: string; to_status: string; kyb_ref: string | null; actor_id: string; actor_scope: string }>
      >`
        SELECT from_status, to_status, kyb_ref, actor_id, actor_scope FROM pay.merchant_kyb_events WHERE merchant_id = ${m.id} ORDER BY seq`;
      expect(events.map((e) => [e.from_status, e.to_status, e.kyb_ref, e.actor_id, e.actor_scope])).toEqual([
        ['none', 'pending', 'case-h1', KYB_ACTOR.id, KYB_ACTOR.scope],
        ['pending', 'rejected', 'case-h1', operator.id, operator.scope],
        ['rejected', 'pending', 'case-h2', KYB_ACTOR.id, KYB_ACTOR.scope],
        ['pending', 'approved', 'case-h2', operator.id, operator.scope],
      ]);
      // If the history row cannot be written, the status move rolls back with it.
      const r = await pay.createMerchant({ userId: '33333333-3333-4333-8333-333333333333', pricing: { feeBps: 100 } });
      const noActor = { id: null as unknown as string, scope: 'pay:onboard' };
      await expect(pay.submitKyb({ actor: noActor, merchantId: r.id, kybRef: 'case-rollback' })).rejects.toThrow();
      expect(await pay.getMerchant(r.id)).toMatchObject({ kybStatus: 'none', kybRef: null });
      await pay.submitKyb({ actor: KYB_ACTOR, merchantId: r.id, kybRef: 'case-rollback' });
      await expect(pay.decideKybStub({ actor: noActor, merchantId: r.id, decision: 'approved' })).rejects.toThrow();
      expect((await pay.getMerchant(r.id)).kybStatus).toBe('pending');
      // The sandbox stub records its decision too.
      const s = await merchant();
      await pay.submitKyb({ actor: KYB_ACTOR, merchantId: s.id, kybRef: 'case-h3' });
      await pay.decideKybStub({ actor: { id: 'owner-stub', scope: 'pay:write' }, merchantId: s.id, decision: 'approved' });
      const stub = await sql<Array<{ to_status: string; actor_id: string; reason: string }>>`
        SELECT to_status, actor_id, reason FROM pay.merchant_kyb_events WHERE merchant_id = ${s.id} ORDER BY seq`;
      expect(stub.map((e) => [e.to_status, e.actor_id, e.reason])).toEqual([
        ['pending', KYB_ACTOR.id, 'Verification reference sent'],
        ['approved', 'owner-stub', 'Approved through the sandbox stub, not reviewed'],
      ]);
    });

    it('refuses decideKybStub under live-only (no invented operator KYB)', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      await livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-live' });
      await expect(livePay.decideKybStub({ actor: KYB_ACTOR, merchantId: m.id, decision: 'approved' })).rejects.toMatchObject({
        code: 'pay.kyb_operator_required',
      });
    });

    it('live-only money doors: none/pending/rejected refuse; operator decideKyb approved passes KYB gate', async () => {
      const livePay = new PayService(sql, ledger, rails, {
        valueMovement: 'live-only',
        // Isolate Layer B KYB from public-rail posture (crypto MemoryChain is not a live rail).
        publicCheckoutMovement: 'allow-sandbox',
        checkoutRails: [{ railId: 'crypto-native', method: 'crypto' }],
        checkoutRiskBand: 'low',
        routingProfiles: TEST_CHECKOUT_PROFILES,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      const createArgs = {
        merchantId: m.id,
        amount: amt('10'),
        assetId: 'USDT',
        method: 'crypto' as const,
        railAdapter: 'crypto-native',
      };

      await expect(livePay.createPayment(createArgs)).rejects.toMatchObject({ code: 'pay.kyb_required' });

      // Link minted on the sandbox fixture instance so we can prove checkout KYB
      // without the live-only createPaymentLink gate blocking the setup.
      const link = await pay.createPaymentLink({
        merchantId: m.id,
        label: 'Live KYB checkout',
        amount: amt('10'),
        currency: 'USDT',
      });
      const openArgs = { linkToken: link.token, geoCountry: 'DE' };
      await expect(livePay.openCheckoutSession(openArgs)).rejects.toMatchObject({
        code: 'pay.kyb_required',
      });

      await livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-live-ops' });
      expect((await livePay.getMerchant(m.id)).kybStatus).toBe('pending');
      await expect(livePay.createPayment(createArgs)).rejects.toMatchObject({ code: 'pay.kyb_required' });
      await expect(livePay.openCheckoutSession(openArgs)).rejects.toMatchObject({
        code: 'pay.kyb_required',
      });
      await expect(livePay.decideKybStub({ actor: KYB_ACTOR, merchantId: m.id, decision: 'rejected' })).rejects.toMatchObject({
        code: 'pay.kyb_operator_required',
      });

      const rejected = await livePay.decideKyb({
        actor: KYB_ACTOR,
        merchantId: m.id,
        decision: 'rejected',
        identityHash: await identityHashOf(m.id),
      });
      expect(rejected.kybStatus).toBe('rejected');
      await expect(livePay.createPayment(createArgs)).rejects.toMatchObject({ code: 'pay.kyb_required' });
      await expect(livePay.openCheckoutSession(openArgs)).rejects.toMatchObject({
        code: 'pay.kyb_required',
      });

      await livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-live-ops-2' });
      const approved = await livePay.decideKyb({
        actor: KYB_ACTOR,
        merchantId: m.id,
        decision: 'approved',
        identityHash: await identityHashOf(m.id),
      });
      expect(approved.kybStatus).toBe('approved');
      expect(approved.kybRef).toBe('case-live-ops-2');

      const payment = await livePay.createPayment(createArgs);
      expect(payment.status).toBe('created');

      const { session } = await livePay.openCheckoutSession(openArgs);
      expect(session.status).toBe('open');
    });

    it('live-only money door refuses without approved KYB (D26-P1-P10 Layer B)', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      await expect(
        livePay.createPayment({
          merchantId: m.id,
          amount: amt('10'),
          assetId: 'USDT',
          method: 'crypto',
          railAdapter: 'crypto-native',
        }),
      ).rejects.toMatchObject({ code: 'pay.kyb_required' });

      await livePay.submitKyb({ actor: KYB_ACTOR, merchantId: m.id, kybRef: 'case-p10' });
      await livePay.decideKyb({ actor: KYB_ACTOR, merchantId: m.id, decision: 'approved', identityHash: await identityHashOf(m.id) });
      const payment = await livePay.createPayment({
        merchantId: m.id,
        amount: amt('10'),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      });
      expect(payment.status).toBe('created');
    });

    it('rejected KYB cannot createPayment even under allow-sandbox', async () => {
      const m = await merchant();
      await sql`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${m.id}`;
      await expect(
        pay.createPayment({
          merchantId: m.id,
          amount: amt('10'),
          assetId: 'USDT',
          method: 'crypto',
          railAdapter: 'crypto-native',
        }),
      ).rejects.toMatchObject({ code: 'pay.kyb_required' });
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    });

    it('lists payments by durable status projection after card lifecycle', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '25');
      await pay.capture(payment.id);

      const listed = await pay.listPayments({ merchantId: m.id, status: 'captured', limit: 50 });
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]!.id).toBe(payment.id);
      expect(listed.items[0]!.status).toBe('captured');
      expect(formatAmount(listed.items[0]!.capturedAmount)).toBe('25');
      expect(listed.items[0]!.pricingSnapshot).toBeNull();
    });

    it('card path still refunds after capture (acquiring E2E on sandbox)', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '40');
      await pay.capture(payment.id);
      const refunded = await pay.refund(payment.id, amt('40'));
      expect(refunded.status).toBe('refunded');
      expect(formatAmount(refunded.refundedAmount)).toBe('40');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });
});
