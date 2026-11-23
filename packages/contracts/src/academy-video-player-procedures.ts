import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyVideoPlayerSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `videoPlayer.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/**
 * AC-videos-01: the player's caption tracks (as cues; the transcript is the same cues), the renditions that exist and
 * the owner's save interval and watch threshold. Behind the same storage, tier and stake gate as playback.
 */
export const ACADEMY_VIDEO_PLAYER = defineProcedure({
  ...base,
  name: 'academy.videoPlayer',
  kind: 'query',
  path: 'videoPlayer',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.captions_invalid': 'BAD_REQUEST',
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_not_found': 'NOT_FOUND',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
  },
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: academyVideoPlayerSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
