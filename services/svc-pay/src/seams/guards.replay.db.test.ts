import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IdentityOperationDecisionPort } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { UserMoneyService, openWithdrawalHolds } from '../user-money-service.js';
import { WalletPay, failClosedWalletPublish, type WalletPublish } from '../wallet/wallet-pay.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { installPayoutDestinationShim } from '../payout-destination-test-shim.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { composeGuards, PayGuardRefusal, type GuardReplay, type PartialPayGuards } from './guards.js';

/**
 * The two W0b properties, proved against the real money paths:
 *
 *   1. LOCK ORDER. On every payment-admission path (no identity, identity,
 *      public checkout with and without identity) `beforePaymentAdmit` runs with
 *      the merchant row already locked and the payment row not yet locked or
 *      inserted. Measured from a SECOND connection with `FOR UPDATE NOWAIT`: it
 *      fails exactly when the guard's own transaction holds the merchant's
 *      `FOR SHARE` lock.
 *   2. REPLAY FLAG. Each replay and recovery path hands the guard the right
 *      `replay`, and the two new seams run before any write and leave nothing
 *      behind when they refuse.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-seams-test-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };
const BANK = { kind: 'bank', ref: 'DE89370400440532013000' };

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_seams_replay_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const label = (r: GuardReplay): string => (r.kind === 'fresh' ? 'fresh' : `${r.kind}:${r.reason}`);

const grantAll: IdentityOperationDecisionPort = {
  decide: async ({ intent }) => ({
    status: 'granted',
    intent,
    grantId: randomUUID(),
    identityVersion: '0',
    decidedAt: new Date().toISOString(),
  }),
};

describe('guard seams: lock order, replay flag, refund and user-money withdrawal', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let probe!: postgres.Sql;
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let rails: RailRegistry;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    probe = postgres(db.url, { max: 2, onnotice: () => undefined });
  }, 120_000);

  let restorePayoutShim: (() => void) | undefined;
  afterEach(() => {
    restorePayoutShim?.();
    restorePayoutShim = undefined;
  });
  beforeEach(async () => {
    restorePayoutShim = installPayoutDestinationShim(sql);
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    rails = new RailRegistry([
      new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
      new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ]);
  }, 30_000);

  afterAll(async () => {
    await probe?.end({ timeout: 1 });
    await db?.drop();
    await adminStop();
  }, 30_000);

  const service = (parts: PartialPayGuards = {}, identity?: IdentityOperationDecisionPort, registry: RailRegistry = rails) =>
    new PayService(sql, ledger, registry, {
      payoutDestinations: memoryPayoutDestinations(),
      guards: composeGuards(parts),
      ...(identity ? { identityOperationAdmission: identity } : {}),
      checkoutRiskBand: 'low',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
        p.railId === 'crypto-native'
          ? { ...p, successRate: '0.90' }
          : p.railId === 'card-sandbox'
            ? { ...p, successRate: '0.88' }
            : { ...p },
      ),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });

  /** True while ANOTHER connection cannot take `FOR UPDATE NOWAIT` on the row, i.e. this row is locked by someone else. */
  const rowLocked = async (table: 'merchants' | 'payments', id: string): Promise<boolean> => {
    try {
      if (table === 'merchants') await probe`SELECT id FROM pay.merchants WHERE id = ${id} FOR UPDATE NOWAIT`;
      else await probe`SELECT id FROM pay.payments WHERE id = ${id} FOR UPDATE NOWAIT`;
      return false;
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') return true;
      throw error;
    }
  };

  async function cryptoPayment(
    pay: PayService,
    merchantId: string,
    amount = '10',
    upTo: 'created' | 'authorized' | 'captured' = 'captured',
  ) {
    const created = await pay.createPayment({
      requestId: randomUUID(),
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    if (upTo === 'created') return created;
    const address = await chain.acceptanceAddress(created.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt(amount), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(created.id);
    if (upTo === 'authorized') return created;
    await pay.capture(created.id);
    return created;
  }

  const settle = (pay: PayService, merchantId: string, window: string) =>
    pay.settleWindow({
      merchantId,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });

  describe('lock order: merchant row, then the guard, then the payment row', () => {
    for (const withIdentity of [false, true]) {
      it(`${withIdentity ? 'with' : 'without'} identity admission: create, authorize, capture and public checkout call the guard at the same point`, async () => {
        const seen: Array<{ kind: string; replay: string; merchantLocked: boolean; paymentLocked: boolean; inserted: boolean }> = [];
        const watcher: PartialPayGuards = {
          beforePaymentAdmit: async (ctx) => {
            seen.push({
              kind: ctx.kind,
              replay: label(ctx.replay),
              merchantLocked: await rowLocked('merchants', ctx.merchantId),
              paymentLocked: await rowLocked('payments', ctx.paymentId),
              inserted: (await ctx.tx`SELECT 1 FROM pay.payments WHERE id = ${ctx.paymentId}`).length > 0,
            });
          },
        };
        const pay = service(watcher, withIdentity ? grantAll : undefined);
        const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
        await cryptoPayment(pay, m.id);
        const link = await pay.createPaymentLink({ merchantId: m.id, label: 'Lock order', amount: amt('8'), currency: 'USDT' });
        await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });

        const kinds = new Set(seen.map((s) => s.kind));
        expect(kinds).toEqual(new Set(['payment.create', 'payment.authorize', 'payment.capture']));
        // Two creates are fresh (direct and checkout): neither has a payment row yet.
        const freshCreates = seen.filter((s) => s.kind === 'payment.create' && s.replay === 'fresh');
        expect(freshCreates).toHaveLength(2);
        for (const s of freshCreates) expect(s.inserted).toBe(false);
        // EVERY call: merchant row already locked by the admission, payment row not.
        for (const s of seen) expect(s, JSON.stringify(s)).toMatchObject({ merchantLocked: true, paymentLocked: false });
      });
    }
  });

  describe('replay flag on payment admission', () => {
    it('an idempotent REST-style repeat of createPayment is a replay; the first is fresh', async () => {
      const seen: string[] = [];
      const pay = service({ beforePaymentAdmit: async (ctx) => void seen.push(`${ctx.kind}|${label(ctx.replay)}`) });
      const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const input = {
        requestId: randomUUID(),
        merchantId: m.id,
        amount: amt('5'),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      };
      await pay.createPayment(input);
      await pay.createPayment(input);
      expect(seen).toEqual(['payment.create|fresh', 'payment.create|replay:payment_exists']);
    });

    it('identity checkout: the intake is fresh once; the createPayment and authorize-marker repeats are replays; authorize is fresh', async () => {
      const seen: string[] = [];
      const pay = service({ beforePaymentAdmit: async (ctx) => void seen.push(`${ctx.kind}|${label(ctx.replay)}`) }, grantAll);
      const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const link = await pay.createPaymentLink({ merchantId: m.id, label: 'Replay checkout', amount: amt('8'), currency: 'USDT' });
      await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });
      expect(seen[0]).toBe('payment.create|fresh');
      expect(seen.filter((s) => s === 'payment.create|fresh')).toHaveLength(1);
      for (const s of seen.filter((x) => x.startsWith('payment.create') && x !== seen[0]))
        expect(s).toBe('payment.create|replay:payment_exists');
      expect(seen.filter((s) => s === 'payment.authorize|fresh')).toHaveLength(1);
    });

    it('capture recovery: the ledger already holds the capture key, so the guard sees a recovery; an ordinary capture is fresh', async () => {
      const seen: string[] = [];
      const pay = service({
        beforePaymentAdmit: async (ctx) => {
          if (ctx.kind === 'payment.capture') seen.push(label(ctx.replay));
        },
      });
      const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await cryptoPayment(pay, m.id, '10', 'captured');
      expect(seen).toEqual(['fresh']);

      const crashed = await cryptoPayment(pay, m.id, '7', 'authorized');
      const [row] = await sql`SELECT rail_ref, amount::text AS amount FROM pay.payments WHERE id = ${crashed.id}`;
      // The post landed, then the process died before the payment moved to captured.
      await ledger.post(
        recipes.paymentCapture({
          paymentId: crashed.id,
          merchantId: m.id,
          assetId: 'USDT',
          amount: amt(String(row!.amount)),
          rail: 'crypto-native',
          railRef: String(row!.rail_ref),
        }),
      );
      seen.length = 0;
      const done = await pay.capture(crashed.id);
      expect(done.status).toBe('captured');
      expect(seen).toEqual(['recovery:ledger_already_booked']);
    });
  });

  describe('replay flag on settlement and payout', () => {
    it('settlement re-run: a frozen-not-posted window is a recovery on both phases; a finished one is a replay', async () => {
      const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await cryptoPayment(service(), m.id);
      const seen: string[] = [];
      let refusePost = true;
      const pay = service({
        beforeSettlementRun: async (ctx) => {
          seen.push(`${ctx.phase}|${label(ctx.replay)}`);
          if (ctx.phase === 'post' && refusePost) throw new PayGuardRefusal('pay.guard_test_halt', 'unavailable');
        },
      });
      await expect(settle(pay, m.id, 'replay-w')).rejects.toMatchObject({ code: 'pay.guard_test_halt' });
      expect(seen).toEqual(['prepare|fresh', 'post|fresh']);
      expect((await sql`SELECT status FROM pay.settlements`)[0]!.status).toBe('pending');

      refusePost = false;
      seen.length = 0;
      const posted = await settle(pay, m.id, 'replay-w');
      expect(posted.status).toBe('posted');
      expect(seen).toEqual(['prepare|recovery:window_frozen_not_posted', 'post|recovery:window_frozen_not_posted']);

      seen.length = 0;
      await settle(pay, m.id, 'replay-w');
      expect(seen).toEqual(['prepare|replay:window_already_frozen']);
    });

    it('payout: admit is fresh; execute is fresh until the hold is booked, and a recovery once it is', async () => {
      const flaky = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
      const realPayout = flaky.payout.bind(flaky);
      let fail = true;
      flaky.payout = async (instruction) => {
        if (fail) {
          fail = false;
          throw new Error('rail connection dropped after the hold');
        }
        return realPayout(instruction);
      };
      rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }), flaky, new BankPayoutAbsentAdapter()]);

      const seen: string[] = [];
      let refuseExecute = true;
      const pay = service(
        {
          beforePayoutAdmit: async (ctx) => void seen.push(`admit|${label(ctx.replay)}`),
          beforePayoutExecute: async (ctx) => {
            seen.push(`execute|${label(ctx.replay)}`);
            if (refuseExecute) throw new PayGuardRefusal('pay.guard_test_halt', 'unavailable');
          },
        },
        undefined,
        rails,
      );
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await cryptoPayment(pay, m.id);
      const settlement = await settle(pay, m.id, 'replay-payout');
      const request = { settlementId: settlement.id, railId: 'crypto-native', destination: DEST };

      // Admitted, but a halt stops it before anything moves: the retry is still fresh, so a halt keeps stopping it.
      await expect(pay.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.guard_test_halt' });
      await expect(pay.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.guard_test_halt' });
      expect(seen).toEqual(['admit|fresh', 'execute|fresh', 'execute|fresh']);

      // Lift the halt; the rail drops after the hold is posted. Next run resumes the held payout.
      refuseExecute = false;
      seen.length = 0;
      await expect(pay.payoutSettlement(request)).rejects.toThrow('rail connection dropped');
      expect(seen).toEqual(['execute|fresh']);
      seen.length = 0;
      const paid = await pay.payoutSettlement(request);
      expect(paid.status).toBe('paid_out');
      expect(seen).toEqual(['execute|recovery:payout_hold_booked']);
    });
  });

  describe('beforeRefund', () => {
    it('runs before any ledger write or event; a completed refund id repeats as a replay', async () => {
      const seen: Array<{
        replay: string;
        journal: number;
        events: number;
        refundId: string | undefined;
        merchantId: string;
        amount: bigint;
      }> = [];
      const pay = service({
        beforeRefund: async (ctx) => {
          seen.push({
            replay: label(ctx.replay),
            journal: ledger.journal().length,
            events: (await ctx.tx`SELECT 1 FROM pay.payment_events WHERE payment_id = ${ctx.paymentId}`).length,
            refundId: ctx.refundId,
            merchantId: ctx.merchantId,
            amount: ctx.amount,
          });
        },
      });
      const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const p = await cryptoPayment(pay, m.id, '10');
      const journalBefore = ledger.journal().length;
      const eventsBefore = (await sql`SELECT 1 FROM pay.payment_events WHERE payment_id = ${p.id}`).length;

      await pay.refund(p.id, amt('4'), { refundId: 'r-1' });
      await pay.refund(p.id, amt('4'), { refundId: 'r-1' });

      expect(seen.map((s) => s.replay)).toEqual(['fresh', 'replay:refund_already_completed']);
      // First call: nothing refund-related existed yet when the guard ran.
      expect(seen[0]).toMatchObject({ journal: journalBefore, events: eventsBefore, refundId: 'r-1', merchantId: m.id, amount: amt('4') });
      // Replay: the first refund's writes are all there, and the replay wrote nothing more.
      expect(seen[1]!.journal).toBe(ledger.journal().length);
    });

    it('a refusal leaves no side effects: no ledger entry, no event, no status change, no rail call', async () => {
      const open = service();
      const m = await open.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const p = await cryptoPayment(open, m.id, '10');
      const journal = ledger.journal().length;
      const events = await sql`SELECT event FROM pay.payment_events WHERE payment_id = ${p.id} ORDER BY seq`;
      const outbound = chain.outboundTransfers().length;

      for (const thrown of [new PayGuardRefusal('pay.guard_test_refused', 'refused'), new Error('relation "pay.caps" does not exist')]) {
        const pay = service({
          beforeRefund: async () => {
            throw thrown;
          },
        });
        const error = await pay.refund(p.id, amt('4'), { refundId: 'r-x' }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PayGuardRefusal);
        expect(error).toMatchObject(
          thrown instanceof PayGuardRefusal
            ? { code: 'pay.guard_test_refused', kind: 'refused' }
            : { code: 'pay.guard_unavailable', kind: 'unavailable', message: 'pay.guard_unavailable' },
        );
      }
      expect(ledger.journal().length).toBe(journal);
      expect(await sql`SELECT event FROM pay.payment_events WHERE payment_id = ${p.id} ORDER BY seq`).toEqual(events);
      expect((await sql`SELECT status FROM pay.payments WHERE id = ${p.id}`)[0]!.status).toBe('captured');
      expect(chain.outboundTransfers()).toHaveLength(outbound);

      // Nothing was lost: with the refusal lifted the same refund id goes through.
      const refunded = await open.refund(p.id, amt('4'), { refundId: 'r-x' });
      expect(refunded.refundedAmount).toBe(amt('4'));
    });
  });

  describe('beforeUserMoneyWithdrawal', () => {
    const moneyService = (parts: PartialPayGuards = {}, registry: RailRegistry = rails) =>
      new UserMoneyService(sql, ledger, registry, { operatorCreditRails: ['card-sandbox'], guards: composeGuards(parts) });
    const credit = (money: UserMoneyService) =>
      money.credit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'card-sandbox', railRef: 'psp_ref_1', creditedBy: OPERATOR });
    const request = (clientRef: string) => ({
      userId: USER,
      assetId: 'USDT',
      amount: amt('40'),
      rail: 'card-sandbox',
      destination: BANK,
      clientRef,
    });
    const available = async () => (await ledger.balance(userAvailable(USER, 'USDT'))).amount;

    it('a refusal runs before the claim, hold or rail and leaves nothing behind; lifting it lets the same clientRef through', async () => {
      await credit(moneyService());
      const journal = ledger.journal().length;
      for (const thrown of [new PayGuardRefusal('pay.guard_test_refused', 'refused'), new Error('relation "pay.caps" does not exist')]) {
        const seen: Array<{ journal: number; claims: number; replay: string }> = [];
        const money = moneyService({
          beforeUserMoneyWithdrawal: async (ctx) => {
            seen.push({
              journal: ledger.journal().length,
              claims: (await ctx.tx`SELECT 1 FROM pay.withdrawals`).length,
              replay: label(ctx.replay),
            });
            expect(ctx).toMatchObject({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', clientRef: 'w-refused' });
            throw thrown;
          },
        });
        const error = await money.withdraw(request('w-refused')).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PayGuardRefusal);
        expect(error).toMatchObject(
          thrown instanceof PayGuardRefusal ? { code: 'pay.guard_test_refused' } : { code: 'pay.guard_unavailable', kind: 'unavailable' },
        );
        expect(seen).toEqual([{ journal, claims: 0, replay: 'fresh' }]);
      }
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(0);
      expect(ledger.journal().length).toBe(journal);
      expect(await available()).toBe(amt('100'));

      const sent = await moneyService().withdraw(request('w-refused'));
      expect(sent.status).toBe('sent');
      expect(await available()).toBe(amt('60'));
    });

    const flakyRegistry = (mode: 'send-then-throw' | 'throw-before-send' | 'no-query') => {
      const flaky = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      const realPayout = flaky.payout.bind(flaky);
      const state = { calls: 0 };
      flaky.payout = async (instruction) => {
        state.calls += 1;
        if (state.calls === 1 && mode === 'send-then-throw') {
          await realPayout(instruction);
          throw new Error('rail connection dropped after the send');
        }
        if (state.calls === 1) throw new Error('rail connection dropped before the send');
        return realPayout(instruction);
      };
      if (mode === 'no-query') (flaky as { queryPayout?: unknown }).queryPayout = undefined;
      return { state, registry: new RailRegistry([flaky]) };
    };
    const heldStatus = async (clientRef: string) =>
      (await sql`SELECT status FROM pay.withdrawals WHERE client_ref = ${clientRef}`)[0]!.status;

    it('fresh on a new clientRef and replay once sent', async () => {
      const seen: string[] = [];
      const money = moneyService({ beforeUserMoneyWithdrawal: async (ctx) => void seen.push(label(ctx.replay)) });
      await credit(money);
      expect((await money.withdraw(request('w-sent'))).status).toBe('sent');
      expect((await money.withdraw(request('w-sent'))).status).toBe('sent');
      expect(seen).toEqual(['fresh', 'replay:withdrawal_already_sent']);
    });

    it('requested attempt the rail accepted: the retry settles once, payout stays at one call, a third call is a replay', async () => {
      const { state, registry } = flakyRegistry('send-then-throw');
      const seen: string[] = [];
      const money = moneyService({ beforeUserMoneyWithdrawal: async (ctx) => void seen.push(label(ctx.replay)) }, registry);
      await credit(money);
      await expect(money.withdraw(request('w-held'))).rejects.toThrow('rail connection dropped after the send');
      expect(await heldStatus('w-held')).toBe('held');
      expect(await available()).toBe(amt('60'));
      const done = await money.withdraw(request('w-held'));
      expect(done.status).toBe('sent');
      expect(done.railRef).toBeTruthy();
      expect(state.calls).toBe(1);
      expect(await available()).toBe(amt('60'));
      const again = await money.withdraw(request('w-held'));
      expect(again.status).toBe('sent');
      expect(state.calls).toBe(1);
      expect(await available()).toBe(amt('60'));
      expect(seen).toEqual(['fresh', 'recovery:withdrawal_hold_booked', 'replay:withdrawal_already_sent']);
    });

    it('requested attempt the rail never received: the retry reverses once, status failed, payout stays at one call', async () => {
      const { state, registry } = flakyRegistry('throw-before-send');
      const money = moneyService({}, registry);
      await credit(money);
      await expect(money.withdraw(request('w-lost'))).rejects.toThrow('rail connection dropped before the send');
      expect(await available()).toBe(amt('60'));
      await expect(money.withdraw(request('w-lost'))).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(state.calls).toBe(1);
      expect(await heldStatus('w-lost')).toBe('failed');
      expect(await available()).toBe(amt('100'));
      const [row] = await sql`SELECT failure_code FROM pay.withdrawals WHERE client_ref = 'w-lost'`;
      expect(row!.failure_code).toBe('rail.not_sent');
    });

    describe('crash window: attempt requested, rail answer lost', () => {
      const reasons = () => ledger.journal().map((tx) => tx.reason);
      const count = (reason: string) => reasons().filter((r) => r === reason).length;
      const holdBalance = async (id: string) =>
        (
          await ledger.balance(
            recipes.withdrawHold({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:0` })
              .entries[1]!.account,
          )
        ).amount;

      it('rail sent before the crash: repeats reach one settle, never a reverse; hold == settle + reverse, funds never stranded', async () => {
        const { state, registry } = flakyRegistry('send-then-throw');
        const money = moneyService({}, registry);
        await credit(money);
        await expect(money.withdraw(request('cw-sent'))).rejects.toThrow('dropped after the send');
        // Crash window: hold booked, attempt `requested`, no settle yet.
        expect(count('withdraw.held')).toBe(1);
        expect(count('withdraw.settled') + count('withdraw.reversed')).toBe(0);
        for (let i = 0; i < 3; i += 1) expect((await money.withdraw(request('cw-sent'))).status).toBe('sent');
        expect(state.calls).toBe(1);
        expect(count('withdraw.held')).toBe(1);
        expect(count('withdraw.settled')).toBe(1);
        expect(count('withdraw.reversed')).toBe(0);
        expect(count('withdraw.held')).toBe(count('withdraw.settled') + count('withdraw.reversed'));
        const [row] = await sql`SELECT id FROM pay.withdrawals WHERE client_ref = 'cw-sent'`;
        expect(await holdBalance(row!.id)).toBe(0n);
        expect(await available()).toBe(amt('60'));
      });

      it('rail never received it: the repeat reaches one reverse, never a settle; hold == settle + reverse, available restored', async () => {
        const { state, registry } = flakyRegistry('throw-before-send');
        const money = moneyService({}, registry);
        await credit(money);
        await expect(money.withdraw(request('cw-lost'))).rejects.toThrow('dropped before the send');
        expect(count('withdraw.held')).toBe(1);
        // The repeat resolves the requested attempt by status query: reverse once.
        // (A later call on the now-failed row is a NEW attempt by design, so it is not repeated here.)
        await expect(money.withdraw(request('cw-lost'))).rejects.toMatchObject({ code: 'pay.rail_failed' });
        expect(state.calls).toBe(1);
        expect(count('withdraw.reversed')).toBe(1);
        expect(count('withdraw.settled')).toBe(0);
        expect(count('withdraw.held')).toBe(count('withdraw.settled') + count('withdraw.reversed'));
        const [row] = await sql`SELECT id, status FROM pay.withdrawals WHERE client_ref = 'cw-lost'`;
        expect(row!.status).toBe('failed');
        expect(await holdBalance(row!.id)).toBe(0n);
        expect(await available()).toBe(amt('100'));
      });

      it('unknown or mismatched answer: the hold stays, nothing is settled or reversed', async () => {
        const flaky = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
        flaky.payout = async () => {
          throw new Error('dropped');
        };
        let mode: 'unknown' | 'mismatch' = 'unknown';
        flaky.queryPayout = async () =>
          mode === 'unknown'
            ? { status: 'unknown' as const }
            : { status: 'sent' as const, railRef: 'po_y', amount: amt('1'), assetId: 'USDT' };
        const money = moneyService({}, new RailRegistry([flaky]));
        await credit(money);
        await expect(money.withdraw(request('cw-unk'))).rejects.toThrow('dropped');
        await expect(money.withdraw(request('cw-unk'))).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
        mode = 'mismatch';
        await expect(money.withdraw(request('cw-unk'))).rejects.toMatchObject({ code: 'pay.rail_amount_mismatch' });
        expect(count('withdraw.held')).toBe(1);
        expect(count('withdraw.settled') + count('withdraw.reversed')).toBe(0);
        const [row] = await sql`SELECT id FROM pay.withdrawals WHERE client_ref = 'cw-unk'`;
        expect(await holdBalance(row!.id)).toBe(amt('40'));
        expect(await available()).toBe(amt('60'));
      });
    });

    it('requested attempt on a rail with no status query: outcome unknown, hold stays, payout stays at one call', async () => {
      const { state, registry } = flakyRegistry('no-query');
      const money = moneyService({}, registry);
      await credit(money);
      await expect(money.withdraw(request('w-noq'))).rejects.toThrow('rail connection dropped before the send');
      await expect(money.withdraw(request('w-noq'))).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
      await expect(money.withdraw(request('w-noq'))).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
      expect(state.calls).toBe(1);
      expect(await heldStatus('w-noq')).toBe('held');
      expect(await available()).toBe(amt('60'));
    });

    it('requested attempt whose status query throws or says unknown: hold stays', async () => {
      const flaky = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      const realPayout = flaky.payout.bind(flaky);
      let calls = 0;
      flaky.payout = async (instruction) => {
        calls += 1;
        if (calls === 1) throw new Error('rail connection dropped');
        return realPayout(instruction);
      };
      let answer: 'throw' | 'unknown' = 'throw';
      flaky.queryPayout = async () => {
        if (answer === 'throw') throw new Error('status query down');
        return { status: 'unknown' as const };
      };
      const money = moneyService({}, new RailRegistry([flaky]));
      await credit(money);
      await expect(money.withdraw(request('w-q'))).rejects.toThrow('rail connection dropped');
      await expect(money.withdraw(request('w-q'))).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
      answer = 'unknown';
      await expect(money.withdraw(request('w-q'))).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
      expect(calls).toBe(1);
      expect(await heldStatus('w-q')).toBe('held');
      expect(await available()).toBe(amt('60'));
    });

    it('requested attempt whose rail receipt names another amount: mismatch, hold stays', async () => {
      const flaky = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      flaky.payout = async () => {
        throw new Error('rail connection dropped');
      };
      flaky.queryPayout = async () => ({ status: 'sent' as const, railRef: 'po_x', amount: amt('39'), assetId: 'USDT' });
      const money = moneyService({}, new RailRegistry([flaky]));
      await credit(money);
      await expect(money.withdraw(request('w-mm'))).rejects.toThrow('rail connection dropped');
      await expect(money.withdraw(request('w-mm'))).rejects.toMatchObject({ code: 'pay.rail_amount_mismatch' });
      expect(await heldStatus('w-mm')).toBe('held');
      expect(await available()).toBe(amt('60'));
    });
  });

  describe('the wallet cap read counts the real holds (pay.withdrawals), fee included', () => {
    const live = (cap: string): WalletPublish => ({ ...failClosedWalletPublish(), withdrawalCap: () => cap });

    it('a held 0.6 carrying a 0.1 fee against a cap of 1 leaves 0.3; a finished or another asset row is not counted', async () => {
      const wallet = new WalletPay({ publish: live('1'), openHolds: openWithdrawalHolds(sql) });
      await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, network_id, quote_ref, fee)
        VALUES (${USER}, 'USDT', 0.6, 'crypto-native', ${sql.json(DEST as never)}, 'existing-hold', 'held', 'ethereum', 'q-held', 0.1)`;
      await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, rail_ref)
        VALUES (${USER}, 'USDT', 0.2, 'card-sandbox', ${sql.json(BANK as never)}, 'sent-one', 'sent', 'po_sent')`;
      await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
        VALUES (${USER}, 'ETH', 0.5, 'card-sandbox', ${sql.json(BANK as never)}, 'other-asset', 'pending')`;
      expect(await openWithdrawalHolds(sql)(USER, 'USDT')).toBe(amt('0.7'));
      expect(await wallet.remainingCap(USER, 'USDT')).toBe('0.3');
      expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(3);
    });

    it('a blank cap refuses pay.wallet_cap_unset', async () => {
      const wallet = new WalletPay({ publish: { ...live('1'), withdrawalCap: () => '  ' }, openHolds: openWithdrawalHolds(sql) });
      await expect(wallet.remainingCap(USER, 'USDT')).rejects.toMatchObject({ code: 'pay.wallet_cap_unset' });
    });
  });

  describe('supportReadWithdrawal (WAL-0162)', () => {
    it('returns the requested outcome and rail ref for the owner, forbids another user, and posts nothing', async () => {
      const money = new UserMoneyService(sql, ledger, rails, { operatorCreditRails: ['card-sandbox'] });
      const [row] = await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
        VALUES (${USER}, 'USDT', 5, 'card-sandbox', ${sql.json(BANK as never)}, 'support-read', 'held') RETURNING id`;
      await sql`INSERT INTO pay.withdrawal_rail_attempts(withdrawal_id, attempt, outcome) VALUES (${row!.id}, 0, 'requested')`;
      const journal = ledger.journal().length;
      const read = await money.supportReadWithdrawal(row!.id, USER);
      expect(read.attempts).toEqual([{ outcome: 'requested', railRef: null }]);
      expect(read.controls).toEqual([]);
      expect(read.label).toBe('unknown');
      expect(read.status).toBe('held');
      await sql`UPDATE pay.withdrawal_rail_attempts SET outcome = 'accepted', rail_ref = 'rail-9' WHERE withdrawal_id = ${row!.id}`;
      expect((await money.supportReadWithdrawal(row!.id, USER)).attempts).toEqual([{ outcome: 'accepted', railRef: 'rail-9' }]);
      await expect(money.supportReadWithdrawal(row!.id, OPERATOR)).rejects.toMatchObject({ code: 'pay.wallet_forbidden' });
      expect(ledger.journal().length).toBe(journal);
    });
  });
});
