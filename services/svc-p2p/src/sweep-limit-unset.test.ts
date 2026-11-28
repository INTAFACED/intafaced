import { describe, expect, it } from 'vitest';
import { P2pError, P2pService, assertSweepDeadlinesLimit, assertSweepSettlementsLimit } from './p2p-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * sweepSettlements / sweepDeadlines batch size is refuse-closed when unset.
 *
 * Both used `limit = 100`, so omit invented a 100-row operator batch.
 * Blank must refuse. Owner may pass 100 explicitly.
 */

describe('sweep batch limit unset refuse', () => {
  it('assertSweepSettlementsLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertSweepSettlementsLimit(undefined)).toThrow(P2pError);
    expect(() => assertSweepSettlementsLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertSweepSettlementsLimit(0)).toThrow(P2pError);
    try {
      assertSweepSettlementsLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.sweep_settlements_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.sweepSettlementsLimitUnset));
      expect((e as P2pError).message).not.toMatch(/100-row|default 100/i);
    }
  });

  it('assertSweepDeadlinesLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertSweepDeadlinesLimit(undefined)).toThrow(P2pError);
    expect(() => assertSweepDeadlinesLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertSweepDeadlinesLimit(0)).toThrow(P2pError);
    try {
      assertSweepDeadlinesLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.sweep_deadlines_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.sweepDeadlinesLimitUnset));
      expect((e as P2pError).message).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accepts owner-published 100 and caps at 200', () => {
    expect(assertSweepSettlementsLimit(100)).toBe(100);
    expect(assertSweepDeadlinesLimit(100)).toBe(100);
    expect(assertSweepSettlementsLimit(1)).toBe(1);
    expect(assertSweepDeadlinesLimit(1)).toBe(1);
    expect(assertSweepSettlementsLimit(200)).toBe(200);
    expect(assertSweepDeadlinesLimit(200)).toBe(200);
    expect(assertSweepSettlementsLimit(201)).toBe(200);
    expect(assertSweepDeadlinesLimit(201)).toBe(200);
  });

  it('sweepSettlements refuses an omitted batch before any query, and sweeps by the batch it was given', async () => {
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, {} as never);
    await expect(p2p.sweepSettlements()).rejects.toMatchObject({ code: 'p2p.sweep_settlements_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(p2p.sweepSettlements(100)).resolves.toMatchObject({ settled: 0, failed: 0 });
    await p2p.sweepSettlements(201);
    expect(limitsOf(calls)).toEqual([100, 200]);
  });

  it('sweepDeadlines refuses an omitted batch before any query, and sweeps by the batch it was given', async () => {
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, {} as never);
    const now = new Date('2026-11-28T00:00:00.000Z');
    await expect(p2p.sweepDeadlines(now)).rejects.toMatchObject({ code: 'p2p.sweep_deadlines_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(p2p.sweepDeadlines(now, 100)).resolves.toMatchObject({ failures: [] });
    await p2p.sweepDeadlines(now, 201);
    expect(limitsOf(calls)).toEqual([100, 200]);
  });
});
