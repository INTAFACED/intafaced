import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyIssuedCertDesignSchema } from './academy-cert-designs.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `myCerts.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const certGrantOut = z.object({
  userId: z.string().guid(),
  certId: z.string(),
  grantedAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string(),
  publicId: z.string().regex(/^[0-9a-f]{32}$/),
  /** `revoked` once staff revoked it (AC-certificates-03); the public check then says revoked too. */
  status: z.enum(['valid', 'revoked']).optional(),
  /** AC-certificates-03: the design revision this certificate prints, or null when it was issued before any was active. */
  design: academyIssuedCertDesignSchema.nullable().optional(),
});

export const ACADEMY_MY_CERTS = defineProcedure({
  ...base,
  name: 'academy.myCerts',
  kind: 'query',
  path: 'myCerts',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.my_certs_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({ limit: z.number().optional() }).optional(),
  output: z.array(certGrantOut),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
