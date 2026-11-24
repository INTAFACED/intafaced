import { defineProcedure, NO_INPUT } from './procedure.js';
import { staffTestStatusSchema } from './identity-staff.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * The caller's TEST staff role on a local or test stack (`IDENTITY_STAFF_TEST_ROSTER`), for the console's admission.
 * Self-only: the user id comes from the session. Production has no roster, so this is always `role: null` there,
 * and the console never asks it outside APP_ENV dev or test either.
 */
export const IDENTITY_STAFF_TEST_STATUS = defineProcedure({
  ...base,
  name: 'identity.staffTestStatus',
  kind: 'query',
  path: 'staffTestStatus',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: staffTestStatusSchema,
  samples: [{ verdict: 'accept' }],
});
