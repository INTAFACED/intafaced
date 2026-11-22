import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { settingsOutput } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `handle.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** The caller's own handle, whether people can find them by it, and the changes used and left. */
export const IDENTITY_HANDLE_GET = defineProcedure({
  ...base,
  name: 'identity.handle.get',
  kind: 'query',
  path: 'handle.get',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: settingsOutput,
  samples: [{ verdict: 'accept' }],
});

/** Change the handle from `fromHandle` to `handle`. Rule, cap and taken refusals each carry their own code. */
export const IDENTITY_HANDLE_CHANGE = defineProcedure({
  ...base,
  name: 'identity.handle.change',
  kind: 'mutation',
  path: 'handle.change',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ handle: z.string().max(64), fromHandle: z.string().max(64) }).strict(),
  output: settingsOutput,
  samples: [
    { verdict: 'accept', input: { handle: 'USDC', fromHandle: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Let people find me by my handle, or not. Off, others' handle lookups answer not found. */
export const IDENTITY_HANDLE_SET_DISCOVERABLE = defineProcedure({
  ...base,
  name: 'identity.handle.setDiscoverable',
  kind: 'mutation',
  path: 'handle.setDiscoverable',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ discoverable: z.boolean() }).strict(),
  output: settingsOutput,
  samples: [
    { verdict: 'accept', input: { discoverable: true } },
    { verdict: 'refuse', input: 42 },
  ],
});
