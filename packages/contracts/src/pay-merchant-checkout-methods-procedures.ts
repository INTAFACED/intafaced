import { defineProcedure } from './procedure.js';
import {
  checkoutMethodOfferSchema,
  checkoutMethodsGetInputSchema,
  checkoutMethodsPreviewInputSchema,
  checkoutMethodsSchema,
} from './merchant-checkout-methods.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantCheckoutMethods.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_CHECKOUT_METHODS_GET = defineProcedure({
  ...base,
  name: 'pay.merchantCheckoutMethods.get',
  kind: 'query',
  path: 'merchantCheckoutMethods.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: checkoutMethodsGetInputSchema,
  output: checkoutMethodsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CHECKOUT_METHODS_PREVIEW = defineProcedure({
  ...base,
  name: 'pay.merchantCheckoutMethods.preview',
  kind: 'query',
  path: 'merchantCheckoutMethods.preview',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: checkoutMethodsPreviewInputSchema,
  output: checkoutMethodOfferSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
