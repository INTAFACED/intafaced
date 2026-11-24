import { defineProcedure } from './procedure.js';
import { academyAuthoredCourseInputSchema } from './academy-courses.js';
import { academyCoursePurchaseViewSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `coursePurchase.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** J-academy-07: a course's price, how it can be paid (wallet; card needs a partner), and the caller's own latest purchase. */
export const ACADEMY_COURSE_PURCHASE = defineProcedure({
  ...base,
  name: 'academy.coursePurchase',
  kind: 'query',
  path: 'coursePurchase',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.payments_off': 'PRECONDITION_FAILED',
    'academy.price_unset': 'PRECONDITION_FAILED',
    'academy.purchase_not_found': 'NOT_FOUND',
  },
  input: academyAuthoredCourseInputSchema,
  output: academyCoursePurchaseViewSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
