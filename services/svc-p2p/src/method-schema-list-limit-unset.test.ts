import { describe, expect, it } from 'vitest';
import { InstrumentError } from './instruments.js';
import { InstrumentService, assertMethodSchemaListLimit } from './instrument-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * instruments.methods.list page size is refuse-closed when unset.
 *
 * listMethodSchemas dumped the method-schema registry with no LIMIT when
 * page size was omitted. Blank must refuse. Caller may pass 50 explicitly.
 * Never invent 50.
 */

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

  it('listMethodSchemas reads the registry by the limit it was given, capped at 200', async () => {
    const { sql, calls } = recordingSql();
    const instruments = new InstrumentService(sql);
    await expect(instruments.listMethodSchemas({ includeDisabled: true })).rejects.toMatchObject({
      code: 'p2p.method_schema_list_limit_unset',
    });
    expect(calls).toHaveLength(0);
    // The operator listing (disabled rows too) returns an empty registry as rows; the public listing refuses it.
    await expect(instruments.listMethodSchemas({ includeDisabled: true, limit: 50 })).resolves.toEqual([]);
    await instruments.listMethodSchemas({ includeDisabled: true, country: 'DE', limit: 7 });
    await instruments.listMethodSchemas({ includeDisabled: true, limit: 201 });
    expect(limitsOf(calls)).toEqual([50, 7, 200]);
  });
});
