import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { optionalFactorProof } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `apiKeys.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_API_KEYS_REVOKE = defineProcedure({
  ...base,
  name: 'identity.apiKeys.revoke',
  kind: 'mutation',
  path: 'apiKeys.revoke',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ keyId: z.string().guid() }),
  output: z.object({ revoked: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { keyId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_API_KEYS_CREATE = defineProcedure({
  ...base,
  name: 'identity.apiKeys.create',
  kind: 'mutation',
  path: 'apiKeys.create',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({
    name: z.string().min(1).max(64),
    scopes: z.array(z.string()).min(1),
    domainWhitelist: z.array(z.string()).optional(),
    /** pay.public-api step 4 — sandbox keys route to the sandbox rail. */
    mode: z.enum(['live', 'sandbox']).optional(),
    /** A TOTP code, passkey assertion or proof id verified in the last five minutes. */
    factorProof: optionalFactorProof,
  }),
  output: z.object({
    id: z.string(),
    key: z.string(),
    prefix: z.string(),
    mode: z.enum(['live', 'sandbox']),
    scopes: z.array(z.string()),
  }),
  samples: [
    { verdict: 'accept', input: { name: 'USDC', scopes: ['USDC'] } },
    { verdict: 'refuse', input: 42 },
  ],
});
