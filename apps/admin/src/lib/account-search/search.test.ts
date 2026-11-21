import { procedureCallers, type Context } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { createOperatorOpsRouter } from '../../../../../services/svc-identity/src/ops/ops-router';
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
  it('matches the procedure identity serves, with the fields it returns', async () => {
    // identity's own operator router, over a database that answers nothing: the scope, input and output checks are its own.
    const queries: string[] = [];
    const sql = (strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return Promise.resolve([]);
    };
    const ops = createOperatorOpsRouter(sql as never);
    expect(procedureCallers(ops).find((p) => p.path === 'accountDirectory.search')).toEqual({
      path: 'accountDirectory.search',
      type: 'query',
      caller: 'scope',
    });
    const as = (scopes: string[]): Context => ({
      principal: { userId: USER, sessionId: USER, scopes, tier: 'none', mfa: true, expiresAt: new Date('2030-01-01T00:00:00Z') } as never,
      service: null,
      region: 'DE',
      requestId: 'req-1',
    });

    // It takes admin:compliance: a founder session with only admin:read is refused before identity reads anything.
    const handle = accountSearchSpec({ kind: 'handle', value: 'pgq' }, null);
    await expect(ops.createCaller(as(['admin:read'])).accountDirectory.search(handle.input as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(queries).toEqual([]);

    // It takes exactly what the console sends, and its answer is one the console reads.
    const answer = await ops.createCaller(as(['admin:compliance'])).accountDirectory.search(handle.input as never);
    expect(answer).toEqual({ rows: [], nextCursor: null });
    expect(readData(handle, answer)).toMatchObject({ shape: 'list', nextCursor: null, pageFull: false });
    expect(queries.length).toBeGreaterThan(0);
    const search = (ops._def.procedures as Record<string, unknown>)['accountDirectory.search'] as {
      _def: { inputs: { parse(v: unknown): unknown }[]; output: { parse(v: unknown): unknown } };
    };
    const email = accountSearchSpec({ kind: 'email', value: 'a@b.co' }, 'm1');
    expect(search._def.inputs[0]!.parse(email.input)).toEqual(email.input);
    expect(() => search._def.inputs[0]!.parse({ ...email.input, reason: 'x' })).toThrow();

    // Every column the console shows is a field identity returns (its answer is strict: an unknown field fails it).
    const row = {
      id: USER,
      handle: 'pgq00',
      status: 'active',
      created: '2026-10-22T10:00:00.123Z',
      kycTier: 'none',
      restrictedAreas: [],
      emailMasked: 'p***@example.com',
    };
    const columns = handle.columns.map((c) => c.key);
    expect(columns.sort()).toEqual(Object.keys(row).sort());
    expect(search._def.output.parse({ rows: [row], nextCursor: 'next' })).toEqual({ rows: [row], nextCursor: 'next' });
    expect(() => search._def.output.parse({ rows: [{ ...row, email: 'pgq@example.com' }], nextCursor: null })).toThrow();
  });
});
