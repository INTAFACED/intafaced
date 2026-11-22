import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { usageSummarySchema } from './agents-review.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `usage.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** What the current window would cost if it settled now. Bills nothing. */
export const AGENTS_USAGE_CURRENT = defineProcedure({
  ...base,
  name: 'agents.usage.current',
  kind: 'query',
  path: 'usage.current',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ sessionId: z.string().guid() }),
  output: z.object({ windowId: z.string(), pending: z.string(), sessionTotal: z.string(), assetId: z.string() }),
  samples: [
    { verdict: 'accept', input: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The person's usage from sealed windows: the newest `limit` windows, the count of all of them, and the totals by
 * agent, user and task, each adding up to the same total. `limit` is the caller's page size and is never defaulted.
 */
export const AGENTS_USAGE_SUMMARY = defineProcedure({
  ...base,
  name: 'agents.usage.summary',
  kind: 'query',
  path: 'usage.summary',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(500) }).strict(),
  output: usageSummarySchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
