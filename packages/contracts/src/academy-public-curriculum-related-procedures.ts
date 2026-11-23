import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyRelatedInputSchema } from './academy-articles.js';
import { curriculumSummaryOut } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicCurriculumRelated.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const ACADEMY_PUBLIC_CURRICULUM_RELATED = defineProcedure({
  ...base,
  name: 'academy.publicCurriculumRelated',
  kind: 'query',
  path: 'publicCurriculumRelated',
  access: { caller: 'public' },
  refusals: { 'academy.curriculum_not_found': 'NOT_FOUND', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyRelatedInputSchema,
  output: z.array(curriculumSummaryOut),
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
