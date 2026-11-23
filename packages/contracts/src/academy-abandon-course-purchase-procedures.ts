import { defineProcedure } from './procedure.js';
import { academyCoursePurchaseViewSchema, academyPurchaseKeyInputSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `abandonCoursePurchase.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** J-academy-07: the wallet refused to sign; the intent is set aside and no purchase shows. */
export const ACADEMY_ABANDON_COURSE_PURCHASE = defineProcedure({
  ...base,
  name: 'academy.abandonCoursePurchase',
  kind: 'mutation',
  path: 'abandonCoursePurchase',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.payments_off': 'PRECONDITION_FAILED',
    'academy.price_unset': 'PRECONDITION_FAILED',
    'academy.purchase_not_found': 'NOT_FOUND',
  },
  input: academyPurchaseKeyInputSchema,
  output: academyCoursePurchaseViewSchema,
  samples: [
    { verdict: 'accept', input: { key: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
