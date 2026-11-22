import { defineProcedure, NO_INPUT } from './procedure.js';
import { stateOut } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `authKeys.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_AUTH_KEYS_STATE = defineProcedure({
  ...base,
  name: 'identity.authKeys.state',
  kind: 'query',
  path: 'authKeys.state',
  access: { caller: 'founder' },
  refusals: {},
  input: NO_INPUT,
  output: stateOut,
  samples: [{ verdict: 'accept' }],
});
