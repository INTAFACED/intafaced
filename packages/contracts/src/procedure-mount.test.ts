import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from './index.js';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';
import { mountRecord, mountRecords, TRPCError, UndeclaredRefusalError, type RefusalOf } from './procedure-mount.js';

/**
 * A service's router made from its records (`mountRecords`), the way a TypeScript service mounts its calls: the
 * records below are an example service's, its handlers are the only code it writes, and its one refusal type is read
 * once (`exampleRefusal`). Copy this shape (docs/agents/shape.md, rule 1).
 */

class ExampleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The service's one refusal type, in its wire form. Once per service, never per call. */
const exampleRefusal: RefusalOf = (err) =>
  err instanceof ExampleError
    ? { code: err.code, error: new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.code} — refused` }) }
    : undefined;

const refuse = (...codes: string[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, 'PRECONDITION_FAILED' as const])));
// An example service's records, on a real service name and module (the record's types take only those).
const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

const HEALTH = defineProcedure({
  ...base,
  name: 'example.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ ok: z.literal(true) }),
  samples: [{ verdict: 'accept' }],
});

const NOTE_SET = defineProcedure({
  ...base,
  name: 'example.note.set',
  kind: 'mutation',
  path: 'note.set',
  access: { caller: 'scope', scope: 'tax:write', module: 'tax', plane: 'fiat' },
  refusals: refuse('example.note_unset'),
  input: z.object({ note: z.string() }).strict(),
  output: z.object({ saved: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { note: 'n' } },
    { verdict: 'refuse', input: { note: 1 } },
  ],
});

const SECRET = 'a-procedure-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });

async function caller(scopes: string[] | null) {
  if (scopes === null) return edgeContext({ headers: {}, id: 'anon' });
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'signed',
  });
}

function exampleRouter(onNote: (note: string) => void = () => undefined) {
  return mountRecords(
    [HEALTH, NOTE_SET] as const,
    {
      'example.health': () => ({ ok: true as const }),
      'example.note.set': ({ input }) => {
        if (input.note === '') throw new ExampleError('example.note_unset');
        if (input.note === 'other') throw new ExampleError('example.not_listed');
        onNote(input.note);
        return { saved: true as const };
      },
    },
    exampleRefusal,
  );
}

const strictBefore = process.env.PROCEDURE_REFUSALS_STRICT;
afterEach(() => {
  if (strictBefore === undefined) delete process.env.PROCEDURE_REFUSALS_STRICT;
  else process.env.PROCEDURE_REFUSALS_STRICT = strictBefore;
});

describe('mountRecords: a router made from records', () => {
  it('mounts each record at its path, a dotted path as a nested router, with its guard and input', async () => {
    const notes: string[] = [];
    const anon = exampleRouter().createCaller(await caller(null));
    expect(await anon.health()).toEqual({ ok: true });
    await expect(anon.note.set({ note: 'n' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const reader = exampleRouter().createCaller(await caller(['tax:read']));
    await expect(reader.note.set({ note: 'n' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const writer = exampleRouter((n) => notes.push(n)).createCaller(await caller(['tax:read', 'tax:write']));
    await expect(writer.note.set({ note: 1 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await writer.note.set({ note: 'kept' })).toEqual({ saved: true });
    expect(notes).toEqual(['kept']);
  });

  it('mounts an `anyScope` record behind the first of its scopes the caller holds', async () => {
    const SHARED_READ = defineProcedure({
      ...base,
      name: 'example.shared',
      kind: 'query',
      path: 'shared',
      access: { caller: 'anyScope', scopes: ['tax:read', 'admin:read'] },
      refusals: refuse(),
      input: NO_INPUT,
      output: z.object({ ok: z.literal(true) }),
      samples: [{ verdict: 'accept' }],
    });
    const shared = () => mountRecords([SHARED_READ] as const, { 'example.shared': () => ({ ok: true as const }) }, exampleRefusal);
    await expect(
      shared()
        .createCaller(await caller(null))
        .shared(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      shared()
        .createCaller(await caller(['quant:read']))
        .shared(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await shared()
        .createCaller(await caller(['tax:read']))
        .shared(),
    ).toEqual({ ok: true });
    expect(
      await shared()
        .createCaller(await caller(['admin:read']))
        .shared(),
    ).toEqual({ ok: true });
  });

  it("sends a listed refusal in the service's wire form", async () => {
    const writer = exampleRouter().createCaller(await caller(['tax:read', 'tax:write']));
    await expect(writer.note.set({ note: '' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'example.note_unset — refused',
    });
  });

  it('refuses a refusal its record does not list when strict, and sends it unchanged otherwise', async () => {
    const writer = exampleRouter().createCaller(await caller(['tax:read', 'tax:write']));
    process.env.PROCEDURE_REFUSALS_STRICT = '1';
    await expect(writer.note.set({ note: 'other' })).rejects.toMatchObject({ cause: expect.any(UndeclaredRefusalError) });
    delete process.env.PROCEDURE_REFUSALS_STRICT;
    await expect(writer.note.set({ note: 'other' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'example.not_listed — refused',
    });
  });

  it('fails at start-up on a handler with no record, a record with no handler, or two records on one path', () => {
    expect(() =>
      mountRecords([HEALTH] as const, { 'example.health': () => ({ ok: true as const }), extra: () => ({}) } as never, exampleRefusal),
    ).toThrow('handler extra has no record');
    expect(() => mountRecords([HEALTH, NOTE_SET] as const, { 'example.health': () => ({ ok: true }) } as never, exampleRefusal)).toThrow(
      'record example.note.set has no handler',
    );
    const twin = { ...HEALTH, name: 'example.health2' };
    expect(() =>
      mountRecords(
        [HEALTH, twin] as never,
        { 'example.health': () => ({ ok: true }), 'example.health2': () => ({ ok: true }) },
        exampleRefusal,
      ),
    ).toThrow('two records mount health');
  });

  it('mounts no plain HTTP record as a tRPC procedure', () => {
    const http = { ...HEALTH, transport: 'http' } as never;
    expect(() => mountRecord(http, () => ({ ok: true }), exampleRefusal)).toThrow('plain HTTP door');
  });
});
