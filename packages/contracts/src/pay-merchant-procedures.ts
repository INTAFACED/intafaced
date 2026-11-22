import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { merchantStarterFeeSchema } from './merchant-portal.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchant.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * The published starter fee, including for a caller who has no merchant yet.
 * Null means the fee is not configured.
 */
export const PAY_MERCHANT_STARTER_FEE = defineProcedure({
  ...base,
  name: 'pay.merchant.starterFee',
  kind: 'query',
  path: 'merchant.starterFee',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ starterFee: merchantStarterFeeSchema.nullable() }),
  samples: [{ verdict: 'accept' }],
});

/** Current merchant for the principal — null when not yet onboarded. */
export const PAY_MERCHANT_ME = defineProcedure({
  ...base,
  name: 'pay.merchant.me',
  kind: 'query',
  path: 'merchant.me',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      id: z.string().guid(),
      userId: z.string().guid(),
      mode: z.enum(['gateway', 'psp', 'payfac']),
      status: z.enum(['pending', 'active', 'suspended', 'closed']),
      kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
      kybRef: z.string().nullable(),
      feeBps: z.number().nullable(),
      /** Null when the starter fee is not set. `local_test` is not INTAFACED pricing. */
      starterFee: merchantStarterFeeSchema.nullable(),
    })
    .nullable(),
  samples: [{ verdict: 'accept' }],
});
