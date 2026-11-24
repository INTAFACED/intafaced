import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { publicAmbassadorPayQuoteOut, residencyStatus } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `residencyPayQuote.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Public residency IFC door — refuse when rates unset (accepted residency is not payable).
 */
export const ACADEMY_RESIDENCY_PAY_QUOTE = defineProcedure({
  ...base,
  name: 'academy.residencyPayQuote',
  kind: 'query',
  path: 'residencyPayQuote',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: z.object({ residencyStatus: residencyStatus.optional() }).optional(),
  output: publicAmbassadorPayQuoteOut,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
