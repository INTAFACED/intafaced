import { defineProcedure, NO_INPUT } from './procedure.js';
import { curriculumDepthOut } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `curriculumDepth.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Depth inventory over the library. `curriculumInventory` answers "are there
 * 20 playbooks and 3 workbooks"; its validation floor is 40 characters, which
 * a three-bullet stub clears. This answers the second question — is any of it
 * long enough to be worth reading — and it answers by NAMING what falls short
 * in `thinSlugs` rather than asserting that nothing does.
 */
export const ACADEMY_CURRICULUM_DEPTH = defineProcedure({
  ...base,
  name: 'academy.curriculumDepth',
  kind: 'query',
  path: 'curriculumDepth',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: curriculumDepthOut,
  samples: [{ verdict: 'accept' }],
});
