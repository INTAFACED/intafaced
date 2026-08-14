import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  merchantClearing,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { PayService, PayError, type PaymentView } from './payment-service.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter, SANDBOX_DECLINE_TOKEN } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { MemoryChain } from './rails/chain-port.js';
import { signPayload } from './rails/webhook-signature.js';

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
 */

/**
 * `intafaced_test`, NOT `intafaced`.
 *
 * This suite APPLIES A MIGRATION and TRUNCATES TABLES. Pointed at the shared
 * `intafaced` database it does both to the schema and the rows every other
 * worktree and the running docker stack are using — which is how a branch broke
 * `main`'s tests from a different checkout. It was pointed there by default
 * until now, and `pay.deposits`/`pay.withdrawals` on the running stack had live
 * rows in them.
 *
 * `intafaced_test` is stood up by `tooling/infra/postgres-init/02-intafaced-test-db.sh`
 * with a `pay` schema owned by `svc_pay`. Same convention as
 * `TEST_DATABASE_URL_TRADE`, and `turbo.json` already passes the variable
 * through, so an override is honoured everywhere.
 */
const URL = process.env.TEST_DATABASE_URL_PAY ?? 'postgres://svc_pay:svc_pay@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * 0000, 0002 and 0003 — every migration touching the MERCHANT-money tables,
 * applied together and truncated together in `beforeEach`.
 *
 * The hosted-checkout tests live in this file rather than in one of their own
 * for exactly that reason. `merchants`, `payment_links`, `checkout_sessions`,
 * `payments` and `payment_events` are one connected set that this suite already
 * TRUNCATEs between tests — and vitest runs test FILES in parallel, so a second
 * file exercising the same tables would have its rows deleted out from under it
 * mid-assertion. 0001's tables (`deposits`, `withdrawals`) are disjoint, which
 * is precisely why `user-money-service.test.ts` legitimately gets its own file.
 */
