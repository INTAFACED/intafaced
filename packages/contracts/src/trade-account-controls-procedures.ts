import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  accountControlHistoryInputSchema,
  accountControlInputSchema,
  accountControlResultSchema,
  accountControlLookupInputSchema,
  accountControlStateSchema,
} from './account-controls.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `accountControls.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_ACCOUNT_CONTROLS_HISTORY = defineProcedure({
  ...base,
  name: 'trade.accountControls.history',
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

export const TRADE_ACCOUNT_CONTROLS_GET_STATE = defineProcedure({
  ...base,
  name: 'trade.accountControls.getState',
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

/**
 * svc-trade's change takes one input whatever its four-eyes setting: an `approvalId` is optional here, and the service
 * refuses with BAD_REQUEST, before anything runs, an id sent while the setting is off or one missing while it is on.
 */
export const tradeAccountControlChangeInputSchema = accountControlInputSchema
  .extend({ approvalId: z.string().trim().min(1).max(128).optional() })
  .strict();

export const TRADE_ACCOUNT_CONTROLS_CHANGE = defineProcedure({
  ...base,
  name: 'trade.accountControls.change',
  kind: 'mutation',
  path: 'accountControls.change',
  access: { caller: 'signedIn' },
  refusals: {},
  input: tradeAccountControlChangeInputSchema,
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
        target: { area: 'trading', userId: '11111111-1111-4111-8111-111111111111' },
        action: 'restrict',
        reason: 'Inspect activity',
        expectedVersion: '0',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
