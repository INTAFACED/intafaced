import { defineProcedure } from './procedure.js';
import { academyCoursePurchaseViewSchema, academyPurchasePaymentInputSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** J-academy-07: the wallet sent the payment; its hash is stored and read against the chain. */
export const ACADEMY_SUBMIT_COURSE_PAYMENT = defineProcedure({
  ...base,
  name: 'academy.submitCoursePayment',
  kind: 'mutation',
  path: 'submitCoursePayment',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.payments_off': 'PRECONDITION_FAILED',
    'academy.price_unset': 'PRECONDITION_FAILED',
    'academy.purchase_not_found': 'NOT_FOUND',
    'academy.wallet_invalid': 'BAD_REQUEST',
  },
  input: academyPurchasePaymentInputSchema,
  output: academyCoursePurchaseViewSchema,
  samples: [
    { verdict: 'accept', input: { key: 'placeholder', txHash: '0x0000000000000000000000000000000000000000000000000000000000000000' } },
    { verdict: 'refuse', input: 42 },
  ],
});
