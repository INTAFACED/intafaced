import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { venueIncidentOutput } from './notify-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-notify `health.*`, one record per call: svc-notify mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;

export const NOTIFY_HEALTH = defineProcedure({
  ...base,
  name: 'notify.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    ok: z.boolean(),
    service: z.literal('svc-notify'),
    fanoutEnabled: z.boolean(),
    venueIncident: venueIncidentOutput,
  }),
  samples: [{ verdict: 'accept' }],
});
