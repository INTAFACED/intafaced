import { defineProcedure } from './procedure.js';
import { checkoutBrandingGetInputSchema, checkoutBrandingSchema } from './merchant-checkout-branding.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantCheckout.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_CHECKOUT_BRANDING_GET = defineProcedure({
  ...base,
  name: 'pay.merchantCheckout.branding.get',
  kind: 'query',
  path: 'merchantCheckout.branding.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: checkoutBrandingGetInputSchema,
  output: checkoutBrandingSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
