import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyPublicCatalogueInputSchema } from './academy-catalogue.js';
import { curriculumSummaryOut } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicCurriculum.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_PUBLIC_CURRICULUM = defineProcedure({
  ...base,
  name: 'academy.publicCurriculum',
  kind: 'query',
  path: 'publicCurriculum',
  access: { caller: 'public' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyPublicCatalogueInputSchema,
  output: z.array(curriculumSummaryOut),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
