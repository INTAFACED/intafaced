import { defineProcedure } from './procedure.js';
import { checkoutMethodOfferSchema, checkoutMethodsPreviewInputSchema } from './merchant-checkout-methods.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantCheckoutMethods.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_CHECKOUT_METHODS_PREVIEW = defineProcedure({
  ...base,
  name: 'pay.merchantCheckoutMethods.preview',
  kind: 'query',
  path: 'merchantCheckoutMethods.preview',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: checkoutMethodsPreviewInputSchema,
  checks: { rule_amount_holds: { at: 'input.amount', says: 'must be greater than zero' } },
  output: checkoutMethodOfferSchema,
  samples: [
    { verdict: 'accept', input: { country: 'en', currency: 'USDC' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'rule_amount_holds', input: { country: 'en', currency: 'USDC', amount: '0' } },
  ],
});
