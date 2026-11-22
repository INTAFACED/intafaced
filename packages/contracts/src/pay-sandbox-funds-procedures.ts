import { defineProcedure } from './procedure.js';
import {
  sandboxBalanceInputSchema,
  sandboxBalanceOutputSchema,
  sandboxFundInputSchema,
  sandboxFundOutputSchema,
  sandboxResetInputSchema,
  sandboxResetOutputSchema,
} from './developer-sandboxes.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `sandboxFunds.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_SANDBOX_FUNDS_BALANCE = defineProcedure({
  ...base,
  name: 'pay.sandboxFunds.balance',
  kind: 'query',
  path: 'sandboxFunds.balance',
  access: { caller: 'scope', scope: 'trade:read', person: true },
  refusals: {},
  input: sandboxBalanceInputSchema,
  output: sandboxBalanceOutputSchema,
  samples: [
    { verdict: 'accept', input: { sandboxId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_SANDBOX_FUNDS_FUND = defineProcedure({
  ...base,
  name: 'pay.sandboxFunds.fund',
  kind: 'mutation',
  path: 'sandboxFunds.fund',
  access: { caller: 'scope', scope: 'trade:write', person: true },
  refusals: {},
  input: sandboxFundInputSchema,
  output: sandboxFundOutputSchema,
  samples: [
    { verdict: 'accept', input: { sandboxId: '11111111-1111-4111-8111-111111111111', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_SANDBOX_FUNDS_RESET = defineProcedure({
  ...base,
  name: 'pay.sandboxFunds.reset',
  kind: 'mutation',
  path: 'sandboxFunds.reset',
  access: { caller: 'scope', scope: 'trade:write', person: true },
  refusals: {},
  input: sandboxResetInputSchema,
  output: sandboxResetOutputSchema,
  samples: [
    { verdict: 'accept', input: { sandboxId: '11111111-1111-4111-8111-111111111111', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});
