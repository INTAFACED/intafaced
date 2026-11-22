import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { actionView, readInput } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `opsLog.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** The reasons an operator may pick, as the owner published them; blank refuses. Reads no log and writes nothing. */
export const AGENTS_OPS_LOG_REASONS = defineProcedure({
  ...base,
  name: 'agents.opsLog.reasons',
  kind: 'query',
  path: 'opsLog.reasons',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.log_read_person_only' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ reasons: z.array(z.string()) }),
  samples: [{ verdict: 'accept' }],
});

/**
 * One engine call's kept prompt text. Refuses before reading when retention is blank, and when the text was not kept
 * (retention 0, expired, or not an engine call). The digest is computed here from the text, never copied.
 */
export const AGENTS_OPS_LOG_TRANSCRIPT = defineProcedure({
  ...base,
  name: 'agents.opsLog.transcript',
  kind: 'mutation',
  path: 'opsLog.transcript',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.log_read_person_only' },
  refusals: {},
  input: z.object({
    actionId: z.string().guid(),
    reason: z.string().max(200).optional(),
    requestId: z.string().min(8).max(200),
  }),
  output: z.object({
    actionId: z.string(),
    userId: z.string(),
    text: z.string(),
    digest: z.string(),
    inputDigest: z.string().nullable(),
    storedAt: z.string(),
    expiresAt: z.string(),
    auditRows: z.number().int(),
    subjectReads: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { actionId: '11111111-1111-4111-8111-111111111111', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One page of a customer's agent actions, newest first, with the tools they used for the filter. */
export const AGENTS_OPS_LOG_ACTIONS = defineProcedure({
  ...base,
  name: 'agents.opsLog.actions',
  kind: 'mutation',
  path: 'opsLog.actions',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.log_read_person_only' },
  refusals: {},
  input: readInput,
  output: z.object({
    items: z.array(actionView),
    tools: z.array(z.string()),
    more: z.boolean(),
    limit: z.number().int(),
    auditRows: z.number().int(),
    subjectReads: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: 'USDC', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The same filter as a file: the rows the list shows for it, as CSV. */
export const AGENTS_OPS_LOG_EXPORT = defineProcedure({
  ...base,
  name: 'agents.opsLog.export',
  kind: 'mutation',
  path: 'opsLog.export',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.log_read_person_only' },
  refusals: {},
  input: readInput,
  output: z.object({
    csv: z.string(),
    rows: z.number().int(),
    more: z.boolean(),
    auditRows: z.number().int(),
    subjectReads: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { userId: 'USDC', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});
