import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyCourseOutlineSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `courseOutline.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-course-structure-02: the outline of an item's course, with the caller's own release state per item. */
export const ACADEMY_COURSE_OUTLINE = defineProcedure({
  ...base,
  name: 'academy.courseOutline',
  kind: 'query',
  path: 'courseOutline',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.curriculum_not_found': 'NOT_FOUND', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: z.object({ itemSlug: z.string().min(1).max(120) }).strict(),
  output: academyCourseOutlineSchema,
  samples: [
    { verdict: 'accept', input: { itemSlug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
