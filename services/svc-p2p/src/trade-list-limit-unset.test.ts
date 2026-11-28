import { describe, expect, it } from 'vitest';
import { P2pError, P2pService, assertTradeListLimit } from './p2p-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * trades.list page size is refuse-closed when unset.
 *
 * listTrades used `limit = 50`, so omit invented a 50-row trade page.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const USER = '11111111-1111-4111-8111-111111111111';

describe('trades.list limit unset refuse', () => {
  it('assertTradeListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertTradeListLimit(undefined)).toThrow(P2pError);
    expect(() => assertTradeListLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertTradeListLimit(0)).toThrow(P2pError);
    try {
      assertTradeListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.trade_list_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.tradeListLimitUnset));
      expect((e as P2pError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertTradeListLimit(50)).toBe(50);
    expect(assertTradeListLimit(1)).toBe(1);
    expect(assertTradeListLimit(200)).toBe(200);
    expect(assertTradeListLimit(201)).toBe(200);
  });

  it('listTrades refuses an omitted limit before any query, and reads by the limit it was given', async () => {
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, {} as never);
    await expect(p2p.listTrades(USER)).rejects.toMatchObject({ code: 'p2p.trade_list_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(p2p.listTrades(USER, 50)).resolves.toEqual([]);
    expect(limitsOf(calls)).toEqual([50]);
    await p2p.listTrades(USER, 201);
    expect(limitsOf(calls)).toEqual([50, 200]);
  });
});
