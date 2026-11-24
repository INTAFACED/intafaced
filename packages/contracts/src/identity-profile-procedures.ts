import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { antiPhishingCodeSchema, antiPhishingSetResultSchema } from './identity.js';
import { profileOutput } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `profile.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** The signed-in user's own profile. Region is visible and not editable. */
export const IDENTITY_PROFILE_GET = defineProcedure({
  ...base,
  name: 'identity.profile.get',
  kind: 'query',
  path: 'profile.get',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: profileOutput,
  samples: [{ verdict: 'accept' }],
});

/** The caller's own code, or null. A live session only; this answer carries nothing else. */
export const IDENTITY_PROFILE_ANTI_PHISHING_GET = defineProcedure({
  ...base,
  name: 'identity.profile.antiPhishing.get',
  kind: 'query',
  path: 'profile.antiPhishing.get',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: antiPhishingCodeSchema,
  samples: [{ verdict: 'accept' }],
});

/** Set the code, or clear it with ''. Needs the step-up `identity.step_up.anti_phishing_set` over this code and request id. */
export const IDENTITY_PROFILE_ANTI_PHISHING_SET = defineProcedure({
  ...base,
  name: 'identity.profile.antiPhishing.set',
  kind: 'mutation',
  path: 'profile.antiPhishing.set',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z
    .object({
      // Wide wire bounds only; the service checks the real shape and answers identity.anti_phishing_invalid.
      code: z.string().max(256),
      stepUpApprovalId: z.string().guid(),
      clientRequestId: z.string().max(256),
    })
    .strict(),
  output: antiPhishingSetResultSchema,
  samples: [
    { verdict: 'accept', input: { code: 'USDC', stepUpApprovalId: '11111111-1111-4111-8111-111111111111', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
