import { defineProcedure, NO_INPUT } from './procedure.js';
import { stateOut, approval } from './identity-call-schemas.js';
import { z } from 'zod';

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

export const IDENTITY_AUTH_KEYS_ROTATE = defineProcedure({
  ...base,
  name: 'identity.authKeys.rotate',
  kind: 'mutation',
  path: 'authKeys.rotate',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object({ keyId: z.string().min(1).max(32), ...approval }).strict(),
  output: stateOut,
  samples: [
    { verdict: 'accept', input: { keyId: 'USDC', approvalId: 'USDC', operationId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_AUTH_KEYS_REMOVE_OLD = defineProcedure({
  ...base,
  name: 'identity.authKeys.removeOld',
  kind: 'mutation',
  path: 'authKeys.removeOld',
  access: { caller: 'founder' },
  refusals: {},
  input: z.object(approval).strict(),
  output: stateOut,
  samples: [
    { verdict: 'accept', input: { approvalId: 'USDC', operationId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
