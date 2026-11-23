import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { optionalFactorProof } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `rotateSigningSecret.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * Replace the HMAC secret without turning the requirement off.
 * One transaction, so the key never accepts an unsigned call in between.
 * The new secret is returned once. identity:write, and the caller must own the key.
 */
export const IDENTITY_ROTATE_SIGNING_SECRET = defineProcedure({
  ...base,
  name: 'identity.rotateSigningSecret',
  kind: 'mutation',
  path: 'rotateSigningSecret',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ keyId: z.string().guid(), factorProof: optionalFactorProof }),
  output: z.object({ id: z.string().guid(), signingSecret: z.string() }),
  samples: [
    { verdict: 'accept', input: { keyId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
