import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { type CoachRefusalCode, COACH_REFUSAL_CODES } from './agents-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

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

/**
 * One Coach answer inside a lesson (RC-agents-02): a metered run whose citations are only lessons the curriculum
 * returned. Refusals are typed results, not errors, so the panel shows each by its code. `requestId` is the
 * person's business key: a retry with it returns the stored answer and never calls the engine twice.
 */
export const AGENTS_COACH_RUN_SESSION = defineProcedure({
  ...base,
  name: 'agents.coach.runSession',
  kind: 'mutation',
  path: 'coach.runSession',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents', person: true, check: 'coachRun' },
  refusals: {},
  input: z.object({
    question: z.string().trim().min(1).max(2000),
    lessonSlug: z
      .string()
      .regex(/^[a-z0-9-]{1,128}$/)
      .optional(),
    requestId: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  }),
  output: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('answered'),
      answer: z.string(),
      citations: z.array(z.object({ slug: z.string(), title: z.string() })).min(1),
      nextLesson: z.object({ slug: z.string(), title: z.string() }).nullable(),
      engine: z.enum(['sandbox', 'live', 'unknown']),
      sessionId: z.string().guid(),
      runKey: z.string(),
      assetId: assetIdSchema,
      charge: z.discriminatedUnion('state', [
        z.object({ state: z.literal('settled'), billedAmount: z.string() }),
        z.object({ state: z.literal('unpaid'), code: z.string() }),
      ]),
      replayed: z.boolean(),
    }),
    z.object({ status: z.literal('not_covered'), citations: z.array(z.never()).length(0) }),
    z.object({
      status: z.literal('refused'),
      code: z.enum(COACH_REFUSAL_CODES as [CoachRefusalCode, ...CoachRefusalCode[]]),
    }),
  ]),
  // By hand: the wire replay's recorded request ({ requestId: 'x' }) fails the request id's own pattern, so the door never
  // let it through; this is the ask svc-agents' own Coach test runs (crates/svc-agents/tests/advisors_pg.rs).
  samples: [
    {
      verdict: 'accept',
      input: { question: 'What does risk first mean?', lessonSlug: 'foundations-risk-first', requestId: 'coach:db:0001' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
