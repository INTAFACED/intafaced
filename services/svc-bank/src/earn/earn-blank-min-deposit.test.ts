/**
 * An omitted earn-pool minimum deposit must not be stored as zero.
 * A blank limit is not zero. An explicit 0n still stores zero.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { parseAmount, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { EarnService } from './earn-service.js';

const POOL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

const fixedPool = {
  assetId: 'USDT',
  kind: 'fixed' as const,
  name: 'Fixed 90',
  aprBps: 2000,
  termDays: 90,
};

describe('earn pool minimum deposit is not a blank zero', () => {
  it('refuses an omitted minDeposit before insert', async () => {
    const { sql, captured } = fakeSql(() => {
      throw new Error('insert must not be reached');
    });
    const earn = service(sql);

    const err = await earn.createPool(fixedPool).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(BankError);
    expect((err as BankError).code).toBe('bank.below_minimum');
    expect((err as BankError).message).toMatch(/blank limit/);
    expect(poolInserts(captured)).toHaveLength(0);
  });

  it('stores an explicit zero minimum deposit as 0', async () => {
    const { sql, captured } = fakeSql((_text, values) => insertedPool(values));
    const earn = service(sql);

    await earn.createPool({ ...fixedPool, minDeposit: 0n });

    const insert = poolInserts(captured);
    expect(insert).toHaveLength(1);
    expect(insert[0]!.values[5]).toBe('0');
  });

  it("stores parseAmount('1') as 1", async () => {
    const { sql, captured } = fakeSql((_text, values) => insertedPool(values));
    const earn = service(sql);

    await earn.createPool({ ...fixedPool, minDeposit: parseAmount('1') });

    const insert = poolInserts(captured);
    expect(insert).toHaveLength(1);
    expect(insert[0]!.values[5]).toBe('1');
  });
});
