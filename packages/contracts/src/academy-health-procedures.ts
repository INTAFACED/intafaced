import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `health.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_HEALTH = defineProcedure({
  ...base,
  name: 'academy.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ ok: z.boolean(), service: z.literal('svc-academy') }),
  samples: [{ verdict: 'accept' }],
});