const migrations = ['0000_pay_init.sql', '0002_pay_payment_links.sql', '0003_pay_checkout_sessions.sql', '0005_pay_merchant_kyb.sql'].map(
  (f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'),
);

/** Shared by every svc-pay suite that brings the schema up. Any constant, as long as it is the same one. */
const PAY_MIGRATION_LOCK = 8_140_701;

const SECRET = 'svc-pay-test-secret-at-least-32-characters';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

// Shared journalled probe — not a private catch-false that CI counts as pass.
// #346 long since merged; the private-probe debt lifts with this one line.
const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('svc-pay (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 12,
    connection: { search_path: 'pay,public', application_name: 'svc-pay-test' },
    onnotice: () => undefined,
  });

  // Owns its database, or does not run. This suite TRUNCATEs — pointed at the
  // shared database that is destruction of live rows, which has happened here.
  await assertTestDatabase(sql, 'svc-pay (payments)');

  // Under an advisory lock: vitest runs test FILES in parallel, and the other
  // svc-pay suite brings the same schema up on the same database. The migration
  // re-asserts CHECK constraints with DROP ... IF EXISTS first, so two files
  // running it at once take the same table locks in opposite orders and
  // Postgres kills one of them with a deadlock. Same constant, both files.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${PAY_MIGRATION_LOCK})`;
    for (const migration of migrations) await tx.unsafe(migration);
  });

  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let card: CardSandboxAdapter;
  let crypto: CryptoNativeAdapter;
  let rails: RailRegistry;
  let pay: PayService;
  let dests: ReturnType<typeof memoryPayoutDestinations>;

  beforeEach(async () => {
    // A BARE TRUNCATE, deliberately not wrapped in the migration advisory lock.
    //
    // Taking that lock here looks like insurance and is the opposite: if the
    // other svc-pay suite holds it while applying its migration, this hook
    // blocks, vitest times the hook out, and the abandoned transaction then
    // commits its TRUNCATE somewhere in the middle of the NEXT test — which
    // surfaces as "merchant not found after insert" and foreign-key violations
    // in tests that have nothing to do with any of this. A blocking cleanup is
    // worse than a racing one.
    await sql`TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    card = new CardSandboxAdapter({ secret: SECRET });
    crypto = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6 });
    rails = new RailRegistry([card, crypto, new BankPayoutAbsentAdapter()]);
    dests = memoryPayoutDestinations();
    pay = new PayService(sql, ledger, rails, { checkoutRiskBand: 'low', payoutDestinations: dests });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  async function merchant(feeBps = 250, userId = MERCHANT_USER) {
    return pay.createMerchant({ userId, pricing: { feeBps } });
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

  const events = async (paymentId: string) => (await pay.history(paymentId)).map((e) => e.event);

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

      // §6.1: "merchant net posts to their ledger account — the same balance
      // graph they trade and spend from".
      expect(await availableOf(MERCHANT_USER)).toBe('97.5');
      expect(await clearingOf(m.id)).toBe('0');
      expect(await feesOf()).toBe('2.5');

      expect((await pay.getPayment(payment.id)).status).toBe('settled');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
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
      expect(await availableOf(MERCHANT_USER)).toBe('2.475');
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
      expect(await availableOf(MERCHANT_USER)).toBe('54');
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

    it('refuses to refund a payment that was never captured', async () => {
      const m = await merchant();
      const payment = await cardPayment(m.id, '100');
      await expect(pay.refund(payment.id, amt('10'))).rejects.toMatchObject({ code: 'pay.invalid_transition' });
      expect(ledger.journal()).toHaveLength(0);
    });

    it('draws a post-settlement refund on the merchant, not on the clearing account', async () => {
      const m = await merchant(0);
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await settle(m.id, 'w-post');
      expect(await availableOf(MERCHANT_USER)).toBe('100');

      await pay.refund(payment.id, amt('40'));

      expect(await availableOf(MERCHANT_USER)).toBe('60');
      expect(await clearingOf(m.id)).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('fails a post-settlement refund the merchant cannot cover, rather than inventing the money', async () => {
      const m = await merchant(1000); // 10% — the merchant nets 90 of 100
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await settle(m.id, 'w-short');
      expect(await availableOf(MERCHANT_USER)).toBe('90');

      // The fee is not returned on a refund, so the merchant is 10 short. The
      // ledger refuses, and the refund does not happen at the rail either —
      // which is the entire reason the ledger moves first.
      await expect(pay.refund(payment.id, amt('100'))).rejects.toThrow();

      expect(await availableOf(MERCHANT_USER)).toBe('90');
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
  });

  // ── Capture rules ─────────────────────────────────────────────────────────

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
      const eventsBefore = (await pay.history(payment.id)).length;

      const second = await pay.handleWebhook('card-sandbox', delivery);
      expect(second.duplicate).toBe(true);
      expect(second.applied).toBe(false);

      // Nothing. Not a second ledger transaction, not a second event row, not a
      // penny more in clearing.
      expect(ledger.journal()).toHaveLength(journalBefore);
      expect(await pay.history(payment.id)).toHaveLength(eventsBefore);
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
  });

  // ── Settlement ────────────────────────────────────────────────────────────

  describe('settlement', () => {
    it('sweeps every captured payment in the window into one posting', async () => {
      const m = await merchant(200); // 2%
      for (const value of ['10', '20', '30']) {
        const payment = await cardPayment(m.id, value);
        await pay.capture(payment.id);
      }

      const settlement = await settle(m.id, 'w-sweep');

      expect(formatAmount(settlement.gross)).toBe('60');
      expect(formatAmount(settlement.fees)).toBe('1.2');
      expect(await availableOf(MERCHANT_USER)).toBe('58.8');
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
      expect(await availableOf(MERCHANT_USER)).toBe('97.5');
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
      expect(await availableOf(MERCHANT_USER)).toBe('40');
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
      expect(await availableOf(MERCHANT_USER)).toBe('40');
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
      expect(await availableOf(MERCHANT_USER, 'USDT')).toBe('100');
      expect(await availableOf(MERCHANT_USER, 'BTC')).toBe('0.5');
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

      expect(await availableOf(MERCHANT_USER)).toBe('100');
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
      expect(await availableOf(MERCHANT_USER)).toBe('30');
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
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('60');
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
      expect(await availableOf(MERCHANT_USER)).toBe('30');
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
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('55');
      expect(base.journal().filter((t) => t.reason === 'pay.settled')).toHaveLength(1);
      expect(base.reconcile()).toEqual({ ok: true });

      // Posted cannot be released.
      await expect(gated.releasePendingSettlement({ settlementId: healed.id, reason: 'nope' })).rejects.toMatchObject({
        code: 'pay.settlement_not_pending',
      });
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
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('80');
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
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('80');
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
      expect(formatAmount((await base.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('100');
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
      await expect(settle(merchantId, 'w-nofee')).rejects.toMatchObject({ code: 'pay.merchant_pricing_invalid' });
      expect(await clearingOf(merchantId)).toBe('100');
    });

    it('refuses a fee that consumes the whole window', async () => {
      const m = await merchant(10_000); // 100%
      const payment = await cardPayment(m.id, '100');
      await pay.capture(payment.id);
      await expect(settle(m.id, 'w-allfee')).rejects.toMatchObject({ code: 'pay.fee_exceeds_gross' });
      expect(await clearingOf(m.id)).toBe('100');
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
      expect(await availableOf(MERCHANT_USER)).toBe('15');
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

  describe('payout', () => {
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
        { key: `withdraw.hold:${settlement.id}:0`, reason: 'withdraw.held' },
        { key: `withdraw.settle:${settlement.id}:0`, reason: 'withdraw.settled' },
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
      expect(await availableOf(MERCHANT_USER)).toBe('50');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
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
      expect(await availableOf(MERCHANT_USER)).toBe('50');
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect((await pay.getSettlement(settlement.id)).status).toBe('failed');
      expect(ledger.reconcile()).toEqual({ ok: true });

      // And it can be retried onto a working destination.
      const retried = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'card-sandbox',
        destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
      });
      expect(retried.status).toBe('paid_out');
      expect(await availableOf(MERCHANT_USER)).toBe('0');
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
      expect(await availableOf(MERCHANT_USER)).toBe('25');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000001' },
        }),
      ).rejects.toMatchObject({ code: 'pay.merchant_inactive' });

      // No hold, no rail send, settlement still posted, balance still theirs.
      expect(await availableOf(MERCHANT_USER)).toBe('25');
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
      expect(await availableOf(MERCHANT_USER)).toBe('15');

      // Simulate crash after hold: only the ledger half ran.
      await ledger.post(
        recipes.withdrawHold({
          userId: MERCHANT_USER,
          assetId: 'USDT',
          amount: settlement.net,
          rail: 'crypto-native',
          withdrawalId: `${settlement.id}:0`,
        }),
      );
      expect(await heldTotalOf(MERCHANT_USER)).toBe('15');
      expect(await availableOf(MERCHANT_USER)).toBe('0');

      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;

      const paid = await pay.payoutSettlement({
        settlementId: settlement.id,
        railId: 'crypto-native',
        // Must be a real EVM address shape — destination validation rejects non-hex.
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      });
      expect(paid.status).toBe('paid_out');
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
      expect(await availableOf(MERCHANT_USER)).toBe('7');
      await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
      await expect(
        pay.payoutSettlement({
          settlementId: settlement2.id,
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000b01' },
        }),
      ).rejects.toMatchObject({ code: 'pay.merchant_inactive' });
      expect(await heldTotalOf(MERCHANT_USER)).toBe('0');
      expect(await availableOf(MERCHANT_USER)).toBe('7');
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
      expect(await availableOf(MERCHANT_USER)).toBe('12');

      await expect(
        pay.payoutSettlement({
          settlementId: settlement.id,
          railId: 'crypto-native',
          destination: { kind: 'bank', ref: 'GB82WEST12345698765432' },
        }),
      ).rejects.toMatchObject({ code: 'pay.destination_kind_mismatch' });

      expect(await availableOf(MERCHANT_USER)).toBe('12');
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

      await expect(
        pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' }),
      ).rejects.toMatchObject({ code: 'pay.payout_destination_missing' });

      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(await availableOf(MERCHANT_USER)).toBe('9');
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
      await dests.persist({
        merchantId: m.id,
        railId: 'crypto-native',
        kind: 'crypto',
        ref: '0x000000000000000000000000000000000000dEaD',
      });

      const paid = await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native' });
      expect(paid.status).toBe('paid_out');
      expect(chain.totalSent('USDT')).toBe('11');
      expect(chain.outboundTransfers()[0]?.to).toBe('0x000000000000000000000000000000000000dEaD');
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
      expect(await availableOf(MERCHANT_USER)).toBe(formatAmount(settlementA.net));
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
      expect((await pay.history(payment.id)).length).toBeGreaterThan(0);
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
      const link = await pay.createPaymentLink({ merchantId: m.id, label: 'Invoice 1', amount: amt('10'), currency: 'USDT' });

      expect(link.expiresAt).toBeInstanceOf(Date);
      expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const rows = await sql<Array<{ expires_at: Date | null }>>`SELECT expires_at FROM pay.payment_links WHERE id = ${link.id}`;
      expect(rows[0]!.expires_at).not.toBeNull();
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
      const strict = new PayService(sql, ledger, rails, { valueMovement: 'live-only', checkoutRiskBand: 'low' });

      await expect(strict.openCheckoutSession({ linkToken: link.token, ...geo })).rejects.toMatchObject({
        code: 'pay.checkout_rail_not_live',
      });

      // NOTHING WAS CREATED. No session for a payer to poll, no payment row for
      // a settlement sweep to find, and nothing to reconcile.
      expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
      expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
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
      const bounded = new PayService(sql, ledger, rails, { maxOpenSessionsPerLink: 2, checkoutRiskBand: 'low' });

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

    it('live-only createPaymentLink refuses when KYB is not approved', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      await expect(
        livePay.createPaymentLink({ merchantId: m.id, label: 'Invoice', amount: amt('10'), currency: 'USDT' }),
      ).rejects.toMatchObject({ code: 'pay.kyb_required' });
      expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${m.id}`).toHaveLength(0);
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
    it('submits KYB then decideKybStub approves under allow-sandbox', async () => {
      const m = await merchant();
      expect(m.kybStatus).toBe('none');
      expect(m.kybRef).toBeNull();

      const pending = await pay.submitKyb({ merchantId: m.id, kybRef: 'case-abc' });
      expect(pending.kybStatus).toBe('pending');
      expect(pending.kybRef).toBe('case-abc');

      const approved = await pay.decideKybStub({ merchantId: m.id, decision: 'approved' });
      expect(approved.kybStatus).toBe('approved');
      expect(approved.kybRef).toBe('case-abc');
    });

    it('refuses decideKybStub under live-only (no invented operator KYB)', async () => {
      const livePay = new PayService(sql, ledger, rails, { valueMovement: 'live-only' });
      const m = await livePay.createMerchant({ userId: OTHER_USER, pricing: { feeBps: 100 } });
      await livePay.submitKyb({ merchantId: m.id, kybRef: 'case-live' });
      await expect(livePay.decideKybStub({ merchantId: m.id, decision: 'approved' })).rejects.toMatchObject({
        code: 'pay.kyb_operator_required',
      });
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

      // Operator-approved KYB (simulated — no invent grant of pay:* scopes).
      await sql`UPDATE pay.merchants SET kyb_status = 'approved' WHERE id = ${m.id}`;
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

      const listed = await pay.listPayments({ merchantId: m.id, status: 'captured' });
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(payment.id);
      expect(listed[0]!.status).toBe('captured');
      expect(formatAmount(listed[0]!.capturedAmount)).toBe('25');
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
}
