import { defineProcedure, NO_INPUT } from './procedure.js';
import { certXpPlaneOut } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `certXpPlane.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Stage-2 XP plane status: is this process publishing awards at all, under
 * which module/action, and what each cert is worth. Answers "my cert did not
 * move my rank" without guessing — `emitEnabled: false` is a deployment
 * fact, not a ladder disagreement.
 */
export const ACADEMY_CERT_XP_PLANE = defineProcedure({
  ...base,
  name: 'academy.certXpPlane',
  kind: 'query',
  path: 'certXpPlane',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: NO_INPUT,
  output: certXpPlaneOut,
  samples: [{ verdict: 'accept' }],
});
