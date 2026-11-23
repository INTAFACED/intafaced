import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { mfaResetCancelSchema, mfaResetStatusSchema, mfaResetViewSchema } from './identity.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `mfaReset.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_MFA_RESET_STATUS = defineProcedure({
  ...base,
  name: 'identity.mfaReset.status',
  kind: 'query',
  path: 'mfaReset.status',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: mfaResetStatusSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_MFA_RESET_CANCEL = defineProcedure({
  ...base,
  name: 'identity.mfaReset.cancel',
  kind: 'mutation',
  path: 'mfaReset.cancel',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: mfaResetCancelSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_MFA_RESET_CONFIRM = defineProcedure({
  ...base,
  name: 'identity.mfaReset.confirm',
  kind: 'mutation',
  path: 'mfaReset.confirm',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ resetId: z.string().guid(), code: z.string().min(1).max(16) }).strict(),
  output: mfaResetViewSchema,
  samples: [
    { verdict: 'accept', input: { resetId: '11111111-1111-4111-8111-111111111111', code: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_MFA_RESET_START = defineProcedure({
  ...base,
  name: 'identity.mfaReset.start',
  kind: 'mutation',
  path: 'mfaReset.start',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ identifier: z.string().min(1).max(320), password: z.string().min(1).max(200) }).strict(),
  output: mfaResetViewSchema,
  samples: [
    { verdict: 'accept', input: { identifier: 'USDC', password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
