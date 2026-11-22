import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `linkProviderStart.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** Link a provider account. With no provider registered this answers the allowlisted `idp.social`. */
export const IDENTITY_LINK_PROVIDER_START = defineProcedure({
  ...base,
  name: 'identity.linkProviderStart',
  kind: 'mutation',
  path: 'linkProviderStart',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ provider: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict(),
  output: z.object({ provider: z.string(), authorizationUrl: z.string(), expiresAt: z.string() }).strict(),
  samples: [
    { verdict: 'accept', input: { provider: 'x' } },
    { verdict: 'refuse', input: 42 },
  ],
});
