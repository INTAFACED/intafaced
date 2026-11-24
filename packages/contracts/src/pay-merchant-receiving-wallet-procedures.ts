import { defineProcedure } from './procedure.js';
import {
  outsideFundsGetInputSchema,
  outsideFundsSchema,
  receivingWalletGetInputSchema,
  receivingWalletSchema,
  receivingWalletSaveInputSchema,
  receivingWalletSavedSchema,
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

export const PAY_MERCHANT_RECEIVING_WALLET_SAVE = defineProcedure({
  ...base,
  name: 'pay.merchantReceivingWallet.save',
  kind: 'mutation',
  path: 'merchantReceivingWallet.save',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: receivingWalletSaveInputSchema,
  output: receivingWalletSavedSchema,
  samples: [
    {
      verdict: 'accept',
      input: { requestId: '11111111-1111-4111-8111-111111111111', expectedVersion: 0, family: 'evm', extendedPublicKey: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
