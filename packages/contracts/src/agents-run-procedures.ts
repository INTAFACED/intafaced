import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure } from './procedure.js';
import { RUN_NOTICES, sessionRunSchema, sessionRunStopSchema } from './agents-runs.js';
import { researchProvenanceSchema } from './agents-research.js';
import { runTraceSchema } from './agents-review.js';
import { actionOutput, byId } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `run.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** One of the caller's runs, with every step it took and the stop's answer. */
export const AGENTS_RUN_BACKGROUND_GET = defineProcedure({
  ...base,
  name: 'agents.run.background.get',
  kind: 'query',
  path: 'run.background.get',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: byId,
  output: sessionRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_RUN_BACKGROUND_PAUSE = defineProcedure({
  ...base,
  name: 'agents.run.background.pause',
  kind: 'mutation',
  path: 'run.background.pause',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: byId,
  output: sessionRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_RUN_BACKGROUND_RESUME = defineProcedure({
  ...base,
  name: 'agents.run.background.resume',
  kind: 'mutation',
  path: 'run.background.resume',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: byId,
  output: sessionRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Stops the run; pressed again, the first stop's answer is returned with `repeated`. */
export const AGENTS_RUN_BACKGROUND_STOP = defineProcedure({
  ...base,
  name: 'agents.run.background.stop',
  kind: 'mutation',
  path: 'run.background.stop',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: byId,
  output: sessionRunStopSchema,
  samples: [
    { verdict: 'accept', input: { runId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One more request to the run; while it is paused, refused `agents.run.paused`. */
export const AGENTS_RUN_BACKGROUND_ASK_MORE = defineProcedure({
  ...base,
  name: 'agents.run.background.askMore',
  kind: 'mutation',
  path: 'run.background.askMore',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({ runId: z.string().guid(), text: z.string().trim().min(1).max(20_000) }).strict(),
  output: sessionRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: '11111111-1111-4111-8111-111111111111', text: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Starts a run in the background on the caller's open session; the same request id again is that run. */
export const AGENTS_RUN_BACKGROUND_START = defineProcedure({
  ...base,
  name: 'agents.run.background.start',
  kind: 'mutation',
  path: 'run.background.start',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z
    .object({
      sessionId: z.string().guid(),
      requestId: z.string().min(8).max(200),
      task: z.string().min(1).max(120),
      ask: z.string().trim().min(1).max(20_000),
      steps: z.number().int().min(1),
      notice: z.enum(RUN_NOTICES),
    })
    .strict(),
  output: sessionRunSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        requestId: 'ethereum',
        task: 'USDC',
        ask: 'USDC',
        steps: 1,
        notice: 'inapp',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * One metered engine call, stored as a run.
 *
 * `requestId` is supplied by the CALLER and is the anti-double-bill
 * handle: a client that retries after a timeout reuses it, and the
 * usage is counted once no matter how many times the request arrives.
 */
export const AGENTS_RUN_COMPLETE = defineProcedure({
  ...base,
  name: 'agents.run.complete',
  kind: 'mutation',
  path: 'run.complete',
  access: { caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' },
  refusals: {},
  input: z.object({
    sessionId: z.string().guid(),
    requestId: z.string().min(8).max(200),
    task: z.string().min(1),
    system: z.string().max(20_000).optional(),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(200_000) }))
      .min(1)
      .max(200),
    maxOutputTokens: z.number().int().min(1).optional(),
  }),
  output: z.object({
    runId: z.string().guid(),
    text: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cost: z.string(),
    assetId: assetIdSchema,
    metered: z.boolean(),
    action: actionOutput,
    /** A Navigator answer about a market: its sources, observation time, assumptions and uncertainty. */
    provenance: researchProvenanceSchema.nullable(),
  }),
  samples: [
    {
      verdict: 'accept',
      input: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        requestId: 'ethereum',
        task: 'USDC',
        messages: [{ role: 'user', content: 'USDC' }],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One run of one of the person's sessions, by its request id, as timed steps and calls. Someone else's: not found. */
export const AGENTS_RUN_TRACE = defineProcedure({
  ...base,
  name: 'agents.run.trace',
  kind: 'query',
  path: 'run.trace',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ sessionId: z.string().guid(), requestId: z.string().min(1).max(200) }).strict(),
  output: runTraceSchema,
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111', requestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
