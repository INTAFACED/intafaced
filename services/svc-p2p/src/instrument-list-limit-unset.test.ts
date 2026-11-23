import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InstrumentError } from './instruments.js';
import { InstrumentService, assertInstrumentListLimit } from './instrument-service.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * instruments.list page size is refuse-closed when unset.
 *
 * listInstruments used `LIMIT 200` with no caller page size, so omit dumped
 * every instrument up to 200. Blank must refuse. Owner/client may pass 50
 * explicitly. Never invent 50.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

  it('listInstruments no longer hardcodes LIMIT 200', () => {
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/instrument-service.ts'), 'utf8');
    const start = src.indexOf('async listInstruments(');
    const end = src.indexOf('async enabledMethodKeys(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertInstrumentListLimit');
    expect(fn).toContain('LIMIT ${lim}');
    expect(fn).not.toMatch(/LIMIT 200/);
    expect(fn).not.toMatch(/limit = 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
