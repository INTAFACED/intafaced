import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { filterInput, FLEET_ACTIONS, FLEET_KINDS, fleetRowSchema, ref, requestId } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `fleet.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** One page of the registry under a filter, with the counts over the whole fleet and how many rows the filter matches. */
export const AGENTS_FLEET_REGISTRY = defineProcedure({
  ...base,
  name: 'agents.fleet.registry',
  kind: 'query',
  path: 'fleet.registry',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object(filterInput).optional(),
  output: z.object({
    counts: z.object({
      total: z.number().int(),
      ownerless: z.number().int(),
      unmanaged: z.number().int(),
      disabled: z.number().int(),
      quarantined: z.number().int(),
    }),
    rows: z.array(fleetRowSchema),
    filtered: z.number().int(),
    more: z.boolean(),
    limit: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The newest rows of the fleet's audit log (one read shows AGENTS_REGISTRY_LIST_LIMIT rows), newest first. */
export const AGENTS_FLEET_AUDIT = defineProcedure({
  ...base,
  name: 'agents.fleet.audit',
  kind: 'query',
  path: 'fleet.audit',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    rows: z.array(
      z.object({
        id: z.string(),
        at: z.string(),
        operatorId: z.string(),
        action: z.enum(FLEET_ACTIONS),
        agentRef: z.string().nullable(),
        kind: z.string().nullable(),
        reason: z.string().nullable(),
        filter: z.record(z.string(), z.string()),
        rowCount: z.number().int().nullable(),
        requestId: z.string(),
      }),
    ),
    limit: z.number().int(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The filtered registry as CSV over the full range, never the loaded page, with one audit row per request id. */
export const AGENTS_FLEET_EXPORT = defineProcedure({
  ...base,
  name: 'agents.fleet.export',
  kind: 'mutation',
  path: 'fleet.export',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object({ ...filterInput, requestId }),
  output: z.object({ csv: z.string(), rows: z.number().int(), auditRows: z.number().int() }),
  samples: [
    { verdict: 'accept', input: { requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_FLEET_QUARANTINE = defineProcedure({
  ...base,
  name: 'agents.fleet.quarantine',
  kind: 'mutation',
  path: 'fleet.quarantine',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object({ ref, reason: z.string().max(500).optional(), requestId }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { ref: 'USDC', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_FLEET_RESTORE = defineProcedure({
  ...base,
  name: 'agents.fleet.restore',
  kind: 'mutation',
  path: 'fleet.restore',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object({ ref, requestId }),
  output: z.object({ outcome: z.enum(['waiting_second_founder', 'restored']) }),
  samples: [
    { verdict: 'accept', input: { ref: 'USDC', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_FLEET_KILL_KIND = defineProcedure({
  ...base,
  name: 'agents.fleet.killKind',
  kind: 'mutation',
  path: 'fleet.killKind',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object({ kind: z.enum(FLEET_KINDS), reason: z.string().max(500).optional(), requestId }),
  output: z.object({ agents: z.number().int() }),
  samples: [
    { verdict: 'accept', input: { kind: 'customer_built', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_FLEET_RESTORE_KIND = defineProcedure({
  ...base,
  name: 'agents.fleet.restoreKind',
  kind: 'mutation',
  path: 'fleet.restoreKind',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object({ kind: z.enum(FLEET_KINDS), requestId }),
  output: z.object({ outcome: z.enum(['waiting_second_founder', 'restored']) }),
  samples: [
    { verdict: 'accept', input: { kind: 'customer_built', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const AGENTS_FLEET_REASSIGN = defineProcedure({
  ...base,
  name: 'agents.fleet.reassign',
  kind: 'mutation',
  path: 'fleet.reassign',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' },
  refusals: {},
  input: z.object({ ref, ownerId: z.string().uuid(), requestId }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { ref: 'USDC', ownerId: '11111111-1111-4111-8111-111111111111', requestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});
