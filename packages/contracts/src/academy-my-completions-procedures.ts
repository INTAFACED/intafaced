import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `myCompletions.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const completionPageOut = z.object({
  items: z.array(z.object({ itemSlug: z.string(), completedAt: z.iso.datetime({ offset: true }) })),
  nextCursor: z.string().nullable(),
});

export const ACADEMY_MY_COMPLETIONS = defineProcedure({
  ...base,
  name: 'academy.myCompletions',
  kind: 'query',
  path: 'myCompletions',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.cert_invalid': 'BAD_REQUEST', 'academy.my_completions_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({ limit: z.number().optional(), cursor: z.string().min(1).max(512).optional() }),
  output: completionPageOut,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
