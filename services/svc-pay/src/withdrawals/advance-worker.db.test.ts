import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
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
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { MemoryChain } from '../rails/chain-port.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { RailRegistry } from '../rails/registry.js';
import { UserMoneyService, type WithdrawalRecord } from '../user-money-service.js';
import { listHeldSends, resolveWithdrawAdvanceConfig, runWithdrawAdvancePass } from './advance-worker.js';
import { WithdrawalQuoteService } from './quotes/service.js';
import { SendOutDoor } from './send-out/door.js';
import { assertWithdrawSignerPosture } from './send-out/signer-posture.js';

/**
 * W-withdraw-06 (J-wallet-05 #8) against a real Postgres: a send out of the platform answers `held` from the create, the
 * advance worker sends it, and it settles only once the chain holds it at the owner's minimum depth (TEST 6 here). TEST
 * figures only: a TEST network fee of 1.5 on top, TEST 300 USDT.
 *
 * The invariant every test ends on: available + what the hold keeps + what the rail took + the fee pot is the 300 deposited,
 * and the hold is either the whole total debit (still out) or nothing (settled or reversed).
 */
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

describe('a send out of the platform confirms later (W-withdraw-06, real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let memory: MemoryLedger;
  let flaky: ReturnType<typeof flakyLedger>;
  let chain: MemoryChain;
  let quotes: WithdrawalQuoteService;

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

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', `TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`);
    await sql`TRUNCATE pay.withdrawal_quotes, pay.withdrawal_quote_acceptances, pay.withdrawal_quote_policy_events RESTART IDENTITY CASCADE`;
    await sql`TRUNCATE pay.withdrawal_network_rules`;
    for (const assetId of ['USDT']) {
      await sql`
        INSERT INTO pay.withdrawal_network_rules (asset_id, network_id, minimum, maximum, step, tag, set_by)
        VALUES (${assetId}, 'ethereum', '0.01', '1000000', '0.01', 'none', 'founder-a')
        ON CONFLICT (asset_id, network_id) DO NOTHING`;
    }
    await sql`
      INSERT INTO pay.network_registry (network_id, display_name, asset_codes, enabled, fee_estimate_source, fee_estimate_amount, updated_by)
      VALUES ('ethereum', 'TEST ethereum', ${sql.json(['USDT'])}, true, 'fixed', '1.5', 'founder-a')
      ON CONFLICT (network_id) DO UPDATE SET asset_codes = EXCLUDED.asset_codes, fee_estimate_amount = EXCLUDED.fee_estimate_amount`;
    memory = new MemoryLedger();
    flaky = flakyLedger(memory);
    // No blocks on their own: each test sets the depth the chain answers (`setSendDepth`).
    chain = new MemoryChain({ blockMs: 3_600_000 });
    quotes = new WithdrawalQuoteService({ sql });
    await quotes.setPolicy('founder-a', { feeMode: 'on_top', ttlSeconds: 90 });
    await memory.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('300'), rail: RAIL, railRef: 'seed-user' }));
  }, 30_000);

  function money(options: { confirmLater?: boolean; on?: MemoryChain } = {}): UserMoneyService {
    const rails = new RailRegistry([
      new CryptoNativeAdapter({ chain: options.on ?? chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
    ]);
    const sendOut = new SendOutDoor({
      signer: assertWithdrawSignerPosture({ APP_ENV: 'test', PAY_TEST_WITHDRAW_SIGNER_NETWORKS: 'ethereum' }),
      destinations: { check: async () => ({ state: 'ready', destinationId: null, coolingOffEndsAt: null }) },
    });
    return new UserMoneyService(sql, flaky.ledger, rails, { operatorCreditRails: [], sendOut, confirmLater: options.confirmLater ?? true });
  }

  const send = async (service: UserMoneyService, clientRef: string, amount = '25') => {
    await quotes.quote(USER, { quoteRef: `q-${clientRef}`, assetId: 'USDT', networkId: 'ethereum', amount });
    return service.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt(amount),
      rail: RAIL,
      destination: { kind: 'crypto', ref: ADDRESS },
      clientRef,
      networkId: 'ethereum',
      quoteRef: `q-${clientRef}`,
    });
  };

  const available = async (): Promise<Amount> => (await memory.balance(userAvailable(USER, 'USDT'))).amount;
  const feePot = async (): Promise<Amount> => (await memory.balance(houseFees('pay', 'USDT'))).amount;
  // The deposit drew 300 from the rail boundary; a settle hands what left back to it.
  const railOut = async (): Promise<Amount> => amt('300') + (await memory.balance(railBoundary(RAIL, 'USDT'))).amount;
  const held = async (w: Pick<WithdrawalRecord, 'id'>, attempt = 0): Promise<Amount> =>
    (await memory.balance(withdrawalHoldAccount(USER, 'USDT', `${w.id}:${attempt}`))).amount;
  const key = (w: Pick<WithdrawalRecord, 'id'>, attempt = 0) => `pay.payout:${w.id}:${attempt}`;
  const journal = async (w: Pick<WithdrawalRecord, 'id'>) =>
    (
      await sql<Array<{ outcome: string; confirmations: number | null }>>`
      SELECT outcome, confirmations FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${w.id} ORDER BY attempt`
    )[0] ?? null;
  const codeOf = async (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'resolved',
      (e: { code?: string }) => e.code ?? String(e),
    );

  /** Nothing is made or lost: the 300 is in available, a hold, the rail's outbound or the fee pot, and nowhere twice. */
  async function invariant(...withdrawals: Array<Pick<WithdrawalRecord, 'id'>>): Promise<void> {
    let holds = 0n;
    for (const w of withdrawals) holds += await held(w);
    expect((await available()) + holds + (await railOut()) + (await feePot())).toBe(amt('300'));
  }

  it('the create books the hold and answers held, cancellable, with nothing asked of the chain; a retry reads the same', async () => {
    const service = money();
    const made = await send(service, 'w-1');
    expect(made).toMatchObject({ status: 'held', networkId: 'ethereum', fee: FEE, journal: null, dispatchJournaled: true });
    expect(await held(made)).toBe(amt('26.5'));
    expect(await available()).toBe(amt('273.5'));
    expect(await chain.lookupSend(key(made))).toMatchObject({ state: 'not_sent' });
    expect(chain.outboundTransfers()).toEqual([]);
    const again = await send(service, 'w-1');
    expect(again).toMatchObject({ id: made.id, status: 'held', journal: null });
    expect(await held(made)).toBe(amt('26.5'));
    await invariant(made);
    // Nothing is journalled, so the hold can still be given back whole.
    const canceled = await service.cancelWithdrawal({ userId: USER, withdrawalId: made.id });
    expect(canceled).toMatchObject({ holdReleased: true });
    expect(await available()).toBe(amt('300'));
    await invariant(made);
  });

  it('the worker sends it, holds it while the chain is shallow, shows broadcast then confirming, and settles once at the minimum', async () => {
    const service = money();
    const made = await send(service, 'w-1');
    chain.setSendDepth(key(made), 0);
    const first = await service.advanceWithdrawal(made.id);
    expect(first).toMatchObject({ status: 'held', journal: 'accepted' });
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await journal(made)).toEqual({ outcome: 'accepted', confirmations: 0 });
    expect((await service.getWithdrawal(made.id)).journal).toBe('accepted');
    expect(await held(made)).toBe(amt('26.5'));
    await invariant(made);

    chain.setSendDepth(key(made), 5);
    expect(await service.advanceWithdrawal(made.id)).toMatchObject({ status: 'held', journal: 'confirming' });
    expect((await service.getWithdrawal(made.id)).journal).toBe('confirming');
    expect(await journal(made)).toEqual({ outcome: 'accepted', confirmations: 5 });
    // Never sent twice while it waits for depth.
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await railOut()).toBe(0n);

    chain.setSendDepth(key(made), 6);
    const settled = await service.advanceWithdrawal(made.id);
    expect(settled).toMatchObject({ status: 'sent' });
    expect(await held(made)).toBe(0n);
    expect(await railOut()).toBe(amt('25'));
    expect(await feePot()).toBe(FEE);
    expect(await available()).toBe(amt('273.5'));
    // A later pass on the settled row returns it and posts nothing again.
    expect(await service.advanceWithdrawal(made.id)).toMatchObject({ status: 'sent' });
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await railOut()).toBe(amt('25'));
    await invariant(made);
  });

  it('a send the chain refuses when the worker sends it is put back whole and fails with the chain’s code', async () => {
    const refusing = new MemoryChain({ blockMs: 3_600_000, refuseAmount: amt('13') });
    const service = money({ on: refusing });
    const made = await send(service, 'w-13', '13');
    expect(made).toMatchObject({ status: 'held' });
    expect(await held(made)).toBe(amt('14.5'));
    expect(await codeOf(service.advanceWithdrawal(made.id))).toBe('pay.rail_failed');
    expect(await service.getWithdrawal(made.id)).toMatchObject({ status: 'failed', failureCode: 'rail.refused' });
    expect(await held(made)).toBe(0n);
    expect(await available()).toBe(amt('300'));
    expect(await feePot()).toBe(0n);
    await invariant(made);
  });

  it('a send whose depth the chain cannot say stays held, is never reversed and is never sent again', async () => {
    const service = money();
    const made = await send(service, 'w-1');
    chain.setSendDepth(key(made), 0);
    await service.advanceWithdrawal(made.id);
    const blind = Object.assign(Object.create(Object.getPrototypeOf(chain)), chain) as MemoryChain;
    blind.sendDepth = async () => null;
    const unsure = money({ on: blind });
    expect(await unsure.advanceWithdrawal(made.id)).toMatchObject({ status: 'held', journal: 'accepted' });
    // The last depth read stays; nothing was given back and nothing left twice.
    expect(await journal(made)).toEqual({ outcome: 'accepted', confirmations: 0 });
    expect(await held(made)).toBe(amt('26.5'));
    expect(chain.outboundTransfers()).toHaveLength(1);
    await invariant(made);
  });

  it('a crash after the chain is deep enough and before the settle is finished by the next pass, once', async () => {
    const service = money();
    const made = await send(service, 'w-1');
    chain.setSendDepth(key(made), 6);
    flaky.fail({
      reason: recipes.withdrawSettle({
        userId: USER,
        assetId: 'USDT',
        amount: amt('25'),
        rail: RAIL,
        withdrawalId: `${made.id}:0`,
        fee: FEE,
        feeAssetId: 'USDT',
      }).reason,
      when: 'after',
    });
    expect(await codeOf(service.advanceWithdrawal(made.id))).toBe('pay.ledger_outcome_unknown');
    expect(await service.advanceWithdrawal(made.id)).toMatchObject({ status: 'sent' });
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await railOut()).toBe(amt('25'));
    expect(await held(made)).toBe(0n);
    await invariant(made);
  });

  it('without the worker a create still sends in the request, and still settles only at the depth', async () => {
    const service = money({ confirmLater: false });
    await quotes.quote(USER, { quoteRef: 'q-w-1', assetId: 'USDT', networkId: 'ethereum', amount: '25' });
    const pending = await service.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt('25'),
      rail: RAIL,
      destination: { kind: 'crypto', ref: ADDRESS },
      clientRef: 'w-1',
      networkId: 'ethereum',
      quoteRef: 'q-w-1',
    });
    expect(pending).toMatchObject({ status: 'held', journal: 'accepted' });
    expect(chain.outboundTransfers()).toHaveLength(1);
    const [row] = await sql<Array<{ id: string }>>`SELECT id FROM pay.withdrawals`;
    chain.setSendDepth(key(row!), 6);
    expect(await service.advanceWithdrawal(row!.id)).toMatchObject({ status: 'sent' });
    await invariant(row!);
  });

  describe('the worker pass', () => {
    it('takes on a held send only once it has stood one tick, and counts each outcome', async () => {
      const service = money();
      const made = await send(service, 'w-1');
      expect(await listHeldSends(sql, 20, null, 60_000)).toEqual([]);
      expect((await listHeldSends(sql, 20, null, 0)).map((r) => r.withdrawalId)).toEqual([made.id]);
      chain.setSendDepth(key(made), 0);
      expect(await runWithdrawAdvancePass(sql, service, { batchLimit: 20 })).toMatchObject({ examined: 1, waiting: 1, settled: 0 });
      chain.setSendDepth(key(made), 6);
      expect(await runWithdrawAdvancePass(sql, service, { batchLimit: 20 })).toMatchObject({ examined: 1, settled: 1 });
      expect(await runWithdrawAdvancePass(sql, service, { batchLimit: 20 })).toMatchObject({ examined: 0 });
      await invariant(made);
    });

    it('is off with a named blocker when either setting is blank, never defaulted', () => {
      expect(resolveWithdrawAdvanceConfig({})).toMatchObject({ mode: 'off', blocker: 'pay.withdraw_advance_interval_unset' });
      expect(resolveWithdrawAdvanceConfig({ intervalMs: 3000 })).toMatchObject({
        mode: 'off',
        blocker: 'pay.withdraw_advance_batch_limit_unset',
      });
      expect(resolveWithdrawAdvanceConfig({ intervalMs: 3000, batchLimit: 20 })).toEqual({ mode: 'on', intervalMs: 3000, batchLimit: 20 });
    });
  });
});
