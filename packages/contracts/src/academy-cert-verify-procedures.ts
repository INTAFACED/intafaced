import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `certVerify.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Signed-out verification. The body is exactly the credential fields.
 * A blank rate refuses before any lookup. Malformed and unknown ids
 * share one not-found error.
 */
export const ACADEMY_CERT_VERIFY = defineProcedure({
  ...base,
  name: 'academy.certVerify',
  kind: 'query',
  path: 'certVerify',
  access: { caller: 'public' },
  refusals: {
    'academy.cert_not_found': 'NOT_FOUND',
    'academy.certificate_unpublished': 'PRECONDITION_FAILED',
    'academy.verify_address_unset': 'PRECONDITION_FAILED',
    'academy.verify_rate_limited': 'TOO_MANY_REQUESTS',
    'academy.verify_rate_unset': 'PRECONDITION_FAILED',
  },
  input: z.object({ publicId: z.string().max(200) }),
  output: z.object({
    certId: z.string(),
    title: z.string(),
    grantedAt: z.iso.datetime({ offset: true }),
    status: z.enum(['valid', 'revoked']),
    holderName: z.string().optional(),
  }),
  samples: [
    { verdict: 'accept', input: { publicId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
