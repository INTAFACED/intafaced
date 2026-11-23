import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { request } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `addMoney.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** One of the customer's own requests, for the tracker from created to credited. */
export const BANK_ADD_MONEY_REQUEST = defineProcedure({
  ...base,
  name: 'bank.addMoney.request',
  kind: 'query',
  path: 'addMoney.request',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ requestId: z.string().guid() }).strict(),
  output: request,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The customer's own requests, newest first, for the tracker. */
export const BANK_ADD_MONEY_REQUESTS = defineProcedure({
  ...base,
  name: 'bank.addMoney.requests',
  kind: 'query',
  path: 'addMoney.requests',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.array(request),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
