import { describe, expect, it, vi } from 'vitest';
import { sqlFundingPeriodStore, sqlLiquidationAttemptStore, sqlPositionCloser } from './tick-stores.js';

/** Minimal tagged-template mock that records SQL calls. */
function mockSql() {
  const calls: unknown[][] = [];
  const fn = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push([...values]);
      const text = strings.join('?').toLowerCase();
      if (text.includes('select') && text.includes('funding_periods')) {
        return Promise.resolve(values[0] === 'settled-period' ? [{ period_id: 'settled-period' }] : []);
      }
      if (text.includes('select') && text.includes('liquidation_attempts')) {
        return Promise.resolve(values[0] === 'done-liq' ? [{ liquidation_id: 'done-liq' }] : []);
      }
      if (text.includes('update trade.positions')) {
        return Promise.resolve([]);
      }
      if (text.includes('insert into trade.funding_periods')) {
        return Promise.resolve([]);
      }
      if (text.includes('insert into trade.liquidation_attempts')) {
        // tryClaim uses RETURNING; markDone does not. First claim wins a row.
        if (text.includes('returning')) {
          return Promise.resolve([{ liquidation_id: values[0] }]);
        }
        return Promise.resolve([]);
      }
      if (text.includes('from trade.positions')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    { calls },
  );
  return fn as unknown as import('postgres').Sql & { calls: unknown[][] };
}

describe('sqlFundingPeriodStore', () => {
  it('isSettled false then markSettled inserts', async () => {
    const sql = mockSql();
    const store = sqlFundingPeriodStore(sql as never);
    expect(await store.isSettled('m1:t0')).toBe(false);
    await store.markSettled('m1:t0', { legCount: 2, totalPosted: 2 });
    expect(sql.calls.length).toBeGreaterThan(0);
  });

  it('isSettled true for known period', async () => {
    const sql = mockSql();
    const store = sqlFundingPeriodStore(sql as never);
    expect(await store.isSettled('settled-period')).toBe(true);
  });

  it('freezeMembership inserts then reads frozen snapshots (no open-now size fallback)', async () => {
    const calls: unknown[][] = [];
    let frozenIds: string[] | null = null;
    let frozenSnaps: unknown[] | null = null;
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push([...values]);
        const text = strings.join('?').toLowerCase();
        if (text.includes('insert into trade.funding_period_membership')) {
          if (frozenIds == null) {
            frozenIds = values[2] as string[];
            frozenSnaps = values[3] as unknown[];
          }
          return Promise.resolve([]);
        }
        if (text.includes('select member_position_ids')) {
          return Promise.resolve(frozenIds ? [{ member_position_ids: frozenIds, member_snapshots: frozenSnaps }] : []);
        }
        return Promise.resolve([]);
      },
      {
        calls,
        // postgres.js helper — pass-through so INSERT values[3] is the snap array.
        json: (v: unknown) => v,
      },
    );
    const store = sqlFundingPeriodStore(sql as never);
    const a = {
      positionId: 'pos-a',
      userId: 'u1',
      side: 'long' as const,
      size: 1n * 10n ** 18n,
      entryPrice: 50_000n * 10n ** 18n,
      marginAsset: 'USDT',
    };
    const b = { ...a, positionId: 'pos-b', side: 'short' as const };
    const c = { ...a, positionId: 'pos-c', side: 'short' as const, size: 2n * 10n ** 18n };
    const first = await store.freezeMembership('m1:p', [a, b]);
    expect(first.map((p) => p.positionId)).toEqual(['pos-a', 'pos-b']);
    expect(first[0]!.size).toBe(a.size);
    // Second call must not widen — insert is ON CONFLICT DO NOTHING; select returns first set.
    const second = await store.freezeMembership('m1:p', [a, b, c]);
    expect(second.map((p) => p.positionId)).toEqual(['pos-a', 'pos-b']);
    expect(second.find((p) => p.positionId === 'pos-c')).toBeUndefined();
  });

  it('freezeRate inserts once then always returns the first stored rate', async () => {
    const rates = new Map<string, string>();
    const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').toLowerCase();
      if (text.includes('insert into trade.funding_period_rates')) {
        if (text.includes('on conflict (period_id) do nothing') && !rates.has(values[0] as string)) {
          rates.set(values[0] as string, values[1] as string);
        }
        return Promise.resolve([]);
      }
      if (text.includes('select rate') && text.includes('funding_period_rates')) {
        const rate = rates.get(values[0] as string);
        return Promise.resolve(rate === undefined ? [] : [{ rate }]);
      }
      return Promise.resolve([]);
    }, {});
    const store = sqlFundingPeriodStore(sql as never);
    expect(await store.freezeRate('m1:p', '0.0001')).toBe('0.0001');
    expect(await store.freezeRate('m1:p', '0.0003')).toBe('0.0001');
    expect(await store.freezeRate('m1:q', '0.0003')).toBe('0.0003');
  });

  it('freezeRate refuses to fall back to the caller rate when no row comes back', async () => {
    const sql = Object.assign(() => Promise.resolve([]), {});
    const store = sqlFundingPeriodStore(sql as never);
    await expect(store.freezeRate('m1:p', '0.0001')).rejects.toThrow(/refusing oracle-rate fallback/);
  });
});

describe('sqlLiquidationAttemptStore', () => {
  it('tracks done attempts without inventing', async () => {
    const sql = mockSql();
    const store = sqlLiquidationAttemptStore(sql as never);
    expect(await store.isDone('fresh')).toBe(false);
    expect(await store.isDone('done-liq')).toBe(true);
    await store.markDone('fresh');
  });

  it('tryClaim is true when INSERT returns a row (first worker wins)', async () => {
    const sql = mockSql();
    const store = sqlLiquidationAttemptStore(sql as never);
    expect(await store.tryClaim('liq-new')).toBe(true);
  });

  it('tryClaim is false when INSERT returns nothing (conflict — already claimed)', async () => {
    const sql = Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const text = strings.join('?').toLowerCase();
        if (text.includes('insert into trade.liquidation_attempts') && text.includes('returning')) {
          return Promise.resolve([]); // ON CONFLICT DO NOTHING — no row
        }
        return Promise.resolve([]);
      },
      { calls: [] as unknown[][] },
    );
    const store = sqlLiquidationAttemptStore(sql as never);
    expect(await store.tryClaim('liq-taken')).toBe(false);
  });
});

describe('sqlPositionCloser', () => {
  it('updates position status to liquidated', async () => {
    const sql = mockSql();
    const closer = sqlPositionCloser(sql as never, null);
    await closer.markLiquidated('pos-1', { liquidationId: 'liq-1', reason: 'below_maintenance' });
    expect(sql.calls.some((c) => c.includes('pos-1'))).toBe(true);
  });

  it('skips bus publish when bus null', async () => {
    const sql = mockSql();
    const publish = vi.fn();
    const closer = sqlPositionCloser(sql as never, null);
    await closer.markLiquidated('pos-1', { liquidationId: 'liq-1', reason: 'x' });
    expect(publish).not.toHaveBeenCalled();
  });
});
