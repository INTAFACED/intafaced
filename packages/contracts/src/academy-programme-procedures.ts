import { defineProcedure } from './procedure.js';
import { academyProgrammeInputSchema, academyProgrammeSchema } from './academy-programmes.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `programme.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-programmes-01: one programme: its courses in order with the caller's state on each, the counts and the certificate. */
export const ACADEMY_PROGRAMME = defineProcedure({
  ...base,
  name: 'academy.programme',
  kind: 'query',
  path: 'programme',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.cert_invalid': 'BAD_REQUEST', 'academy.programme_not_found': 'NOT_FOUND', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyProgrammeInputSchema,
  output: academyProgrammeSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
