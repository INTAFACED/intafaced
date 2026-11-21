import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `ambassadorPayPlane.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * IFC pay / revenue share under rate authority (D26-P1-C2).
 * Settlement stays dark (no ledger recipe). Quote path opens when owner rates published.
 */
export const ACADEMY_AMBASSADOR_PAY_PLANE = defineProcedure({
  ...base,
  name: 'academy.ambassadorPayPlane',
  kind: 'query',
  path: 'ambassadorPayPlane',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    ifcPayEnabled: z.literal(false),
    revenueShareEnabled: z.literal(false),
    ifcRateAuthorityPublished: z.boolean(),
    revenueShareRateAuthorityPublished: z.boolean(),
    ifcPayQuoteEnabled: z.boolean(),
    revenueShareQuoteEnabled: z.boolean(),
    classM: z.literal(true),
    residualIfcPay: z.string(),
    residualRevenueShare: z.string(),
  }),
  samples: [{ verdict: 'accept' }],
});
