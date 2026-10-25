import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { TokenService } from './token-service.js';

/**
 * The publish door drops this process's cached ladder. A discount read that was already waiting on the database when
 * the publish landed must not put the ladder it replaced back into that cache: for the next minute this process would
 * charge a discount the row no longer holds.
 */

const OLD = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 100 }] };
const NEW = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 900 }] };

function gatedSql() {
  let row: unknown = OLD;
  let hold: Promise<void> | null = null;
  let release = () => {};
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('SELECT fee_discount_schedule')) {
      const seen = row;
      // A discount read sees the row as it was when it reached the database, then waits as a slow round trip would.
      // The publish's own locking read is not held.
      const wait = q.includes('FOR UPDATE') ? null : hold;
      return (wait ?? Promise.resolve()).then(() => [{ fee_discount_schedule: seen }]);
    }
    if (q.includes('UPDATE token.token_params SET fee_discount_schedule')) {
      row = (values[0] as { value: unknown }).value;
      return Promise.resolve([]);
    }
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as Sql;
  Object.assign(sql, {
    json: (value: unknown) => ({ value }),
    begin: (_mode: string, fn: (tx: Sql) => Promise<unknown>) => fn(sql),
  });
  return {
    sql,
    holdReads() {
      hold = new Promise<void>((resolve) => (release = resolve));
    },
    releaseReads() {
      hold = null;
      release();
    },
  };
}

describe('publishing the fee-decay ladder while a discount read is in flight', () => {
  it('does not cache the replaced ladder: the next read charges the published one', async () => {
    const db = gatedSql();
    const token = new TokenService(db.sql, new MemoryLedger(), new MemoryEventBus('svc-token'), {
      assetId: 'IFC',
      loadParamsFromDb: true,
      feeScheduleTtlMs: 60_000,
    });
    const version = (await token.feeDiscountScheduleRow()).version;

    db.holdReads();
    const inFlight = token.feeDiscountSchedule();
    await token.publishFeeDiscountSchedule({ schedule: NEW, expectedVersion: version });
    db.releaseReads();
    // The read that started before the publish still answers what it read.
    expect((await inFlight).tiers[0]!.discountBps).toBe(100);
    // But it did not refill the cache with it.
    expect((await token.feeDiscountSchedule()).tiers[0]!.discountBps).toBe(900);
  });
});
