import { defineProcedure } from './procedure.js';
import { academyBuyCourseInputSchema, academyCoursePurchaseViewSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * J-academy-07: Buy from the caller's own wallet. The intent `academy:purchase:<course>:<learner>:<n>` is stored first;
 * `request` (the one transfer the wallet signs) is set only on the answer that opened it, never on a repeat.
 */
export const ACADEMY_BUY_COURSE = defineProcedure({
  ...base,
  name: 'academy.buyCourse',
  kind: 'mutation',
  path: 'buyCourse',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.payments_off': 'PRECONDITION_FAILED',
    'academy.price_unset': 'PRECONDITION_FAILED',
    'academy.purchase_not_found': 'NOT_FOUND',
    'academy.wallet_invalid': 'BAD_REQUEST',
    'academy.wallet_not_linked': 'FORBIDDEN',
    'academy.wallet_unread': 'PRECONDITION_FAILED',
  },
  input: academyBuyCourseInputSchema,
  output: academyCoursePurchaseViewSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'USDC', wallet: '0x0000000000000000000000000000000000000000' } },
    { verdict: 'refuse', input: 42 },
  ],
});
