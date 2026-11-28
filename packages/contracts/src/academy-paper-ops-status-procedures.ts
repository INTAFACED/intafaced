import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { PAPER_OPS_ENV_KEY, PAPER_OPS_FLAG_ID, SIMULATED_VENUE } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `paperOpsStatus.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Stage-3 ops status for paper drills (TRK-academy.paper-trading).
 * Reports enable/kill only — never invents prices; live trade unaffected.
 */
export const ACADEMY_PAPER_OPS_STATUS = defineProcedure({
  ...base,
  name: 'academy.paperOpsStatus',
  kind: 'query',
  path: 'paperOpsStatus',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    enabled: z.boolean(),
    flagId: z.literal(PAPER_OPS_FLAG_ID),
    envKey: z.literal(PAPER_OPS_ENV_KEY),
    liveTradeUnaffected: z.literal(true),
    simulated: z.literal(true),
    venue: z.literal(SIMULATED_VENUE),
    realMoney: z.literal(false),
  }),
  samples: [{ verdict: 'accept' }],
});
