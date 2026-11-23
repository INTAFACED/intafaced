import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { academyVideoPositionSavedSchema, academyVideoPositionSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `videoProgress.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

export const videoProgressOut = academyVideoPositionSchema;

export const ACADEMY_VIDEO_PROGRESS_GET = defineProcedure({
  ...base,
  name: 'academy.videoProgress.get',
  kind: 'query',
  path: 'videoProgress.get',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: { 'academy.video_not_found': 'NOT_FOUND' },
  input: z.object({ videoSlug: z.string().min(1).max(120) }),
  output: videoProgressOut,
  samples: [
    { verdict: 'accept', input: { videoSlug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_VIDEO_PROGRESS_SET = defineProcedure({
  ...base,
  name: 'academy.videoProgress.set',
  kind: 'mutation',
  path: 'videoProgress.set',
  access: { caller: 'scope', scope: 'academy:write', module: 'academy' },
  refusals: {
    'academy.cert_invalid': 'BAD_REQUEST',
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.grant_expired': 'FORBIDDEN',
    'academy.prerequisite_unmet': 'PRECONDITION_FAILED',
    'academy.slug_reserved': 'BAD_REQUEST',
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_not_found': 'NOT_FOUND',
    'academy.video_position_out_of_range': 'BAD_REQUEST',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: z.object({
    videoSlug: z.string().min(1).max(120),
    positionSeconds: z.number(),
    clientRequestId: z.string().min(1).max(200),
  }),
  output: academyVideoPositionSavedSchema,
  samples: [
    { verdict: 'accept', input: { videoSlug: 'placeholder', positionSeconds: 1, clientRequestId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
