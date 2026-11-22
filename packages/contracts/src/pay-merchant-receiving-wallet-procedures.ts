import { defineProcedure } from './procedure.js';
import {
  outsideFundsGetInputSchema,
  outsideFundsSchema,
  receivingWalletGetInputSchema,
  receivingWalletSchema,
} from './merchant-receiving-wallet.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantReceivingWallet.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_RECEIVING_WALLET_GET = defineProcedure({
  ...base,
  name: 'pay.merchantReceivingWallet.get',
  kind: 'query',
  path: 'merchantReceivingWallet.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: receivingWalletGetInputSchema,
  output: receivingWalletSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The business's money in its own wallet or with the partner, as the chain or the partner last reported it. */
export const PAY_MERCHANT_RECEIVING_WALLET_OUTSIDE_FUNDS = defineProcedure({
  ...base,
  name: 'pay.merchantReceivingWallet.outsideFunds',
  kind: 'query',
  path: 'merchantReceivingWallet.outsideFunds',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: outsideFundsGetInputSchema,
  output: outsideFundsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
