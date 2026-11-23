import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { academyAccessGrantSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `myAccessGrants.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-access-grants-01: the caller's access records, with source and expiry. */
export const ACADEMY_MY_ACCESS_GRANTS = defineProcedure({
  ...base,
  name: 'academy.myAccessGrants',
  kind: 'query',
  path: 'myAccessGrants',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: z.array(academyAccessGrantSchema),
  samples: [{ verdict: 'accept' }],
});
