import { describe, expect, it } from 'vitest';
import { InstrumentError } from './instruments.js';
import { InstrumentService, assertInstrumentListLimit } from './instrument-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * instruments.list page size is refuse-closed when unset.
 *
 * listInstruments used `LIMIT 200` with no caller page size, so omit dumped
 * every instrument up to 200. Blank must refuse. Owner/client may pass 50
 * explicitly. Never invent 50.
 */

describe('instruments.list limit unset refuse', () => {
  it('assertInstrumentListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertInstrumentListLimit(undefined)).toThrow(InstrumentError);
    expect(() => assertInstrumentListLimit(Number.NaN)).toThrow(InstrumentError);
    expect(() => assertInstrumentListLimit(0)).toThrow(InstrumentError);
    try {
      assertInstrumentListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(InstrumentError);
      expect((e as InstrumentError).code).toBe('p2p.instrument_list_limit_unset');
      expect((e as InstrumentError).message).toBe(resolveP2pCopy(P2P_COPY.instrumentListLimitUnset));
      expect((e as InstrumentError).message).not.toMatch(/50-row|default 50|LIMIT 200/i);
    }
  });

  it('listInstruments refuses without limit — never invents 50', async () => {
    const instruments = new InstrumentService({} as never);
    await expect(instruments.listInstruments('owner')).rejects.toMatchObject({
      code: 'p2p.instrument_list_limit_unset',
    });
    await expect(instruments.listInstruments('owner', false)).rejects.toMatchObject({
      code: 'p2p.instrument_list_limit_unset',
    });
    expect(assertInstrumentListLimit(50)).toBe(50);
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertInstrumentListLimit(50)).toBe(50);
    expect(assertInstrumentListLimit(1)).toBe(1);
    expect(assertInstrumentListLimit(200)).toBe(200);
    expect(assertInstrumentListLimit(201)).toBe(200);
  });

  it('listInstruments reads by the limit it was given, capped at 200, and asks nothing without one', async () => {
    const { sql, calls } = recordingSql();
    const instruments = new InstrumentService(sql);
    await expect(instruments.listInstruments('owner', true)).rejects.toMatchObject({ code: 'p2p.instrument_list_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(instruments.listInstruments('owner', false, 50)).resolves.toEqual([]);
    await instruments.listInstruments('owner', false, 7);
    await instruments.listInstruments('owner', false, 201);
    expect(limitsOf(calls)).toEqual([50, 7, 200]);
  });
});
