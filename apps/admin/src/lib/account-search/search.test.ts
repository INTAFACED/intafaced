import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readData } from '@/lib/ops-desk/model';
import { accountSearchSpec, searchCursor, searchTerm } from './search';

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

describe('account search term', () => {
  it('takes a whole email as an exact email and anything else as the start of a handle', () => {
    expect(searchTerm('  Ana@Example.com ')).toEqual({ kind: 'email', value: 'ana@example.com' });
    expect(searchTerm('pgq')).toEqual({ kind: 'handle', value: 'pgq' });
    expect(searchTerm('pg')).toMatchObject({ error: expect.stringContaining('three characters') });
    expect(searchTerm('ana@')).toMatchObject({ error: expect.stringContaining('whole email') });
    expect(searchTerm('a b c')).toMatchObject({ error: expect.any(String) });
    expect(searchTerm('pg-q')).toMatchObject({ error: expect.stringContaining('letters, digits and underscores') });
  });
  it('passes identity’s page marker through untouched, and refuses anything that could not be one', () => {
    expect(searchCursor(null)).toBeNull();
    expect(searchCursor('eyJhIjoxfQ')).toBe('eyJhIjoxfQ');
    expect(searchCursor('a b')).toBeUndefined();
  });
});

describe('account search read', () => {
  it('asks identity for one field and the marker only', () => {
    expect(accountSearchSpec({ kind: 'handle', value: 'pgq' }, null).input).toEqual({ handle: 'pgq' });
    expect(accountSearchSpec({ kind: 'email', value: 'a@b.co' }, 'm1').input).toEqual({ email: 'a@b.co', cursor: 'm1' });
  });
  it('reads identity’s answer, with the marker saying exactly whether more match', () => {
    const spec = accountSearchSpec({ kind: 'handle', value: 'pgq' }, null);
    const row = {
      id: USER,
      handle: 'pgq00',
      status: 'active',
      created: '2026-10-22T10:00:00.123Z',
      kycTier: 'none',
      restrictedAreas: [],
      emailMasked: 'p***@example.com',
    };
    expect(readData(spec, { rows: [row], nextCursor: 'next' })).toMatchObject({ shape: 'list', nextCursor: 'next', pageFull: true });
    expect(readData(spec, { rows: [row], nextCursor: null })).toMatchObject({ nextCursor: null, pageFull: false });
    expect(readData(spec, { rows: [row] })).toBeNull();
  });
  it('matches the procedure identity serves, with the fields it returns', () => {
    const router = readFileSync(
      fileURLToPath(new URL('../../../../../services/svc-identity/src/ops/ops-router.ts', import.meta.url)),
      'utf8',
    );
    expect(router).toContain('accountDirectory: router({');
    expect(router).toMatch(/search: scopedProcedure\('admin:compliance'\)/);
    expect(router).toContain('nextCursor: z.string().nullable()');
    for (const key of ['handle', 'emailMasked', 'status', 'kycTier', 'restrictedAreas', 'created']) expect(router).toContain(`${key}:`);
  });
});
