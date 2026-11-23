import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `safety.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_SAFETY_REGION_NOTICE = defineProcedure({
  ...base,
  name: 'bank.safety.regionNotice',
  kind: 'query',
  path: 'safety.regionNotice',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      region: z.string(),
      blocked: z.boolean(),
      code: z.string().nullable(),
      restriction: z.string().nullable(),
      blockedBy: z.string().nullable(),
      wording: z.string().nullable(),
    })
    .strict(),
  samples: [{ verdict: 'accept' }],
});
