import { describe, expect, it } from 'vitest';
import { P2pError, P2pService, assertDisputeListLimit } from './p2p-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * disputes.list page size is refuse-closed when unset.
 *
 * listDisputes used `input.limit ?? 50`, so omit invented a 50-row moderator queue.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const MODERATOR = '44444444-4444-4444-8444-444444444444';

describe('disputes.list limit unset refuse', () => {
  it('assertDisputeListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertDisputeListLimit(undefined)).toThrow(P2pError);
    expect(() => assertDisputeListLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertDisputeListLimit(0)).toThrow(P2pError);
    try {
      assertDisputeListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.dispute_list_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.disputeListLimitUnset));
      expect((e as P2pError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertDisputeListLimit(50)).toBe(50);
    expect(assertDisputeListLimit(1)).toBe(1);
    expect(assertDisputeListLimit(200)).toBe(200);
    expect(assertDisputeListLimit(201)).toBe(200);
  });

  it('listDisputes refuses an omitted limit before any query, and pages by the limit it was given', async () => {
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, {} as never);
    await expect(p2p.listDisputes({ moderatorId: MODERATOR })).rejects.toMatchObject({ code: 'p2p.dispute_list_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(p2p.listDisputes({ moderatorId: MODERATOR, limit: 50 })).resolves.toMatchObject({ disputes: [] });
    expect(limitsOf(calls)).toEqual([50]);
    await p2p.listDisputes({ moderatorId: MODERATOR, limit: 201 });
    expect(limitsOf(calls)).toEqual([50, 200]);
  });
});
