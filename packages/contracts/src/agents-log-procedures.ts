import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { actionLogCountSchema, actionLogExportPageSchema } from './agents-review.js';
import { actionOutput, outcome } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `log.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

export const AGENTS_LOG_MINE = defineProcedure({
  ...base,
  name: 'agents.log.mine',
  kind: 'query',
  path: 'log.mine',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z
    .object({ limit: z.number().int().min(1).max(500).optional(), outcome: z.enum(['executed', 'refused', 'failed']).optional() })
    .optional(),
  output: z.array(actionOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** How many rows the person's log holds, of one outcome or all: what an export of that filter will hold. */
export const AGENTS_LOG_COUNT = defineProcedure({
  ...base,
  name: 'agents.log.count',
  kind: 'query',
  path: 'log.count',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z.object({ outcome: outcome.optional() }).strict(),
  output: actionLogCountSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The person's whole log for an export, a page at a time, newest first, with the same outcome filter as the screen;
 * `nextCursor` is null on the last page. Blank limit refuses (`agents.log_mine_limit_unset`).
 */
export const AGENTS_LOG_EXPORT = defineProcedure({
  ...base,
  name: 'agents.log.export',
  kind: 'query',
  path: 'log.export',
  access: { caller: 'scope', scope: 'agents:read', module: 'agents' },
  refusals: {},
  input: z
    .object({
      outcome: outcome.optional(),
      cursor: z.string().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      /** The caller's id for this export: its last page writes one audit row keyed on it, so a retry writes none. */
      requestId: z.string().min(8).max(200).optional(),
      format: z.enum(['csv', 'json']).optional(),
    })
    .strict(),
  output: actionLogExportPageSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
