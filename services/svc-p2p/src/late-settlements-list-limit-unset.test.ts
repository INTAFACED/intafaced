import { describe, expect, it } from 'vitest';
import { P2pError, P2pService, assertLateSettlementsListLimit } from './p2p-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * ops.lateSettlements page size is refuse-closed when unset.
 *
 * listLateSettlements used `limit = 100` / router `input?.limit ?? 100`, so
 * omit invented a 100-row operator queue. Blank must refuse. Owner/client
 * may pass 100 explicitly.
 */

describe('ops.lateSettlements limit unset refuse', () => {
  it('assertLateSettlementsListLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertLateSettlementsListLimit(undefined)).toThrow(P2pError);
    expect(() => assertLateSettlementsListLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertLateSettlementsListLimit(0)).toThrow(P2pError);
    try {
      assertLateSettlementsListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.late_settlements_list_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.lateSettlementsListLimitUnset));
      expect((e as P2pError).message).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at 200', () => {
    expect(assertLateSettlementsListLimit(100)).toBe(100);
    expect(assertLateSettlementsListLimit(1)).toBe(1);
    expect(assertLateSettlementsListLimit(200)).toBe(200);
    expect(assertLateSettlementsListLimit(201)).toBe(200);
  });

  it('listLateSettlements refuses an omitted limit before any query, and reads by the limit it was given', async () => {
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, {} as never);
    await expect(p2p.listLateSettlements()).rejects.toMatchObject({ code: 'p2p.late_settlements_list_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(p2p.listLateSettlements(100)).resolves.toEqual([]);
    expect(limitsOf(calls)).toEqual([100]);
    await p2p.listLateSettlements(201);
    expect(limitsOf(calls)).toEqual([100, 200]);
  });
});
