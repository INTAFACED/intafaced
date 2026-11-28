import { defineProcedure, NO_INPUT } from './procedure.js';
import { optionsPolicyAnswer } from './trade-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-trade `options.*`, one record per call: svc-trade mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

export const TRADE_OPTIONS_POLICY = defineProcedure({
  ...base,
  name: 'trade.options.policy',
  kind: 'query',
  path: 'options.policy',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: optionsPolicyAnswer,
  samples: [{ verdict: 'accept' }],
});
