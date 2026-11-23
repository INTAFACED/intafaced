import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { routeDeskSchema } from './agents-routes.js';
import { changeSchema } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `routes.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/**
 * The routing table as founders read it: each task with its provider and model alias (always from configuration),
 * its ceiling and rates in force now ("not set" is null), a rate that takes effect at the next window, the change
 * waiting for a second founder, the last change two founders made, and the newest audit rows.
 */
export const AGENTS_ROUTES_DESK = defineProcedure({
  ...base,
  name: 'agents.routes.desk',
  kind: 'query',
  path: 'routes.desk',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.route_change_person_only' },
  refusals: {},
  input: NO_INPUT,
  output: routeDeskSchema,
  samples: [{ verdict: 'accept' }],
});

export const AGENTS_ROUTES_PROPOSE = defineProcedure({
  ...base,
  name: 'agents.routes.propose',
  kind: 'mutation',
  path: 'routes.propose',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.route_change_person_only' },
  refusals: {},
  input: z.object({
    task: z.string().min(1).max(120),
    maxOutputTokens: z.number().int(),
    inputPerMillion: z.string().max(40).nullable(),
    outputPerMillion: z.string().max(40).nullable(),
    requestId: z.string().min(8).max(200),
  }),
  output: changeSchema,
  samples: [
    {
      verdict: 'accept',
      input: { task: 'USDC', maxOutputTokens: -9007199254740991, inputPerMillion: 'USDC', outputPerMillion: 'USDC', requestId: 'ethereum' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The proposer takes back their own pending change; nothing was applied. */
export const AGENTS_ROUTES_WITHDRAW = defineProcedure({
  ...base,
  name: 'agents.routes.withdraw',
  kind: 'mutation',
  path: 'routes.withdraw',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.route_change_person_only' },
  refusals: {},
  input: z.object({ changeId: z.string().uuid() }),
  output: changeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: { changeId: 'not-a-uuid' } },
  ],
});

/** A second founder, never the proposer, confirms a pending change: it is applied once, with its audit row. */
export const AGENTS_ROUTES_CONFIRM = defineProcedure({
  ...base,
  name: 'agents.routes.confirm',
  kind: 'mutation',
  path: 'routes.confirm',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.route_change_person_only' },
  refusals: {},
  input: z.object({ changeId: z.string().uuid() }),
  output: changeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: { changeId: 'not-a-uuid' } },
  ],
});

export const AGENTS_ROUTES_LIST = defineProcedure({
  ...base,
  name: 'agents.routes.list',
  kind: 'query',
  path: 'routes.list',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z.object({
      task: z.string(),
      maxOutputTokens: z.number().int(),
      capability: z.enum(['complete', 'stream', 'embed']),
      /** Null when this deployment publishes no rate for the task: it refuses every run (agents.price_unset). */
      inputPerMillion: z.string().nullable(),
      outputPerMillion: z.string().nullable(),
      assetId: assetIdSchema,
      engine: z.enum(['sandbox', 'live', 'unknown']),
      metered: z.boolean(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});
