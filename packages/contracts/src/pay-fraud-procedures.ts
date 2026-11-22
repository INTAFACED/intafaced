import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { fraudReviewRowSchema } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `fraud.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_FRAUD_LIST_OPEN_REVIEWS = defineProcedure({
  ...base,
  name: 'pay.fraud.listOpenReviews',
  kind: 'query',
  path: 'fraud.listOpenReviews',
  access: { caller: 'scope', scope: 'admin:treasury', module: 'pay' },
  refusals: {},
  input: z
    .object({
      merchantId: z.string().min(1).optional(),
      /**
       * Page size. Optional so omit reaches `pay.fraud_review_list_limit_unset`.
       * Blank is not 50; pass 50 explicitly. Read stays single-operator.
       */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  output: z.array(fraudReviewRowSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
