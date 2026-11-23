import { defineProcedure, NO_INPUT } from './procedure.js';
import { requestSigningPolicySchema } from './api-keys.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_REQUEST_SIGNING_POLICY = defineProcedure({
  ...base,
  name: 'identity.requestSigningPolicy',
  kind: 'query',
  path: 'requestSigningPolicy',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: requestSigningPolicySchema,
  samples: [{ verdict: 'accept' }],
});
