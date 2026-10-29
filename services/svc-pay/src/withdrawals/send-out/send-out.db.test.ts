import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { BankSendDestinationResult } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  houseFees,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWithdrawalLimitGuards } from '../../limits/guards.js';
import { truncatePayForTest } from '../../payment-events-test-reset.js';
import { ChainNotConfiguredError, MemoryChain } from '../../rails/chain-port.js';
import { CryptoNativeAdapter } from '../../rails/crypto-native.js';
import { RailRegistry } from '../../rails/registry.js';
import { NOOP_GUARDS, composeGuards, type PayGuards } from '../../seams/guards.js';
import { UserMoneyService, type WithdrawalRecord } from '../../user-money-service.js';
import type { PurchaseHoldGuard } from '../purchase-holds/service.js';
import { WithdrawalQuoteService } from '../quotes/service.js';
import { SendOutDoor } from './door.js';
import { setWithdrawFeeUnboundSink, type WithdrawFeeUnboundAlert } from './fee-unbound.js';
import { assertWithdrawSignerPosture } from './signer-posture.js';

/**
 * J-wallet-05 #6, #4 and #7 against a real Postgres (issue #6517): a send out of the platform needs a custody signer for its
 * network, an address saved and ready on that network, and an accepted quote whose fee rides the hold, the settle and every
 * reverse. TEST figures only: a TEST network fee of 1.5 on top, TEST 300 USDT.
 *
 * The invariant every test ends on: what left `available` is exactly the quote's total debit (or nothing), the fee pot got
 * exactly the quoted fee (or nothing), and no withdrawal hold keeps a remainder.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_send_out_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-send-out-test-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const FEE = amt('1.5');
const RAIL = 'crypto-native';

type Plan = { reason: string; when: 'before' | 'after' | 'fee_unbound' };

/** A ledger that loses one post's answer: `before` posts nothing and throws, `after` posts and then throws (ack lost). */
function flakyLedger(inner: MemoryLedger): { ledger: LedgerClient; fail: (plan: Plan) => void } {
  const plans: Plan[] = [];
  const ledger = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'post') {
        return async (request: PostRequest) => {
          const at = plans.findIndex((p) => p.reason === request.reason);
          if (at === -1) return target.post(request);
          const [plan] = plans.splice(at, 1);
          // svc-ledger's fee binding door: refuses before anything posts, with its own code.
          if (plan!.when === 'fee_unbound')
            throw new LedgerError('A withdrawal fee must match its posted hold', 'ledger.withdraw_fee_unbound');
          if (plan!.when === 'after') await target.post(request);
          throw new Error(`ledger answer lost (${plan!.when} ${request.reason})`);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as LedgerClient;
  return { ledger, fail: (plan) => plans.push(plan) };
}

describe('a send out of the platform: signer, saved address, quote and fee (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let memory: MemoryLedger;
  let flaky: ReturnType<typeof flakyLedger>;
  let chain: MemoryChain;
  let rails: RailRegistry;
  let quotes: WithdrawalQuoteService;
  let quoteClock: () => Date;
  let book: Map<string, BankSendDestinationResult>;
  let asked: Array<{ network: string; ref: string }>;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function network(id: string, fee = '1.5', assets = ['USDT', 'ETH']): Promise<void> {
    // TEST rules for each asset on the network (W-withdraw-02), wide enough for every amount these tests quote.
    for (const assetId of assets) {
      await sql`
        INSERT INTO pay.withdrawal_network_rules (asset_id, network_id, minimum, maximum, step, tag, set_by)
        VALUES (${assetId}, ${id}, '0.01', '1000000', '0.01', 'none', 'founder-a')
        ON CONFLICT (asset_id, network_id) DO NOTHING`;
    }
    await sql`
      INSERT INTO pay.network_registry (network_id, display_name, asset_codes, enabled, fee_estimate_source, fee_estimate_amount, updated_by)
      VALUES (${id}, ${`TEST ${id}`}, ${sql.json(assets)}, true, 'fixed', ${fee}, 'founder-a')
      ON CONFLICT (network_id) DO UPDATE SET asset_codes = EXCLUDED.asset_codes, fee_estimate_amount = EXCLUDED.fee_estimate_amount`;
  }

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', `TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`);
    await sql`TRUNCATE pay.withdrawal_quotes, pay.withdrawal_quote_acceptances, pay.withdrawal_quote_policy_events RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE pay.withdrawal_network_rules`;
    memory = new MemoryLedger();
    flaky = flakyLedger(memory);
    chain = new MemoryChain();
    rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
    quoteClock = () => new Date();
    quotes = new WithdrawalQuoteService({ sql, now: () => quoteClock() });
    await quotes.setPolicy('founder-a', { feeMode: 'on_top', ttlSeconds: 90 });
    await network('ethereum');
    await network('base');
    book = new Map();
    asked = [];
    await memory.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('300'), rail: RAIL, railRef: 'seed-user' }));
  }, 30_000);

  function money(guards: PayGuards = NOOP_GUARDS, purchaseHolds?: PurchaseHoldGuard): UserMoneyService {
    const sendOut = new SendOutDoor({
      // TEST signer on TEST Ethereum only, as the local stack connects it; TEST Base has none (J-wallet-05 #7).
      signer: assertWithdrawSignerPosture({ APP_ENV: 'test', PAY_TEST_WITHDRAW_SIGNER_NETWORKS: 'ethereum' }),
      destinations: {
        check: async (input) => {
          asked.push({ network: input.network, ref: input.ref });
          return book.get(input.network) ?? { state: 'ready', destinationId: null, coolingOffEndsAt: null };
        },
      },
    });
    return new UserMoneyService(sql, flaky.ledger, rails, { operatorCreditRails: [], sendOut, guards, purchaseHolds });
  }

  const quote = (quoteRef: string, amount = '25', networkId = 'ethereum', assetId = 'USDT', userId = USER) =>
    quotes.quote(userId, { quoteRef, assetId, networkId, amount });

  const send = (
    service: UserMoneyService,
    clientRef: string,
    quoteRef: string | undefined,
    over: Partial<{ amount: string; networkId: string }> = {},
  ) =>
    service.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt(over.amount ?? '25'),
      rail: RAIL,
      destination: { kind: 'crypto', ref: ADDRESS },
      clientRef,
      networkId: over.networkId ?? 'ethereum',
      quoteRef,
    });

  const available = async (): Promise<string> => formatAmount((await memory.balance(userAvailable(USER, 'USDT'))).amount);
  const feePot = async (): Promise<string> => formatAmount((await memory.balance(houseFees('pay', 'USDT'))).amount);
  const held = async (w: Pick<WithdrawalRecord, 'id'>, attempt = 0): Promise<Amount> =>
    (await memory.balance(withdrawalHoldAccount(USER, 'USDT', `${w.id}:${attempt}`))).amount;
  const rows = async () =>
    sql<Array<{ id: string; status: string; network_id: string | null; quote_ref: string | null; fee: string | null; attempts: number }>>`
      SELECT id, status, network_id, quote_ref, fee::text AS fee, attempts FROM pay.withdrawals ORDER BY created_at`;
  const acceptedBy = async (quoteRef: string): Promise<string | null> => (await quotes.get(USER, quoteRef)).acceptedBy;
  const codeOf = async (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'resolved',
      (e: { code?: string }) => e.code ?? String(e),
    );

  /** Nothing moved, nothing recorded, the quote still free. */
  async function nothingHappened(quoteRef?: string): Promise<void> {
    expect(await available()).toBe('300');
    expect(await feePot()).toBe('0');
    expect(await rows()).toEqual([]);
    if (quoteRef) expect(await acceptedBy(quoteRef)).toBeNull();
  }

  describe('a send that goes (J-wallet-05 #6)', () => {
    it('takes exactly the quote’s total debit from available, sends the amount, and puts the fee in the pay fee pot', async () => {
      const service = money();
      const q = await quote('q-1');
      expect(q.totalDebit).toBe('26.5');
      const sent = await send(service, 'w-1', 'q-1');
      expect(sent).toMatchObject({ status: 'sent', networkId: 'ethereum', quoteRef: 'q-1', fee: FEE, amount: amt('25') });
      // The invariant: what left the balance is the quote's total debit; the fee pot got the fee; the rail took the amount.
      expect(amt('300') - amt(await available())).toBe(amt(q.totalDebit));
      expect(await feePot()).toBe(q.feeTotal);
      expect((await memory.balance(railBoundary(RAIL, 'USDT'))).amount).toBe(amt('-275'));
      expect(await held(sent)).toBe(0n);
      expect(await rows()).toMatchObject([{ status: 'sent', network_id: 'ethereum', quote_ref: 'q-1', fee: '1.500000000000000000' }]);
      expect(await acceptedBy('q-1')).toBe('w-1');
      expect(await chain.lookupSend(`pay.payout:${sent.id}:0`)).toMatchObject({ state: 'sent', amount: amt('25') });
      // The fee rides the hold and the settle, both named in the journal.
      const hold = await memory.getTxByKey(`withdraw.hold:${sent.id}:0`);
      const settle = await memory.getTxByKey(`withdraw.settle:${sent.id}:0`);
      expect(hold?.meta).toMatchObject({ fee: '1.5' });
      expect(settle?.meta).toMatchObject({ fee: '1.5' });
      expect(asked).toEqual([{ network: 'ethereum', ref: ADDRESS }]);
    });

    it('a retry on the same reference returns the same withdrawal and takes nothing twice; another quote on it conflicts', async () => {
      const service = money();
      await quote('q-1');
      await quote('q-2');
      const first = await send(service, 'w-1', 'q-1');
      const again = await send(service, 'w-1', 'q-1');
      expect(again.id).toBe(first.id);
      expect(await available()).toBe('273.5');
      expect(await codeOf(send(service, 'w-1', 'q-2'))).toBe('pay.withdrawal_conflict');
      expect(await acceptedBy('q-2')).toBeNull();
      expect(await feePot()).toBe('1.5');
    });

    it('a quoted send on a reference an unquoted withdrawal already holds is a typed conflict, never a raw constraint error', async () => {
      const service = money();
      await quote('q-1');
      // A row from before quoted sends: no network, no quote and no fee.
      await sql`
        INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
        VALUES (${USER}, 'USDT', 25, ${RAIL}, ${sql.json({ kind: 'crypto', ref: ADDRESS })}, 'w-old', 'pending')`;
      expect(await codeOf(send(service, 'w-old', 'q-1'))).toBe('pay.withdrawal_conflict');
      expect(await acceptedBy('q-1')).toBeNull();
      expect(await available()).toBe('300');
      expect(await rows()).toMatchObject([{ status: 'pending', quote_ref: null, fee: null }]);
    });
  });

  describe('no custody signer for the network (J-wallet-05 #7)', () => {
    it('refuses by name before anything is held, the address book is asked nothing, and the quote stays free', async () => {
      const service = money();
      await quote('q-base', '25', 'base');
      expect(await codeOf(send(service, 'w-base', 'q-base', { networkId: 'base' }))).toBe('pay.wallet_withdraw_unavailable');
      await nothingHappened('q-base');
      expect(asked).toEqual([]);
    });
  });

  describe('the address must be saved, approved and ready on that network', () => {
    it.each([
      ['not_saved', 'pay.withdrawal_destination_not_saved'],
      ['other_network', 'pay.withdrawal_destination_network_mismatch'],
      ['approval_pending', 'pay.withdrawal_destination_unapproved'],
      ['cooling', 'pay.withdrawal_destination_cooling'],
      ['cooling_unset', 'pay.withdrawal_destination_cooling_unset'],
      ['locked', 'pay.withdrawal_destination_locked'],
      ['blocked', 'pay.withdrawal_destination_blocked'],
      ['unavailable', 'pay.withdrawal_destination_unavailable'],
    ] as const)('an address book answer of %s refuses %s, with nothing held', async (state, code) => {
      book.set(
        'ethereum',
        state === 'unavailable'
          ? { state, code: 'bank.send_destination_unavailable' }
          : { state, destinationId: null, coolingOffEndsAt: state === 'cooling' ? '2026-10-30T00:00:00.000Z' : null },
      );
      await quote('q-1');
      expect(await codeOf(send(money(), 'w-1', 'q-1'))).toBe(code);
      await nothingHappened('q-1');
      expect(asked).toEqual([{ network: 'ethereum', ref: ADDRESS }]);
    });
  });

  describe('the quote must be this send’s, unused and in time', () => {
    it('a send with no quote refuses withdrawal_quote.required', async () => {
      expect(await codeOf(send(money(), 'w-1', undefined))).toBe('withdrawal_quote.required');
      await nothingHappened();
    });

    it('an unknown quote, and another person’s quote, refuse withdrawal_quote.not_found', async () => {
      await quote('q-theirs', '25', 'ethereum', 'USDT', OTHER);
      expect(await codeOf(send(money(), 'w-1', 'q-none'))).toBe('withdrawal_quote.not_found');
      expect(await codeOf(send(money(), 'w-2', 'q-theirs'))).toBe('withdrawal_quote.not_found');
      await nothingHappened();
    });

    it('an expired quote refuses withdrawal_quote.expired', async () => {
      quoteClock = () => new Date(Date.now() - 91_000);
      await quote('q-old');
      expect(await codeOf(send(money(), 'w-1', 'q-old'))).toBe('withdrawal_quote.expired');
      await nothingHappened('q-old');
    });

    it('a quote another withdrawal used refuses withdrawal_quote.already_used, and only the first is sent', async () => {
      const service = money();
      await quote('q-1');
      await send(service, 'w-1', 'q-1');
      expect(await codeOf(send(service, 'w-2', 'q-1'))).toBe('withdrawal_quote.already_used');
      expect(await available()).toBe('273.5');
      expect(await rows()).toHaveLength(1);
      expect(await acceptedBy('q-1')).toBe('w-1');
    });

    it('two claims racing for one quote under two references: one is sent, the other refused already_used, never a raw error', async () => {
      const service = money();
      await quote('q-1');
      const results = await Promise.all(
        ['w-a', 'w-b'].map((ref) => codeOf(send(service, ref, 'q-1').then(() => Promise.reject({ code: 'sent' })))),
      );
      expect(results.sort()).toEqual(['sent', 'withdrawal_quote.already_used']);
      expect(await rows()).toHaveLength(1);
      expect(await available()).toBe('273.5');
    });

    it.each([
      ['another amount', () => quote('q-1', '24'), {}],
      ['another network', () => quote('q-1', '25', 'base'), {}],
      ['another asset', () => quote('q-1', '25', 'ethereum', 'ETH'), {}],
    ] as const)('a quote for %s refuses withdrawal_quote.terms_differ', async (_case, make, over) => {
      await make();
      expect(await codeOf(send(money(), 'w-1', 'q-1', over))).toBe('withdrawal_quote.terms_differ');
      await nothingHappened('q-1');
    });

    it('a quote that takes its fee out of the amount refuses withdrawal_quote.fee_mode_unsupported rather than guess', async () => {
      await quotes.setPolicy('founder-a', { feeMode: 'deducted', ttlSeconds: 90 });
      await quote('q-1');
      expect(await codeOf(send(money(), 'w-1', 'q-1'))).toBe('withdrawal_quote.fee_mode_unsupported');
      await nothingHappened('q-1');
    });

    it('a refusal later in the claim accepts nothing, and the purchase hold check counts the fee the hold takes', async () => {
      // TEST: 274 of the 300 bought by card and still held, so 26 may leave. 25 alone would fit; 25 and its 1.5 fee do not.
      const holds: PurchaseHoldGuard = {
        held: async () => ({ heldAmount: amt('274'), periodSet: true, earliestReleaseAt: '2026-11-01T00:00:00.000Z' }),
      };
      await quote('q-1');
      expect(await codeOf(send(money(NOOP_GUARDS, holds), 'w-1', 'q-1'))).toBe('pay.withdrawal_amount_held');
      await nothingHappened('q-1');
    });

    it('a balance too small for amount and fee: the ledger refuses the hold, nothing leaves, and the claim cancels with nothing to give back', async () => {
      const service = money();
      await quote('q-big', '299');
      expect(await codeOf(send(service, 'w-big', 'q-big', { amount: '299' }))).toBe('pay.ledger_outcome_unknown');
      expect(await available()).toBe('300');
      expect(await feePot()).toBe('0');
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'pending', fee: '1.500000000000000000' });
      expect((await service.cancelWithdrawal({ userId: USER, withdrawalId: row!.id })).holdReleased).toBe(false);
      expect(await available()).toBe('300');
    });
  });

  describe('the same fee on every way back (cancel, refusal, dropped send) and through every crash point', () => {
    it('a cancel of a held withdrawal gives back amount and fee', async () => {
      const service = money();
      await quote('q-1');
      const pending = await service.withdraw(
        {
          userId: USER,
          assetId: 'USDT',
          amount: amt('25'),
          rail: RAIL,
          destination: { kind: 'crypto', ref: ADDRESS },
          clientRef: 'w-1',
          networkId: 'ethereum',
          quoteRef: 'q-1',
        },
        { stopAfterHold: true },
      );
      expect(await available()).toBe('273.5');
      expect(await held(pending)).toBe(amt('26.5'));
      const canceled = await service.cancelWithdrawal({ userId: USER, withdrawalId: pending.id });
      expect(canceled.holdReleased).toBe(true);
      expect(await available()).toBe('300');
      expect(await held(pending)).toBe(0n);
      expect(await feePot()).toBe('0');
      expect((await memory.getTxByKey(`withdraw.reverse:${pending.id}:0`))?.meta).toMatchObject({ fee: '1.5' });
    });

    it('a rail refusal gives back amount and fee; the next attempt on the same reference carries the same fee', async () => {
      const service = money();
      await quote('q-1');
      chain.failNextBroadcast(new ChainNotConfiguredError('send'));
      expect(await codeOf(send(service, 'w-1', 'q-1'))).toBe('pay.rail_failed');
      expect(await available()).toBe('300');
      expect(await feePot()).toBe('0');
      expect(await rows()).toMatchObject([{ status: 'failed', attempts: 1, fee: '1.500000000000000000' }]);
      // The quote has expired by now in the real world; the next attempt keeps the fee the claim accepted, it is not asked again.
      quoteClock = () => new Date(Date.now() + 3_600_000);
      const sent = await send(service, 'w-1', 'q-1');
      expect(sent).toMatchObject({ status: 'sent', attempts: 1, fee: FEE });
      expect(await available()).toBe('273.5');
      expect(await feePot()).toBe('1.5');
      expect(await held(sent, 0)).toBe(0n);
      expect(await held(sent, 1)).toBe(0n);
    });

    it('a dropped send reversed by the custody desk gives back amount and fee', async () => {
      const service = money();
      await quote('q-1');
      chain.failNextBroadcast(new Error('chain rpc unavailable'));
      expect(await codeOf(send(service, 'w-1', 'q-1'))).not.toBe('resolved');
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'held' });
      expect(await available()).toBe('273.5');
      await service.reverseDroppedWithdrawal({ withdrawalId: row!.id, expectedAttempt: 0 });
      expect(await available()).toBe('300');
      expect(await feePot()).toBe('0');
      expect(await held(row!)).toBe(0n);
    });

    it.each([
      ['the hold posted and its answer was lost', { reason: 'withdraw.held', when: 'after' }, 'pay.ledger_outcome_unknown', '273.5'],
      ['the hold never reached the ledger', { reason: 'withdraw.held', when: 'before' }, 'pay.ledger_outcome_unknown', '300'],
      [
        'the rail sent and the settle never reached the ledger',
        { reason: 'withdraw.settled', when: 'before' },
        'pay.ledger_outcome_unknown',
        '273.5',
      ],
      [
        'the rail sent and the settle answer was lost',
        { reason: 'withdraw.settled', when: 'after' },
        'pay.ledger_outcome_unknown',
        '273.5',
      ],
    ] as const)('crash when %s: nothing stranded, and the retry finishes with the same fee', async (_case, plan, code, between) => {
      const service = money();
      await quote('q-1');
      flaky.fail(plan);
      expect(await codeOf(send(service, 'w-1', 'q-1'))).toBe(code);
      // Whose funds, and where: either still in available, or in this withdrawal's own hold, fee included.
      expect(await available()).toBe(between);
      const sent = await send(service, 'w-1', 'q-1');
      expect(sent.status).toBe('sent');
      expect(await available()).toBe('273.5');
      expect(await feePot()).toBe('1.5');
      expect(await held(sent)).toBe(0n);
      expect(await chain.lookupSend(`pay.payout:${sent.id}:0`)).toMatchObject({ state: 'sent', amount: amt('25') });
    });

    it('a settle the ledger refuses for its fee is a definite refusal with an alert, not an unknown outcome; the hold stays', async () => {
      const alerts: WithdrawFeeUnboundAlert[] = [];
      setWithdrawFeeUnboundSink((alert) => alerts.push(alert));
      try {
        const service = money();
        await quote('q-1');
        flaky.fail({ reason: 'withdraw.settled', when: 'fee_unbound' });
        expect(await codeOf(send(service, 'w-1', 'q-1'))).toBe('pay.withdrawal_fee_unbound');
        const [row] = await rows();
        expect(row).toMatchObject({ status: 'held' });
        expect(alerts).toEqual([expect.objectContaining({ withdrawalId: row!.id, step: 'settle' })]);
        expect(await available()).toBe('273.5');
        expect(await held(row!)).toBe(amt('26.5'));
        expect(await feePot()).toBe('0');
      } finally {
        setWithdrawFeeUnboundSink(null);
      }
    });

    it('a refusal whose reverse answer was lost finishes the reverse once on the retry, fee included', async () => {
      const service = money();
      await quote('q-1');
      chain.failNextBroadcast(new ChainNotConfiguredError('send'));
      flaky.fail({ reason: 'withdraw.reversed', when: 'after' });
      expect(await codeOf(send(service, 'w-1', 'q-1'))).not.toBe('resolved');
      expect(await available()).toBe('300');
      expect(await codeOf(send(service, 'w-1', 'q-1'))).toBe('pay.rail_failed');
      expect(await available()).toBe('300');
      expect(await feePot()).toBe('0');
      expect(await rows()).toMatchObject([{ status: 'failed', attempts: 1 }]);
    });
  });

  describe('two sends at once that together pass the 24-hour limit (J-wallet-05 #4)', () => {
    const limitGuards = () =>
      createWithdrawalLimitGuards({
        sql,
        env: {
          PAY_WITHDRAWAL_LIMITS: 'required',
          PAY_WITHDRAWAL_LIMITS_BY_TIER: JSON.stringify({ basic: { USDT: { perTx: '10', rolling24h: '15' } } }),
        },
        tierOf: async () => 'basic',
        overrideOf: async () => null,
      });

    it('the 24-hour figure counts what left the balance, fee included; the per-withdrawal figure is the amount sent', async () => {
      const service = money(composeGuards(limitGuards()));
      await quote('q-a', '10');
      await quote('q-b', '3.5');
      // 10 is the most one withdrawal may send: its 1.5 fee does not make it 11.5 against that figure.
      expect((await send(service, 'w-a', 'q-a', { amount: '10' })).status).toBe('sent');
      // 11.5 left the balance; 3.5 and its fee (5) would make 16.5 of 15. Counting amounts alone (13.5) would let it go.
      expect(await codeOf(send(service, 'w-b', 'q-b', { amount: '3.5' }))).toBe('pay.guard_withdrawal_limit_exceeded');
      expect(await acceptedBy('q-b')).toBeNull();
      expect(await available()).toBe('288.5');
    });

    it('exactly one goes through; the other holds nothing and leaves its quote free', async () => {
      // TEST limits, illustrative only: 10 a withdrawal, 15 a day.
      const limits = createWithdrawalLimitGuards({
        sql,
        env: {
          PAY_WITHDRAWAL_LIMITS: 'required',
          PAY_WITHDRAWAL_LIMITS_BY_TIER: JSON.stringify({ basic: { USDT: { perTx: '10', rolling24h: '15' } } }),
        },
        tierOf: async () => 'basic',
        overrideOf: async () => null,
      });
      const service = money(composeGuards(limits));
      await quote('q-a', '9');
      await quote('q-b', '9');
      const results = await Promise.all([
        codeOf(send(service, 'w-a', 'q-a', { amount: '9' }).then(() => Promise.reject({ code: 'sent' }))),
        codeOf(send(service, 'w-b', 'q-b', { amount: '9' }).then(() => Promise.reject({ code: 'sent' }))),
      ]);
      expect(results.filter((r) => r === 'sent')).toHaveLength(1);
      expect(results.filter((r) => r === 'pay.guard_withdrawal_limit_exceeded')).toHaveLength(1);
      expect(await available()).toBe('289.5');
      expect(await feePot()).toBe('1.5');
      expect(await rows()).toHaveLength(1);
      const accepted = [await acceptedBy('q-a'), await acceptedBy('q-b')];
      expect(accepted.filter((ref) => ref === null)).toHaveLength(1);
    });
  });
});
