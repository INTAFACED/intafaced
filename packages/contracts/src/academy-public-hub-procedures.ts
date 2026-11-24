import { defineProcedure, NO_INPUT } from './procedure.js';
import { academyPublicHubSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicHub.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-articles-01: the hub's featured slot, only what staff chose (a curriculum item or a course lesson); null when nobody chose one. */
export const ACADEMY_PUBLIC_HUB = defineProcedure({
  ...base,
  name: 'academy.publicHub',
  kind: 'query',
  path: 'publicHub',
  access: { caller: 'public' },
  refusals: {
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.sign_in_required': 'FORBIDDEN',
    'academy.slug_reserved': 'BAD_REQUEST',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: NO_INPUT,
  output: academyPublicHubSchema,
  samples: [{ verdict: 'accept' }],
});
