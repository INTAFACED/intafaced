import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `coach.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const AGENTS_COACH_SESSION = defineProcedure({
  ...base,
  name: 'agents.coach.session',
  kind: 'query',
  path: 'coach.session',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({
    ask: z.string().max(2000).optional(),
    requestedSlug: z.string().min(1).max(128).optional(),
    includePositions: z.boolean().optional(),
    asAdvice: z.boolean().optional(),
  }),
  output: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('refuse'),
      reason: z.enum(['curriculum_empty', 'library_import_pending', 'invented_library', 'positions_not_decided', 'advice_forbidden']),
      kind: z.literal('not_advice'),
      isAdvice: z.literal(false),
      positionsReferenced: z.literal(false),
      licensedLibraryImported: z.boolean(),
      inventedLibrary: z.literal(false),
      citedCount: z.literal(0),
      userMessageKey: z.literal('agents.error.capability_unavailable'),
    }),
    z.object({
      status: z.literal('grounded'),
      kind: z.literal('citation'),
      isAdvice: z.literal(false),
      positionsReferenced: z.literal(false),
      licensedLibraryImported: z.boolean(),
      inventedLibrary: z.literal(false),
      citedCount: z.number().int(),
      citations: z.array(z.object({ slug: z.string(), title: z.string() })),
      userMessageKey: z.literal('agents.error.capability_unavailable'),
    }),
  ]),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
