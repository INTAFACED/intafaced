import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';

/**
 * svc-execution's calls the apps make, one record per call. The service mounts each from here (`mountRecord`), so its
 * path, guard and reply are this file, not its router.
 */

const base = { service: 'svc-execution', module: 'execution', transport: 'trpc' } as const;

/** The spine refuses nothing of its own: only its guard (sign-in, scope, region) refuses. */
const NONE: Refusals = Object.freeze({});

/** `execution.spine`: every execution door and the house rule that it routes outside only (`oms-spine.ts`). */
export const EXECUTION_SPINE = defineProcedure({
  ...base,
  name: 'execution.spine',
  kind: 'query',
  path: 'execution.spine',
  access: { caller: 'scope', scope: 'admin:read', module: 'execution' },
  refusals: NONE,
  input: NO_INPUT,
  output: z.object({
    doors: z.array(
      z.object({ id: z.string(), module: z.string(), kind: z.string(), inventsQuotes: z.literal(false), callerSubmit: z.boolean() }),
    ),
    sorUsesVenueAdapterPlanRoute: z.boolean(),
    externalOnly: z.boolean(),
    houseInternalRefuse: z.boolean(),
  }),
  samples: [{ verdict: 'accept' }],
});
