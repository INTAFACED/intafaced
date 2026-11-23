import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { curriculumPath } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `certPaths.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * AC-certificates-01: every learning path with its published certificate, or the refusal a path with no published
 * certificate design gets (`academy.certificate_unpublished`), so the Certificates tab shows each path in full layout.
 */
export const ACADEMY_CERT_PATHS = defineProcedure({
  ...base,
  name: 'academy.certPaths',
  kind: 'query',
  path: 'certPaths',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z.object({
      path: curriculumPath,
      certId: z.string().nullable(),
      refusal: z.literal('academy.certificate_unpublished').nullable(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});
