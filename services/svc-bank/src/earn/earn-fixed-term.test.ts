/**
 * A fixed pool with no positive term must not be stored, and a deposit must
 * not open a position against one. Withdraw only locks while matures_at is
 * still in the future, so a blank term is an immediate withdrawal.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { EarnService } from './earn-service.js';

const POOL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const POSITION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface Captured {
  calls: Array<{ text: string; values: unknown[] }>;
}

function fakeSql(handler: (text: string, values: unknown[]) => unknown): { sql: Sql; captured: Captured } {
  const captured: Captured = { calls: [] };
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    captured.calls.push({ text, values });
    return Promise.resolve(handler(text, values));
  };
  return { sql: Object.assign(fn, { json: (v: unknown) => v }) as unknown as Sql, captured };
}

function service(sql: Sql): EarnService {
  return new EarnService(sql, {} as LedgerClient, { nativeAssetId: 'IFC' });
}

function poolInserts(captured: Captured): Array<{ text: string; values: unknown[] }> {
  return captured.calls.filter((call) => call.text.includes('INSERT INTO bank.earn_pools'));
}

function positionInserts(captured: Captured): Array<{ text: string; values: unknown[] }> {
  return captured.calls.filter((call) => call.text.includes('INSERT INTO bank.earn_positions'));
}

function insertedPool(values: unknown[]) {
  return [
    {
      id: POOL_ID,
      asset_id: values[0],
      kind: values[1],
      name: values[2],
      apr_bps: String(values[3]),
      term_days: values[4],
      min_deposit: String(values[5]),
      status: 'open',
    },
  ];
}

function expectTermRequired(err: unknown): void {
  expect(err).toBeInstanceOf(BankError);
  expect((err as BankError).code).toBe('bank.term_required');
  expect((err as BankError).message).toMatch(/a blank term is not an open-ended lock/);
}

describe('fixed earn term is required', () => {
  it('refuses a fixed pool that omits termDays before insert', async () => {
    const { sql, captured } = fakeSql(() => {
      throw new Error('insert must not be reached');
    });
    const earn = service(sql);

    expectTermRequired(await earn.createPool({ assetId: 'USDT', kind: 'fixed', name: 'Fixed', aprBps: 1000, minDeposit: 0n }).catch((err: unknown) => err));
    expect(poolInserts(captured)).toHaveLength(0);
  });

  it.each([null, 0, -1])('refuses a fixed pool with termDays %s before insert', async (termDays) => {
    const { sql, captured } = fakeSql(() => {
      throw new Error('insert must not be reached');
    });
    const earn = service(sql);

    expectTermRequired(
      await earn.createPool({ assetId: 'USDT', kind: 'fixed', name: 'Fixed', aprBps: 1000, termDays, minDeposit: 0n }).catch((err: unknown) => err),
    );
    expect(poolInserts(captured)).toHaveLength(0);
  });

  it('stores 90 for a fixed pool with termDays 90', async () => {
    const { sql, captured } = fakeSql((_text, values) => insertedPool(values));
    const earn = service(sql);

    const pool = await earn.createPool({
      assetId: 'USDT',
      kind: 'fixed',
      name: 'Fixed 90',
      aprBps: 2000,
      termDays: 90,
      minDeposit: 0n,
    });

    expect(poolInserts(captured)).toHaveLength(1);
    expect(poolInserts(captured)[0]!.values[4]).toBe(90);
    expect(pool.termDays).toBe(90);
  });

  it('stores null for a flexible pool that omits termDays', async () => {
    const { sql, captured } = fakeSql((_text, values) => insertedPool(values));
    const earn = service(sql);

    const pool = await earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 500, minDeposit: 0n });

    expect(poolInserts(captured)).toHaveLength(1);
    expect(poolInserts(captured)[0]!.values[4]).toBeNull();
    expect(pool.termDays).toBeNull();
  });

  it.each([null, 0])('refuses a deposit into a fixed pool whose termDays is %s', async (termDays) => {
    const row = {
      id: POOL_ID,
      asset_id: 'USDT',
      kind: 'fixed' as const,
      name: 'Fixed',
      apr_bps: '1000',
      term_days: termDays,
      min_deposit: '0',
      status: 'open' as const,
    };
    const { sql, captured } = fakeSql((text) => {
      if (text.includes('FROM bank.earn_pools')) return [row];
      if (text.includes('INSERT INTO bank.earn_positions')) return [{ id: POSITION_ID }];
      throw new Error(`unexpected query: ${text}`);
    });
    const earn = service(sql);

    expectTermRequired(
      await earn.deposit({ poolId: POOL_ID, userId: USER, amount: 1n, positionId: POSITION_ID }).catch((err: unknown) => err),
    );
    expect(positionInserts(captured)).toHaveLength(0);
  });
});
