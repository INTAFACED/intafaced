import { defineProcedure, NO_INPUT } from './procedure.js';
import { curriculumImportStatusOut } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `curriculumImportStatus.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Stage-3 import/status: pipeline + catalog expansion + polish readiness.
 * Does not invent licensed library content; workbook live-quote invent stays refused.
 */
export const ACADEMY_CURRICULUM_IMPORT_STATUS = defineProcedure({
  ...base,
  name: 'academy.curriculumImportStatus',
  kind: 'query',
  path: 'curriculumImportStatus',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: curriculumImportStatusOut,
  samples: [{ verdict: 'accept' }],
});
