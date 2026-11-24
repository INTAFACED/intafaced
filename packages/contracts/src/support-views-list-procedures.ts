import { defineProcedure, NO_INPUT } from './procedure.js';
import { supportViewListSchema } from './support.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `viewsList.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

/** Saved filters this operator may open, and whether the owner has set a cap. */
export const SUPPORT_VIEWS_LIST = defineProcedure({
  ...base,
  name: 'support.viewsList',
  kind: 'query',
  path: 'viewsList',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: NO_INPUT,
  output: supportViewListSchema,
  outputChecks: {
    support_view_cap_holds: {
      at: ['output.personalCap', 'output.sharedCap'],
      says: 'a cap is a number or a missing setting, not both and not neither',
    },
  },
  samples: [{ verdict: 'accept' }],
});
