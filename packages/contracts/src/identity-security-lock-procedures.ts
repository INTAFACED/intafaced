import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { securityLockSchema } from './identity.js';
import { changeSchema } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `securityLock.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SECURITY_LOCK_READ = defineProcedure({
  ...base,
  name: 'identity.securityLock.read',
  kind: 'query',
  path: 'securityLock.read',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: securityLockSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_SECURITY_LOCK_SET = defineProcedure({
  ...base,
  name: 'identity.securityLock.set',
  kind: 'mutation',
  path: 'securityLock.set',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: changeSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_SECURITY_LOCK_REQUEST_UNLOCK = defineProcedure({
  ...base,
  name: 'identity.securityLock.requestUnlock',
  kind: 'mutation',
  path: 'securityLock.requestUnlock',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ clientRequestId: z.string().min(1).max(128), stepUpApprovalId: z.string().min(1).max(128).nullish() }).strict(),
  output: changeSchema,
  samples: [
    { verdict: 'accept', input: { clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
