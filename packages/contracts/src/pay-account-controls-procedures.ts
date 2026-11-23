import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  accountControlHistoryInputSchema,
  accountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlResultSchema,
  accountControlStateSchema,
} from './account-controls.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `accountControls.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_ACCOUNT_CONTROLS_GET_STATE = defineProcedure({
  ...base,
  name: 'pay.accountControls.getState',
  kind: 'query',
  path: 'accountControls.getState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlLookupInputSchema,
  output: accountControlStateSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_ACCOUNT_CONTROLS_HISTORY = defineProcedure({
  ...base,
  name: 'pay.accountControls.history',
  kind: 'query',
  path: 'accountControls.history',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlHistoryInputSchema,
  output: z.array(accountControlResultSchema),
  outputChecks: {
    account_control_result_holds: {
      at: 'output[]',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different target; Outcome, action and state versions disagree',
    },
  },
  samples: [
    { verdict: 'accept', input: { target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' }, limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_ACCOUNT_CONTROLS_CHANGE = defineProcedure({
  ...base,
  name: 'pay.accountControls.change',
  kind: 'mutation',
  path: 'accountControls.change',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlInputSchema,
  output: accountControlResultSchema,
  outputChecks: {
    account_control_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different target; Outcome, action and state versions disagree',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' },
        action: 'restrict',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
