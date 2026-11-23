import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InstrumentError } from './instruments.js';
import { InstrumentService, assertMethodSchemaListLimit } from './instrument-service.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * instruments.methods.list page size is refuse-closed when unset.
 *
 * listMethodSchemas dumped the method-schema registry with no LIMIT when
 * page size was omitted. Blank must refuse. Caller may pass 50 explicitly.
 * Never invent 50.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('instruments.methods.list limit unset refuse', () => {
  it('assertMethodSchemaListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertMethodSchemaListLimit(undefined)).toThrow(InstrumentError);
    expect(() => assertMethodSchemaListLimit(Number.NaN)).toThrow(InstrumentError);
    expect(() => assertMethodSchemaListLimit(0)).toThrow(InstrumentError);
    try {
      assertMethodSchemaListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(InstrumentError);
      expect((e as InstrumentError).code).toBe('p2p.method_schema_list_limit_unset');
      expect((e as InstrumentError).message).toBe(resolveP2pCopy(P2P_COPY.methodSchemaListLimitUnset));
      expect((e as InstrumentError).message).not.toMatch(/50-row|default 50|LIMIT 200/i);
    }
  });

  it('listMethodSchemas refuses without limit — never invents 50', async () => {
    const instruments = new InstrumentService({} as never);
    await expect(instruments.listMethodSchemas()).rejects.toMatchObject({
      code: 'p2p.method_schema_list_limit_unset',
    });
    await expect(instruments.listMethodSchemas({})).rejects.toMatchObject({
      code: 'p2p.method_schema_list_limit_unset',
    });
    await expect(instruments.listMethodSchemas({ country: 'DE' })).rejects.toMatchObject({
      code: 'p2p.method_schema_list_limit_unset',
    });
    expect(assertMethodSchemaListLimit(50)).toBe(50);
  });

  it('accepts caller-published 50 and caps at 200', () => {
    expect(assertMethodSchemaListLimit(50)).toBe(50);
    expect(assertMethodSchemaListLimit(1)).toBe(1);
    expect(assertMethodSchemaListLimit(200)).toBe(200);
    expect(assertMethodSchemaListLimit(201)).toBe(200);
  });

  it('listMethodSchemas no longer dumps the registry without LIMIT', () => {
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/instrument-service.ts'), 'utf8');
    const start = src.indexOf('async listMethodSchemas(');
    const end = src.indexOf('async setMethodSchemaEnabled(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertMethodSchemaListLimit');
    expect(fn).toContain('LIMIT ${lim}');
    expect(fn).not.toMatch(/limit = 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
