import { defineProcedure, NO_INPUT } from './procedure.js';
import { curriculumInventoryOut } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `curriculumInventory.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Stage-1 import pipeline inventory: content source decision + count gate.
 * titlePromiseMet is true when 20 playbooks + 3 workbooks exist (platform-native
 * expansion may close this without a licensed library dump).
 */
export const ACADEMY_CURRICULUM_INVENTORY = defineProcedure({
  ...base,
  name: 'academy.curriculumInventory',
  kind: 'query',
  path: 'curriculumInventory',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: curriculumInventoryOut,
  samples: [{ verdict: 'accept' }],
});
