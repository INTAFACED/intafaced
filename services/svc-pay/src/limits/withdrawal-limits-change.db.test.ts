import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  ACTION_APPROVAL_PAYLOAD_MISMATCH,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from '../action-approval-consume.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { PayGuardRefusal, composeGuards } from '../seams/guards.js';
import { UserMoneyService } from '../user-money-service.js';
import { createWithdrawalLimitGuards, type KycTierOf } from './guards.js';
import type { LimitOverrideOf } from './identity-override.js';
import { createWithdrawalLimitReader } from './reader.js';
import { createSqlLimitSource } from './source.js';

/**
 * Owner-set withdrawal limits (W-withdraw-05): the founder change path, its audit
 * trail, and the guard and allowance read that use the stored figures. Real
 * Postgres, every forward migration, the real router.
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
    .withDatabase('intafaced_withdrawal_limit_change_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const SECOND = 'founder-b';
const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'svc-pay-withdrawal-limit-change-secret-at-least-32-chars';

type Err = { code: string; message?: string; cause?: { code?: string } };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

describe('owner-set withdrawal limits (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let approver: string | null = SECOND;
  let consumed: ActionApprovalConsumeInput[] = [];
  let bindHash: string | null = null;

  const approvals: ActionApprovalConsumer = {
    async consume(input) {
      consumed.push(input);
      if (bindHash !== null && input.payloadHash !== bindHash) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', ACTION_APPROVAL_PAYLOAD_MISMATCH);
      }
      if (approver === null) return unwiredApprovalConsumer().consume(input);
      return stubApprovalConsumer(approver).consume(input);
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const lim = () => api.founderAdmin.limits;
  const approval = { approvalId: 'appr-1', operationId: 'op-1' };

  let ledger: MemoryLedger;
  let rails: RailRegistry;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const reader = createWithdrawalLimitReader({
      sql: db.sql,
      source: createSqlLimitSource(),
      mode: 'required',
      tierOf: async () => 'basic',
      overrideOf: async () => null,
    });
    const ns = createPayNamespaces({ founderAuthority: async () => FOUNDER, limits: { sql: db.sql, approvals, reader } });
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = ns.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    approver = SECOND;
    consumed = [];
    bindHash = null;
    await db.sql.unsafe(`ALTER TABLE pay.withdrawal_limit_events DISABLE TRIGGER withdrawal_limit_events_append_only_trg`);
    await db.sql.unsafe(`TRUNCATE pay.withdrawal_limit_events, pay.withdrawal_limits RESTART IDENTITY CASCADE`);
    await db.sql.unsafe(`ALTER TABLE pay.withdrawal_limit_events ENABLE TRIGGER withdrawal_limit_events_append_only_trg`);
    await truncatePayForTest(db.sql, 'pay', `TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`);
    ledger = new MemoryLedger();
    rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }), new BankPayoutAbsentAdapter()]);
  }, 30_000);

  // TEST figures, illustrative only.
  const set = (o: Record<string, unknown> = {}) => ({
    tier: 'basic',
    assetId: 'USDT',
    limit: { perTx: '10', rolling24h: '15' },
    expectedVersion: null,
    reason: 'initial figures',
    ...o,
  });
  const events = () => db.sql<Array<Record<string, any>>>`SELECT * FROM pay.withdrawal_limit_events ORDER BY seq`;

  describe('schema', () => {
    it('refuses zero, half-set, inverted and unknown-tier rows at the database too', async () => {
      const bad = (per: string | null, roll: string | null, tier = 'basic') =>
        db.sql`INSERT INTO pay.withdrawal_limits (tier, asset_id, per_tx, rolling_24h, updated_by) VALUES (${tier}, 'USDT', ${per}, ${roll}, 'f')`;
      await expect(bad('0', '5')).rejects.toMatchObject({ constraint_name: 'withdrawal_limits_per_tx_decimal' });
      await expect(bad('5', '0')).rejects.toMatchObject({ code: '23514' });
      await expect(bad('5', null)).rejects.toMatchObject({ constraint_name: 'withdrawal_limits_both_or_neither' });
      await expect(bad('20', '10')).rejects.toMatchObject({ constraint_name: 'withdrawal_limits_per_tx_within_rolling' });
      await expect(bad('5', '10', 'gold')).rejects.toMatchObject({ constraint_name: 'withdrawal_limits_tier_known' });
    });

    it('the audit trail is append-only', async () => {
      await lim().change(set({ ...approval }));
      await expect(db.sql`UPDATE pay.withdrawal_limit_events SET reason = 'edited'`).rejects.toMatchObject({ code: '23001' });
      await expect(db.sql`DELETE FROM pay.withdrawal_limit_events`).rejects.toMatchObject({ code: '23001' });
    });
  });

  describe('founderAdmin.limits.change', () => {
    it('setting a limit waits for a second founder: no approval, no write', async () => {
      approver = null;
      const err = await refused(lim().change(set()));
      expect(err.code).toBe('PRECONDITION_FAILED');
      expect(await lim().list()).toEqual([]);
      expect(await events()).toHaveLength(0);
    });

    it('with a second founder it is stored, audited with both ids, and bound to the exact change', async () => {
      const preview = await lim().preview(set());
      const view = await lim().change(set({ ...approval }));
      expect(view).toMatchObject({
        tier: 'basic',
        assetId: 'USDT',
        limit: { perTx: '10', rolling24h: '15' },
        version: 1,
        updatedBy: FOUNDER,
      });
      const [e] = await events();
      expect(e).toMatchObject({ action: 'set', actor_id: FOUNDER, approver_id: SECOND, dual_control: true, before: null });
      expect(e?.after).toEqual({ perTx: '10', rolling24h: '15' });
      expect(consumed[0]?.payloadHash).toBe(preview.payloadHash);
    });

    it('an approval for different figures is refused: the hash binds the exact change', async () => {
      const preview = await lim().preview(set());
      bindHash = preview.payloadHash;
      const err = await refused(lim().change(set({ ...approval, limit: { perTx: '10', rolling24h: '9999' } })));
      expect(err.code).toBe('PRECONDITION_FAILED');
      expect(await lim().list()).toEqual([]);
    });

    it('the proposer cannot approve their own change', async () => {
      approver = FOUNDER;
      const err = await refused(lim().change(set({ ...approval })));
      expect(err.code).toBe('PRECONDITION_FAILED');
      expect(await lim().list()).toEqual([]);
    });

    it('a raise needs a second founder; a cut and a clear do not', async () => {
      await lim().change(set({ ...approval }));
      approver = null;
      const raise = await refused(
        lim().change(set({ expectedVersion: 1, limit: { perTx: '11', rolling24h: '15' }, reason: 'raise per tx' })),
      );
      expect(raise.code).toBe('PRECONDITION_FAILED');
      const raiseRolling = await refused(
        lim().change(set({ expectedVersion: 1, limit: { perTx: '10', rolling24h: '16' }, reason: 'raise rolling' })),
      );
      expect(raiseRolling.code).toBe('PRECONDITION_FAILED');

      const cut = await lim().change(set({ expectedVersion: 1, limit: { perTx: '5', rolling24h: '12' }, reason: 'tighten' }));
      expect(cut).toMatchObject({ limit: { perTx: '5', rolling24h: '12' }, version: 2 });
      const cleared = await lim().change(set({ expectedVersion: 2, limit: null, reason: 'withdraw the figure' }));
      expect(cleared).toMatchObject({ limit: null, version: 3 });

      const rows = await events();
      expect(rows.map((r) => [r.action, r.dual_control])).toEqual([
        ['set', true],
        ['set', false],
        ['clear', false],
      ]);
      expect(rows[2]?.before).toEqual({ perTx: '5', rolling24h: '12' });
      expect(rows[2]?.after).toBeNull();
    });

    it('re-setting a cleared limit needs a second founder again', async () => {
      await lim().change(set({ ...approval }));
      await lim().change(set({ expectedVersion: 1, limit: null, reason: 'clear it' }));
      approver = null;
      const err = await refused(lim().change(set({ expectedVersion: 2, reason: 'set it back' })));
      expect(err.code).toBe('PRECONDITION_FAILED');
    });

    it('refuses a stale version, a duplicate create, a missing entry and a change that changes nothing', async () => {
      await lim().change(set({ ...approval }));
      expect((await refused(lim().change(set({ expectedVersion: 7, limit: { perTx: '1', rolling24h: '2' } })))).cause?.code).toBe(
        'limits.version_conflict',
      );
      expect((await refused(lim().change(set({ ...approval })))).cause?.code).toBe('limits.already_exists');
      expect((await refused(lim().change(set({ tier: 'full', expectedVersion: 1 })))).cause?.code).toBe('limits.not_found');
      expect((await refused(lim().change(set({ expectedVersion: 1, ...approval })))).cause?.code).toBe('limits.unchanged');
    });

    it('refuses zero, a per-transaction figure above the rolling one, a sixth tier and a number instead of a string', async () => {
      expect((await refused(lim().change(set({ ...approval, limit: { perTx: '0', rolling24h: '5' } })))).cause?.code).toBe(
        'limits.amount_invalid',
      );
      expect((await refused(lim().change(set({ ...approval, limit: { perTx: '20', rolling24h: '5' } })))).cause?.code).toBe(
        'limits.per_tx_above_rolling',
      );
      await expect(lim().change(set({ ...approval, tier: 'gold' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(lim().change(set({ ...approval, limit: { perTx: 10, rolling24h: 15 } }))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await events()).toHaveLength(0);
    });

    it('two founders racing on one version: exactly one write lands', async () => {
      await lim().change(set({ ...approval }));
      const run = (perTx: string) =>
        lim()
          .change(set({ expectedVersion: 1, limit: { perTx, rolling24h: '15' }, reason: `cut to ${perTx}` }))
          .then(
            () => 'ok',
            (e: Err) => e.cause?.code ?? e.code,
          );
      const results = await Promise.all([run('4'), run('3')]);
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'limits.version_conflict')).toHaveLength(1);
      expect(await events()).toHaveLength(2);
    });

    it('history is newest first and can be narrowed to one tier', async () => {
      await lim().change(set({ ...approval }));
      await lim().change(set({ tier: 'full', limit: { perTx: '50', rolling24h: '60' }, ...approval }));
      expect((await lim().history({ limit: 10 })).map((e: { tier: string }) => e.tier)).toEqual(['full', 'basic']);
      expect(await lim().history({ tier: 'basic', limit: 10 })).toHaveLength(1);
    });
  });

  describe('the guard and the allowance read use the stored figures', () => {
    const basic: KycTierOf = async () => 'basic';
    const source = () => createSqlLimitSource();
    const noOverride: LimitOverrideOf = async () => null;
    /** `null` leaves the override read unwired. */
    const money = (tierOf?: KycTierOf, mode: 'off' | 'required' = 'required', overrideOf: LimitOverrideOf | null = noOverride) =>
      new UserMoneyService(db.sql, ledger, rails, {
        operatorCreditRails: ['card-sandbox'],
        guards: composeGuards(
          createWithdrawalLimitGuards({ sql: db.sql, mode, source: source(), tierOf, overrideOf: overrideOf ?? undefined }),
        ),
        withdrawalLimits: createWithdrawalLimitReader({ sql: db.sql, source: source(), mode, tierOf, overrideOf: overrideOf ?? undefined }),
      });
    const fund = (service: UserMoneyService) =>
      service.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('500'),
        rail: 'card-sandbox',
        railRef: 'seed',
        creditedBy: '99999999-9999-4999-8999-999999999999',
      });
    const request = (amount: string, clientRef: string) => ({
      userId: USER,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'card-sandbox',
      destination: { kind: 'bank', ref: 'DE89370400440532013000' },
      clientRef,
    });
    const refusal = async (p: Promise<unknown>): Promise<PayGuardRefusal> => {
      const error = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PayGuardRefusal);
      return error as PayGuardRefusal;
    };

    it('nothing stored: the withdrawal and the read both refuse, and nothing is held', async () => {
      const service = money(basic);
      await fund(service);
      expect((await refusal(service.withdraw(request('1', 'blank')))).code).toBe('pay.guard_withdrawal_limit_unset');
      expect((await refusal(service.withdrawalAllowance(USER, 'USDT'))).code).toBe('pay.guard_withdrawal_limit_unset');
      expect(await db.sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
    });

    it('a founder sets it, the withdrawal passes up to the figure, and the read says what is left', async () => {
      const service = money(basic);
      await fund(service);
      await lim().change(set({ ...approval }));
      expect(await service.withdrawalAllowance(USER, 'USDT')).toEqual({
        tier: 'basic',
        assetId: 'USDT',
        base: { perTx: '10', rolling24h: '15' },
        override: null,
        perTx: '10',
        rolling24h: '15',
        used24h: '0',
        remaining: { perTx: '10', rolling24h: '15' },
        maxNow: '10',
      });
      expect((await service.withdraw(request('10', 'a'))).status).toBe('sent');
      expect(await service.withdrawalAllowance(USER, 'USDT')).toMatchObject({
        used24h: '10',
        remaining: { perTx: '10', rolling24h: '5' },
        maxNow: '5',
      });
      const hit = await refusal(service.withdraw(request('6', 'b')));
      expect(hit.code).toBe('pay.guard_withdrawal_limit_exceeded');
      expect(hit.remaining).toEqual({ perTx: '10', rolling24h: '5' });
    });

    it('the published list (the verification ladder) shows only figures a founder set, and a clear takes it off', async () => {
      const service = money(basic);
      expect(await service.withdrawalTierLimits()).toEqual({ enforced: true, limits: [] });
      await lim().change(set({ ...approval }));
      await lim().change(set({ tier: 'full', limit: { perTx: '50', rolling24h: '60' }, ...approval }));
      expect(await service.withdrawalTierLimits()).toEqual({
        enforced: true,
        limits: [
          { tier: 'basic', assetId: 'USDT', perTx: '10', rolling24h: '15' },
          { tier: 'full', assetId: 'USDT', perTx: '50', rolling24h: '60' },
        ],
      });
      await lim().change(set({ expectedVersion: 1, limit: null, reason: 'withdraw the figure' }));
      expect((await service.withdrawalTierLimits()).limits.map((l) => l.tier)).toEqual(['full']);
      // With limits not applied in this deployment the figures still list, marked as not enforced.
      expect(await money(basic, 'off').withdrawalTierLimits()).toMatchObject({ enforced: false, limits: [{ tier: 'full' }] });
    });

    it('a cut applies to the next withdrawal; a clear refuses again', async () => {
      const service = money(basic);
      await fund(service);
      await lim().change(set({ ...approval }));
      await lim().change(set({ expectedVersion: 1, limit: { perTx: '3', rolling24h: '15' }, reason: 'tighten' }));
      expect((await refusal(service.withdraw(request('4', 'c')))).code).toBe('pay.guard_withdrawal_limit_exceeded');
      await lim().change(set({ expectedVersion: 2, limit: null, reason: 'withdraw the figure' }));
      expect((await refusal(service.withdraw(request('1', 'd')))).code).toBe('pay.guard_withdrawal_limit_unset');
    });

    it('a raise that waits for a second founder changes nothing until it lands', async () => {
      const service = money(basic);
      await fund(service);
      await lim().change(set({ ...approval }));
      approver = null;
      await refused(lim().change(set({ expectedVersion: 1, limit: { perTx: '100', rolling24h: '150' }, reason: 'raise' })));
      expect((await refusal(service.withdraw(request('11', 'e')))).code).toBe('pay.guard_withdrawal_limit_exceeded');
    });

    it('every state that can still move value counts toward the rolling 24 hours; failed and canceled do not', async () => {
      const service = money(basic);
      await fund(service);
      await lim().change(set({ ...approval, limit: { perTx: '10', rolling24h: '12' } }));
      const insert = (status: string, ref: string) =>
        db.sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
               VALUES (${USER}, 'USDT', 4, 'card-sandbox', ${db.sql.json({ kind: 'bank', ref: 'DE89370400440532013000' })}, ${ref}, ${status}::pay.withdrawal_status)`;
      // `pending_review`, `broadcast` and `canceled` are not states yet (W-withdraw-06/07). A deny-list counts them the day they are.
      for (const state of ['pending_review', 'broadcast', 'canceled']) {
        await db.sql.unsafe(`ALTER TYPE pay.withdrawal_status ADD VALUE IF NOT EXISTS '${state}'`);
      }
      await insert('pending_review', 'r1');
      await insert('broadcast', 'r2');
      await insert('canceled', 'r3');
      await insert('failed', 'r4');
      expect(await service.withdrawalAllowance(USER, 'USDT')).toMatchObject({ used24h: '8', remaining: { rolling24h: '4' }, maxNow: '4' });
      expect((await refusal(service.withdraw(request('5', 'f')))).code).toBe('pay.guard_withdrawal_limit_exceeded');
    });

    it('the read refuses where the guard would: limits off, tier source dark or unwired', async () => {
      await lim().change(set({ ...approval }));
      expect((await refusal(money(basic, 'off').withdrawalAllowance(USER, 'USDT'))).code).toBe('pay.guard_withdrawal_limits_off');
      expect((await refusal(money(undefined).withdrawalAllowance(USER, 'USDT'))).code).toBe('pay.guard_withdrawal_tier_unwired');
      const dark: KycTierOf = async () => {
        throw new Error('identity unreachable');
      };
      expect((await refusal(money(dark).withdrawalAllowance(USER, 'USDT'))).code).toBe('pay.guard_unavailable');
    });

    it('a founder override shows beside the base and is what the read and the guard apply until it ends', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      let override: LimitOverrideOf = async () => ({ perTx: amt('25'), rolling24h: null, expiresAt });
      const service = money(basic, 'required', (userId, assetId) => override(userId, assetId));
      await fund(service);
      await lim().change(set({ ...approval }));
      expect(await service.withdrawalAllowance(USER, 'USDT')).toEqual({
        tier: 'basic',
        assetId: 'USDT',
        base: { perTx: '10', rolling24h: '15' },
        override: { perTx: '25', rolling24h: null, expiresAt: expiresAt.toISOString() },
        perTx: '25',
        rolling24h: '15',
        used24h: '0',
        remaining: { perTx: '25', rolling24h: '15' },
        maxNow: '15',
      });
      expect((await service.withdraw(request('12', 'o1'))).status).toBe('sent');
      override = noOverride;
      expect(await service.withdrawalAllowance(USER, 'USDT')).toMatchObject({
        override: null,
        perTx: '10',
        remaining: { rolling24h: '3' },
      });
      expect((await refusal(money(basic, 'required', null).withdrawalAllowance(USER, 'USDT'))).code).toBe(
        'pay.guard_withdrawal_override_unwired',
      );
    });

    it('founderAdmin.limits.customer reads one customer the way the guard does, and refuses with its codes', async () => {
      await expect(lim().customer({ userId: USER, assetId: 'USDT' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'pay.guard_withdrawal_limit_unset',
      });
      await lim().change(set({ ...approval }));
      await expect(lim().customer({ userId: USER, assetId: 'USDT' })).resolves.toMatchObject({
        tier: 'basic',
        base: { perTx: '10', rolling24h: '15' },
        override: null,
        maxNow: '10',
      });
      await expect(lim().customer({ userId: 'not-a-user', assetId: 'USDT' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('a service with no reader wired refuses rather than answering', async () => {
      const bare = new UserMoneyService(db.sql, ledger, rails, { operatorCreditRails: [] });
      expect((await refusal(bare.withdrawalAllowance(USER, 'USDT'))).code).toBe('pay.guard_withdrawal_limits_unwired');
    });
  });
});
