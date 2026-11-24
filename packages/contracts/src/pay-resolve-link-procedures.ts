import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountSchema } from './pay-call-schemas.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `resolveLink.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/** Public payment-link resolve — checkout intent only, no merchant secrets. */
export const PAY_RESOLVE_LINK = defineProcedure({
  ...base,
  name: 'pay.resolveLink',
  kind: 'query',
  path: 'resolveLink',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ token: z.string().min(8).max(200) }),
  output: z.object({
    id: z.string().guid(),
    merchantId: z.string().guid(),
    profileId: z.string().guid().nullable(),
    label: z.string(),
    amount: amountSchema.nullable(),
    currency: z.string().nullable(),
    expiresAt: z.string().nullable(),
    remainingUses: z.number().int().nullable(),
    checkoutConfig: z.record(z.string(), jsonValueSchema),
  }),
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
