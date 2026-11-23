import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { trpcRecordReply, trpcRecordRequest } from './procedure-trpc.js';

const READ = defineProcedure({
  name: 'test.read',
  service: 'svc-protocol',
  transport: 'trpc',
  kind: 'query',
  path: 'escrow.deal',
  access: { caller: 'jurisdiction', module: 'protocol', plane: 'protocol' },
  refusals: {},
  input: z.object({ dealId: z.string().min(1) }),
  output: z.object({ state: z.string() }),
  accept: { open: { says: 'the deal is open', holds: (r) => (r as { state: string }).state === 'open' } },
  samples: [
    { verdict: 'accept', input: { dealId: 'd' } },
    { verdict: 'refuse', input: { dealId: '' } },
  ],
});
const WRITE = defineProcedure({
  name: 'test.write',
  service: 'svc-protocol',
  transport: 'trpc',
  kind: 'mutation',
  path: 'venueWallet.disconnect',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ ok: z.literal(true) }),
  samples: [{ verdict: 'accept' }, { verdict: 'refuse', input: 1 }],
});

describe('a service calls another through the call record', () => {
  it('a query is a GET carrying its checked input, a mutation a POST', () => {
    expect(trpcRecordRequest(READ, 'http://p:4012/', { dealId: 'd 1' })).toEqual({
      url: 'http://p:4012/trpc/escrow.deal?input=%7B%22dealId%22%3A%22d%201%22%7D',
      method: 'GET',
    });
    expect(trpcRecordRequest(WRITE, 'http://p:4012', undefined)).toEqual({
      url: 'http://p:4012/trpc/venueWallet.disconnect',
      method: 'POST',
    });
    expect(() => trpcRecordRequest(READ, 'http://p', { dealId: '' })).toThrow();
  });
  it('a reply is read by the record: its shape and its accept checks, else null', () => {
    expect(trpcRecordReply(READ, { result: { data: { state: 'open', extra: 1 } } })).toEqual({ state: 'open' });
    expect(trpcRecordReply(READ, { result: { data: { state: 'closed' } } })).toBeNull();
    expect(trpcRecordReply(READ, { result: { data: { nope: 1 } } })).toBeNull();
  });
});
