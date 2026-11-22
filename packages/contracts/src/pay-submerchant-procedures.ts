import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { subMerchantView } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `submerchant.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/** Direct children of a node the caller can reach. Requires `submerchant`. */
export const PAY_SUBMERCHANT_LIST = defineProcedure({
  ...base,
  name: 'pay.submerchant.list',
  kind: 'query',
  path: 'submerchant.list',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z.object({
    merchantId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `pay.submerchant_list_limit_unset`.
     * Blank is not 100; pass 100 explicitly.
     */
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.array(subMerchantView),
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One node's record. Requires `merchant.profile`, not `submerchant`. */
export const PAY_SUBMERCHANT_GET = defineProcedure({
  ...base,
  name: 'pay.submerchant.get',
  kind: 'query',
  path: 'submerchant.get',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z.object({ merchantId: z.string().guid() }),
  output: subMerchantView,
  samples: [
    { verdict: 'accept', input: { merchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
