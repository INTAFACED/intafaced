import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  sandboxCreateInputSchema,
  sandboxCreateOutputSchema,
  sandboxGetInputSchema,
  sandboxGetOutputSchema,
  sandboxListOutputSchema,
} from './developer-sandboxes.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `developerSandboxes.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_DEVELOPER_SANDBOXES_LIST = defineProcedure({
  ...base,
  name: 'identity.developerSandboxes.list',
  kind: 'query',
  path: 'developerSandboxes.list',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: sandboxListOutputSchema,
  outputChecks: { iso_instant_holds: { at: 'output.sandboxes[].createdAt', says: 'ISO instant' } },
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_DEVELOPER_SANDBOXES_GET = defineProcedure({
  ...base,
  name: 'identity.developerSandboxes.get',
  kind: 'query',
  path: 'developerSandboxes.get',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: sandboxGetInputSchema,
  output: sandboxGetOutputSchema,
  outputChecks: {
    iso_instant_holds: { at: 'output.sandbox.createdAt', says: 'ISO instant' },
    api_key_record_holds: { at: 'output.keys[]', says: 'an exact key record' },
  },
  samples: [
    { verdict: 'accept', input: { sandboxId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_DEVELOPER_SANDBOXES_CREATE = defineProcedure({
  ...base,
  name: 'identity.developerSandboxes.create',
  kind: 'mutation',
  path: 'developerSandboxes.create',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: sandboxCreateInputSchema,
  output: sandboxCreateOutputSchema,
  outputChecks: { iso_instant_holds: { at: 'output.sandbox.createdAt', says: 'ISO instant' } },
  samples: [
    { verdict: 'accept', input: { requestId: 'ethereum', name: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
