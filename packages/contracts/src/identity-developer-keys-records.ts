import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { apiKeyRotateInputSchema, apiKeyRotateOutputSchema } from './api-keys.js';
import { optionalFactorProof } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `developerKeys.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** A key can never rotate itself here: a key's own request goes through the approval door instead. */
export const IDENTITY_DEVELOPER_KEYS_ROTATE = defineProcedure({
  ...base,
  name: 'identity.developerKeys.rotate',
  kind: 'mutation',
  path: 'developerKeys.rotate',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: apiKeyRotateInputSchema.extend({ factorProof: optionalFactorProof }),
  output: apiKeyRotateOutputSchema,
  outputChecks: {
    api_key_record_holds: { at: 'output.record', says: 'an exact key record' },
    iso_instant_holds: { at: 'output.replaced.endsAt', says: 'ISO instant' },
  },
  samples: [
    { verdict: 'accept', input: { keyId: '11111111-1111-4111-8111-111111111111', overlapSeconds: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The owner, signed in on a device with a fresh passkey, approves a key's request: one replacement issues. */
export const IDENTITY_DEVELOPER_KEYS_APPROVE_ROTATION = defineProcedure({
  ...base,
  name: 'identity.developerKeys.approveRotation',
  kind: 'mutation',
  path: 'developerKeys.approveRotation',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ requestId: z.string().uuid(), factorProof: optionalFactorProof }),
  output: apiKeyRotateOutputSchema,
  outputChecks: {
    api_key_record_holds: { at: 'output.record', says: 'an exact key record' },
    iso_instant_holds: { at: 'output.replaced.endsAt', says: 'ISO instant' },
  },
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
