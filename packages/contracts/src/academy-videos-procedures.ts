import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { curriculumPath } from './academy-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `videos.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Stored VOD catalog (TRK-academy.video). Not LiveKit.
 *
 * Unconfigured storage → academy.video_storage_unconfigured.
 * Does not list the bucket (Class X residual).
 */
export const ACADEMY_VIDEOS = defineProcedure({
  ...base,
  name: 'academy.videos',
  kind: 'query',
  path: 'videos',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.video_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      path: curriculumPath,
      durationSeconds: z.number().int().nullable(),
      thumbnailUrl: z.string().nullable(),
      language: z.string().nullable(),
      captionsUrl: z.string().nullable(),
      captionsPublished: z.boolean(),
      transcriptPublished: z.boolean(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});
