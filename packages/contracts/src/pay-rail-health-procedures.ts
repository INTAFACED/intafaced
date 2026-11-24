import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { RAIL_CAPABILITIES, RAIL_MODES } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `railHealth.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * What an operator dashboard renders, and what routing will read (§6.1).
 *
 * `mode` is on the wire because `usable: true, healthy: true` is what this
 * endpoint said about `card-sandbox` — and it was accurate and useless. A
 * console cannot answer "can users withdraw today" from health alone; a
 * sandbox is perfectly healthy at simulating.
 */
export const PAY_RAIL_HEALTH = defineProcedure({
  ...base,
  name: 'pay.railHealth',
  kind: 'query',
  path: 'railHealth',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z.object({
      id: z.string(),
      /**
       * DERIVED FROM THE PORT, not restated here.
       *
       * These two were hand-written literal unions — a second copy of a
       * vocabulary that already has an authority in `rails/rail-adapter.ts`.
       * The copy is what goes stale. Widening `RailCapability` for card
       * operations, or `RailMode` to carry `absent`, left this schema
       * narrower than the thing it describes, and a zod OUTPUT schema that
       * is narrower than its payload does not report a drift: it throws at
       * serialisation time, on an operator dashboard, in production.
       *
       * Reading the constants makes the compiler the thing that notices,
       * which it did — this line failed to build the moment the port grew.
       */
      capabilities: z.array(z.enum(RAIL_CAPABILITIES)),
      mode: z.enum(RAIL_MODES),
      usable: z.boolean(),
      healthy: z.boolean(),
      latencyMs: z.number(),
      reason: z.string().optional(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});
