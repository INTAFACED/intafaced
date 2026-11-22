import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `videoPlayback.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * Signed expiring GET after tier/stake gate. URL without grant is refused.
 */
export const ACADEMY_VIDEO_PLAYBACK = defineProcedure({
  ...base,
  name: 'academy.videoPlayback',
  kind: 'query',
  path: 'videoPlayback',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_s3_region_unset': 'PRECONDITION_FAILED',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
    'academy.video_url_ttl_unset': 'PRECONDITION_FAILED',
  },
  input: z
    .object({
      slug: z.string().min(1).max(120),
      /** Raw object URL — refused unless it already carries a grant signature. */
      url: z.string().min(1).max(2000).optional(),
    })
    .strict(),
  output: z.object({
    slug: z.string(),
    playbackUrl: z.string(),
    expiresAt: z.iso.datetime({ offset: true }),
    grant: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
