import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { salaryCreditView } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `salary.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** The person's salary credits, newest first: received, returned or reversed, each with its split. */
export const BANK_SALARY_CREDITS = defineProcedure({
  ...base,
  name: 'bank.salary.credits',
  kind: 'query',
  path: 'salary.credits',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.array(salaryCreditView),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
