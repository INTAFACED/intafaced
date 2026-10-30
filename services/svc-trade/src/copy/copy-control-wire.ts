/**
 * Wire enums for copy control acks. Each door's disposition is a subset of the
 * exported constants, so a new value cannot leave the service unpinned.
 */
import { z } from 'zod';
import { COPY_FLATTEN_DISPOSITION } from './copy-flatten.js';
import { COPY_CONTROL_DISPOSITIONS, COPY_RELATIONSHIP_STATES } from './copy-lifecycle.js';

export const COPY_PAUSE_DISPOSITIONS = ['PAUSE_NEW'] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];
export const COPY_STOP_DISPOSITIONS = [
  'STOP_NEW',
  'STOP_CLOSE_ONLY',
] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];
export const COPY_DETACH_DISPOSITIONS = ['DETACH_KEEP'] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];
export const COPY_RESUME_DISPOSITIONS = ['RESUME'] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];
export const COPY_FLATTEN_WIRE_DISPOSITIONS = [COPY_FLATTEN_DISPOSITION] as const;

function wireEnum<T extends string>(values: readonly [T, ...T[]]) {
  return z.enum(values as [T, ...T[]]);
}

const relationshipState = wireEnum(COPY_RELATIONSHIP_STATES);

function controlOutput<T extends string>(disposition: readonly [T, ...T[]]) {
  return z.object({
    followId: z.string(),
    relationshipState,
    disposition: wireEnum(disposition),
    newIntentFenced: z.boolean(),
    flattenInvented: z.literal(false),
    sessionKeyRevoked: z.boolean(),
  });
}

export const copyPauseOutput = controlOutput(COPY_PAUSE_DISPOSITIONS);
export const copyStopOutput = controlOutput(COPY_STOP_DISPOSITIONS);
export const copyDetachOutput = controlOutput(COPY_DETACH_DISPOSITIONS);
export const copyResumeOutput = controlOutput(COPY_RESUME_DISPOSITIONS);

export const copyFlattenOutput = z.object({
  followId: z.string(),
  relationshipState: z.literal('DETACHED'),
  disposition: wireEnum(COPY_FLATTEN_WIRE_DISPOSITIONS),
  newIntentFenced: z.literal(true),
  flattenChosen: z.literal(true),
  flattenInvented: z.literal(false),
  sessionKeyRevoked: z.literal(true),
  orderIds: z.array(z.string()).readonly(),
});
