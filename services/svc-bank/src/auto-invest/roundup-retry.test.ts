/**
 * Duplicate card-round-up client run id.
 *
 * Settled with a position id returns that position and does not deposit again.
 * Pending and rejected retry earn.deposit on the same run id. A deposit
 * refusal stays refused with that code, not skipped as
 * bank.auto_invest_run_failed.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  InsufficientFundsError,
  formatAmount,
  parseAmount,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { EarnService } from '../earn/earn-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import { AutoInvestService, spareChange } from './auto-invest-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POOL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRIOR_POSITION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AUTHORIZATION_ID = 'auth-roundup-1';

const spare = spareChange(parseAmount('4.30'), parseAmount('1'));

type PriorStatus = 'pending' | 'settled' | 'rejected' | 'skipped';

type DepositCall = {
  poolId: string;
  userId: string;
  amount: Amount;
  positionId: string;
};

type SqlUpdate = { query: string; values: readonly unknown[] };

function roundUpSql(prior: { id: string; status: PriorStatus; position_id: string | null }): {
  sql: Sql;
  updates: SqlUpdate[];
} {
  const updates: SqlUpdate[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ');
    if (query.includes('INSERT INTO bank.auto_invest_runs')) return Promise.resolve([]);
    if (query.includes('FROM bank.auto_invest_rules')) {
      return Promise.resolve([
        {
          id: RULE_ID,
          user_id: USER_ID,
          kind: 'card_roundup',
          asset_id: 'USDT',
          threshold: null,
          target_pool_id: POOL_ID,
          buy_asset_id: null,
          amount: '1',
          cadence: null,
          next_run_at: null,
          status: 'active',
          created_at: new Date('2026-10-01T00:00:00.000Z'),
        },
      ]);
    }
    if (query.includes('FROM bank.auto_invest_runs')) return Promise.resolve([prior]);
    if (query.includes('UPDATE bank.auto_invest_runs')) {
      updates.push({ query, values });
      return Promise.resolve([]);
    }
    throw new Error(`unexpected query: ${query}`);
  };
  return { sql: Object.assign(fn, { json: (v: unknown) => v }) as unknown as Sql, updates };
}

function serviceFor(
  prior: { id: string; status: PriorStatus; position_id: string | null },
  deposit: (input: DepositCall) => Promise<{ id: string }>,
): { svc: AutoInvestService; calls: DepositCall[]; updates: SqlUpdate[] } {
  const calls: DepositCall[] = [];
  const { sql, updates } = roundUpSql(prior);
  const earn = {
    deposit: async (input: DepositCall) => {
      calls.push(input);
      return deposit(input);
    },
  } as unknown as EarnService;
  const svc = new AutoInvestService(sql, {} as LedgerClient, earn, {} as SpaceService);
  return { svc, calls, updates };
}

function apply(svc: AutoInvestService) {
  return svc.applyRoundUp({
    userId: USER_ID,
    assetId: 'USDT',
    authorizationId: AUTHORIZATION_ID,
    captured: parseAmount('4.30'),
  });
}

describe('applyRoundUp duplicate client run id', () => {
  it('a settled row with a position id does not deposit again', async () => {
    const { svc, calls } = serviceFor({ id: RUN_ID, status: 'settled', position_id: PRIOR_POSITION_ID }, async () => {
      throw new Error('deposit must not run');
    });

    const outcome = await apply(svc);

    expect(calls).toHaveLength(0);
    expect(outcome).toEqual({ status: 'settled', amount: spare, positionId: PRIOR_POSITION_ID });
  });

  it('a pending row deposits once with that run id and settles', async () => {
    const { svc, calls, updates } = serviceFor({ id: RUN_ID, status: 'pending', position_id: null }, async (input) => ({
      id: input.positionId,
    }));

    const outcome = await apply(svc);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ poolId: POOL_ID, userId: USER_ID, positionId: RUN_ID, amount: spare });
    expect(typeof calls[0]!.amount).toBe('bigint');
    expect(outcome).toEqual({ status: 'settled', amount: spare, positionId: RUN_ID });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.query).toContain("status = 'settled'");
    expect(updates[0]!.values).toContain(RUN_ID);
    expect(updates[0]!.values).toContain(formatAmount(spare));
    expect(updates[0]!.values.every((value) => typeof value !== 'number')).toBe(true);
  });

  it('a rejected row deposits once with that same run id and settles', async () => {
    const { svc, calls, updates } = serviceFor(
      { id: RUN_ID, status: 'rejected', position_id: null },
      async (input) => ({ id: input.positionId }),
    );

    const outcome = await apply(svc);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.positionId).toBe(RUN_ID);
    expect(calls[0]!.amount).toBe(spare);
    expect(outcome).toEqual({ status: 'settled', amount: spare, positionId: RUN_ID });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.query).toContain("status = 'settled'");
    expect(updates[0]!.values).toContain(RUN_ID);
    expect(updates[0]!.values).toContain(formatAmount(spare));
  });

  it('a pending row whose deposit refuses stays refused with that code', async () => {
    const { svc, calls, updates } = serviceFor({ id: RUN_ID, status: 'pending', position_id: null }, async () => {
      throw new BankError('Pool is closed', 'bank.pool_closed');
    });

    const outcome = await apply(svc);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.positionId).toBe(RUN_ID);
    expect(outcome).toEqual({ status: 'refused', amount: spare, reason: 'bank.pool_closed' });
    expect(outcome).not.toMatchObject({ status: 'skipped', reason: 'bank.auto_invest_run_failed' });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.query).toContain("status = 'rejected'");
    expect(updates[0]!.values).toContain('bank.pool_closed');
    expect(updates[0]!.values).toContain(RUN_ID);
  });

  it('a rejected row whose deposit refuses stays refused with the deposit code', async () => {
    const { svc, calls, updates } = serviceFor({ id: RUN_ID, status: 'rejected', position_id: null }, async () => {
      throw new InsufficientFundsError('user-available', 'USDT', formatAmount(spare), '0');
    });

    const outcome = await apply(svc);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.positionId).toBe(RUN_ID);
    expect(outcome).toEqual({ status: 'refused', amount: spare, reason: 'ledger.insufficient_funds' });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toContain('ledger.insufficient_funds');
    expect(updates[0]!.values).toContain(RUN_ID);
    expect(updates[0]!.query).toMatch(/status IN \('pending', 'rejected'\)/);
  });

  it('a skipped duplicate does not deposit', async () => {
    const { svc, calls } = serviceFor({ id: RUN_ID, status: 'skipped', position_id: null }, async () => {
      throw new Error('deposit must not run');
    });

    const outcome = await apply(svc);

    expect(calls).toHaveLength(0);
    expect(outcome).toEqual({ status: 'skipped', amount: spare, reason: 'bank.auto_invest_run_failed' });
  });
});
