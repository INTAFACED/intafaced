import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { academyPublicVideoSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `publicVideos.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** The video list a visitor sees: the same refusal as signed in when storage is not configured. */
export const ACADEMY_PUBLIC_VIDEOS = defineProcedure({
  ...base,
  name: 'academy.publicVideos',
  kind: 'query',
  path: 'publicVideos',
  access: { caller: 'public' },
  refusals: { 'academy.video_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: z.array(academyPublicVideoSchema),
  samples: [{ verdict: 'accept' }],
});
