import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `health.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_HEALTH = defineProcedure({
  ...base,
  name: 'bank.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ ok: z.boolean(), service: z.literal('svc-bank') }),
  samples: [{ verdict: 'accept' }],
});
