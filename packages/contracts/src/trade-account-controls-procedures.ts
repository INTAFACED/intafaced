import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { accountControlHistoryInputSchema, accountControlResultSchema } from './account-controls.js';

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
