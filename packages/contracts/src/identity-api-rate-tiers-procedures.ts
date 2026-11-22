import { defineProcedure, NO_INPUT } from './procedure.js';
import { rateTiersOutputSchema } from './api-rate-limits.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `apiRateTiers.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_API_RATE_TIERS = defineProcedure({
  ...base,
  name: 'identity.apiRateTiers',
  kind: 'query',
  path: 'apiRateTiers',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: rateTiersOutputSchema,
  outputChecks: { iso_instant_holds: { at: 'output.asOf', says: 'ISO instant' } },
  samples: [{ verdict: 'accept' }],
});
