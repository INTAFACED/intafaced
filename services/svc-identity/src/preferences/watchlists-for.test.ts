import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createPreferencesRouter } from './preferences-router.js';

/** A stand-in for postgres' tagged template: records each query's values and answers the given rows. */
function fakeSql(rows: Array<{ value: unknown }>) {
  const seen: unknown[][] = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push(values);
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return { sql, seen };
}

const record = [
  {
    id: 'majors',
    name: 'TEST majors',
    flag: null,
    sections: [
      { id: 'a', title: 'One', collapsed: false, symbols: ['BTC/USDT'] },
      { id: 'b', title: 'Two', collapsed: false, symbols: ['ETH/USDT'] },
    ],
  },
];

const call = (sql: Sql, service: string | null, userId = 'user-ada') =>
  createPreferencesRouter(sql)
    .createCaller({ service } as never)
    .preferences.watchlistsFor({ userId });

describe('preferences.watchlistsFor (J-charts-desk-09 #7)', () => {
  it("answers svc-notify with the person's lists, every section's symbols in order", async () => {
    const { sql, seen } = fakeSql([{ value: record }]);
    await expect(call(sql, 'svc-notify')).resolves.toEqual({
      lists: [{ id: 'majors', name: 'TEST majors', symbols: ['BTC/USDT', 'ETH/USDT'] }],
    });
    // The person's own record of the watchlists namespace, nothing else.
    expect(seen).toEqual([['user-ada', 'trade.watchlists']]);
  });

  it('answers no lists for a person with no record', async () => {
    await expect(call(fakeSql([]).sql, 'svc-notify')).resolves.toEqual({ lists: [] });
  });

  it('refuses every other service, and a caller that is not a service, before reading anything', async () => {
    for (const service of ['svc-trade', 'svc-edge', null]) {
      const { sql, seen } = fakeSql([{ value: record }]);
      await expect(call(sql, service)).rejects.toThrow();
      expect(seen).toEqual([]);
    }
  });

  it('refuses a stored record that is not the shape, so the caller has no answer rather than an empty list', async () => {
    await expect(call(fakeSql([{ value: [{ id: 'broken' }] }]).sql, 'svc-notify')).rejects.toThrow('identity.watchlists_record_invalid');
  });
});
