import { defineProcedure, NO_INPUT } from './procedure.js';
import { serverTimeSchema } from './identity.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SERVER_TIME = defineProcedure({
  ...base,
  name: 'identity.serverTime',
  kind: 'query',
  path: 'serverTime',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: serverTimeSchema,
  samples: [{ verdict: 'accept' }],
});
