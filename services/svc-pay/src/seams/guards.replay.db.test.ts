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
import { UserMoneyService } from '../user-money-service.js';
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

    it('fresh on a new clientRef, replay once sent, and a requested attempt is not asked again', async () => {
      const flaky = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      const realPayout = flaky.payout.bind(flaky);
      let fail = true;
      let calls = 0;
      flaky.payout = async (instruction) => {
        calls += 1;
        if (fail) {
          fail = false;
          throw new Error('rail connection dropped after the hold');
        }
        return realPayout(instruction);
      };
      flaky.queryPayout = async () => ({ status: 'unknown' });
      const registry = new RailRegistry([flaky]);
      const seen: string[] = [];
      const money = moneyService({ beforeUserMoneyWithdrawal: async (ctx) => void seen.push(label(ctx.replay)) }, registry);
      await credit(money);

      // The hold is booked and the attempt stays `requested` because the rail
      // threw. WAL-0163: that retry must not call the rail again.
      await expect(money.withdraw(request('w-held'))).rejects.toThrow('rail connection dropped');
      expect((await sql`SELECT status FROM pay.withdrawals WHERE client_ref = 'w-held'`)[0]!.status).toBe('held');
      await expect(money.withdraw(request('w-held'))).rejects.toMatchObject({ code: 'pay.rail_outcome_unknown' });
      expect(calls).toBe(1);
      expect(await available()).toBe(amt('60'));

      const sent = await money.withdraw(request('w-sent'));
      expect(sent.status).toBe('sent');
      const again = await money.withdraw(request('w-sent'));
      expect(again.status).toBe('sent');
      expect(calls).toBe(2);
      expect(seen).toEqual(['fresh', 'recovery:withdrawal_hold_booked', 'fresh', 'replay:withdrawal_already_sent']);
    });
  });
});
