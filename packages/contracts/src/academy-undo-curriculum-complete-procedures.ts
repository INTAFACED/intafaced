import { defineProcedure } from './procedure.js';
import { academyUndoCompletionInputSchema, academyUndoCompletionSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `undoCurriculumComplete.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-progress-01: Undo a completion. Progress drops and the history keeps both events; completing again adds one. */
export const ACADEMY_UNDO_CURRICULUM_COMPLETE = defineProcedure({
  ...base,
  name: 'academy.undoCurriculumComplete',
  kind: 'mutation',
  path: 'undoCurriculumComplete',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: { 'academy.curriculum_not_found': 'NOT_FOUND', 'academy.request_reused': 'CONFLICT', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyUndoCompletionInputSchema,
  output: academyUndoCompletionSchema,
  samples: [
    { verdict: 'accept', input: { itemSlug: 'placeholder', completedAt: '2026-01-01T00:00:00.000Z', clientRequestId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
