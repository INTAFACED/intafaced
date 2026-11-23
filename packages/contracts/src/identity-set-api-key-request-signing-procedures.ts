import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { optionalFactorProof } from './identity-call-schemas.js';

/** svc-identity `setApiKeyRequestSigning`: svc-identity mounts it (`mountRecord`) and the developer pages call it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/**
 * Turn an API key's request signing, or its non-empty IP allowlist requirement, on or off. Top level (not under
 * `apiKeys`) so no router merge can replace `apiKeys.exchange`. identity:write, and the caller must own the key. The
 * signing secret is returned only on the call that first turns signing on; turning signing on needs a fresh factor.
 */
export const IDENTITY_SET_API_KEY_REQUEST_SIGNING = defineProcedure({
  ...base,
  name: 'identity.setApiKeyRequestSigning',
  kind: 'mutation',
  path: 'setApiKeyRequestSigning',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  checks: {
    'auth.signing_change_unset': { at: 'input', says: 'requireSignature or requireNonEmptyIpAllowlist is given' },
  },
  input: z
    .object({
      keyId: z.string().guid(),
      requireSignature: z.boolean().optional(),
      requireNonEmptyIpAllowlist: z.boolean().optional(),
      factorProof: optionalFactorProof,
    })
    .refine((value) => value.requireSignature !== undefined || value.requireNonEmptyIpAllowlist !== undefined),
  output: z.object({
    id: z.string().guid(),
    requireSignature: z.boolean(),
    requireNonEmptyIpAllowlist: z.boolean(),
    signingSecret: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { keyId: '11111111-1111-4111-8111-111111111111', requireNonEmptyIpAllowlist: true } },
    { verdict: 'refuse', input: { keyId: '11111111-1111-4111-8111-111111111111' }, by: 'auth.signing_change_unset' },
    { verdict: 'refuse', input: 42 },
  ],
});
