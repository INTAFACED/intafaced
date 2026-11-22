import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { optionalFactorProof } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `unbindApiKeyIpAllowlist.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_UNBIND_API_KEY_IP_ALLOWLIST = defineProcedure({
  ...base,
  name: 'identity.unbindApiKeyIpAllowlist',
  kind: 'mutation',
  path: 'unbindApiKeyIpAllowlist',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ keyId: z.string().guid(), ip: z.string(), factorProof: optionalFactorProof }),
  output: z.object({
    id: z.string().guid(),
    ipAllowlist: z.array(z.string()),
    requireSignature: z.boolean(),
    requireNonEmptyIpAllowlist: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { keyId: '11111111-1111-4111-8111-111111111111', ip: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
