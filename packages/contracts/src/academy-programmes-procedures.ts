import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyProgrammeSchema, academyProgrammesInputSchema } from './academy-programmes.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `programmes.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-programmes-01: the learning programmes newest first, each with the caller's course counts and certificate. */
export const ACADEMY_PROGRAMMES = defineProcedure({
  ...base,
  name: 'academy.programmes',
  kind: 'query',
  path: 'programmes',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.cert_invalid': 'BAD_REQUEST', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyProgrammesInputSchema,
  output: z.array(academyProgrammeSchema),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
