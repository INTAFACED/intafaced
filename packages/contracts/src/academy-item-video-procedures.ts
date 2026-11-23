import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyItemVideoSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `itemVideo.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-videos-01: the video attached to one curriculum item (null: none), so the reader shows its player. */
export const ACADEMY_ITEM_VIDEO = defineProcedure({
  ...base,
  name: 'academy.itemVideo',
  kind: 'query',
  path: 'itemVideo',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.curriculum_not_found': 'NOT_FOUND', 'academy.slug_reserved': 'BAD_REQUEST' },
  input: z.object({ itemSlug: z.string().min(1).max(120) }).strict(),
  output: academyItemVideoSchema,
  samples: [
    { verdict: 'accept', input: { itemSlug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
