import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  ALLOCATION_METHODS,
  amountString,
  approvalFields,
  createInput,
  eventOutput,
  ISSUER_STATES,
  LAUNCH_STATES,
  LAUNCH_STATUSES,
  LAUNCH_TYPES,
  launchId,
} from './token-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-token `launch.*`, one record per call: svc-token mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-token', module: 'token', transport: 'trpc' } as const;

export const TOKEN_LAUNCH_ADMIN_MOVES = defineProcedure({
  ...base,
  name: 'token.launch.admin.moves',
  kind: 'query',
  path: 'launch.admin.moves',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: z.object({ kind: z.enum(['issuer', 'event']), ids: z.array(launchId).min(1).max(200) }),
  output: z.record(
    z.string(),
    z.array(
      z.object({
        ordinal: z.number().int(),
        from: z.string().nullable(),
        to: z.string(),
        actorId: z.string(),
        approverId: z.string(),
        cause: z.string().nullable(),
        at: z.string(),
      }),
    ),
  ),
  samples: [
    { verdict: 'accept', input: { kind: 'issuer', ids: ['USDC'] } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_ADMIN_ISSUERS = defineProcedure({
  ...base,
  name: 'token.launch.admin.issuers',
  kind: 'query',
  path: 'launch.admin.issuers',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: { 'launch.events_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).default({}),
  output: z.array(z.object({ id: z.string(), name: z.string(), state: z.enum(ISSUER_STATES), revision: z.number().int() })),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_ADMIN_EVENTS = defineProcedure({
  ...base,
  name: 'token.launch.admin.events',
  kind: 'query',
  path: 'launch.admin.events',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: { 'launch.events_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).default({}),
  output: z.array(eventOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_ISSUER_SET = defineProcedure({
  ...base,
  name: 'token.launch.issuer.set',
  kind: 'mutation',
  path: 'launch.issuer.set',
  access: { caller: 'scope', scope: 'admin:write' },
  refusals: { 'launch.issuer_move_invalid': 'BAD_REQUEST' },
  input: z.object({
    id: launchId,
    name: z.string().min(1).max(120),
    state: z.enum(ISSUER_STATES),
    expectedRevision: z.number().int().min(0),
    ...approvalFields,
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    state: z.enum(ISSUER_STATES),
    revision: z.number().int(),
    confirmOperatorId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', name: 'USDC', state: 'applied', expectedRevision: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_EVENTS_CREATE = defineProcedure({
  ...base,
  name: 'token.launch.events.create',
  kind: 'mutation',
  path: 'launch.events.create',
  access: { caller: 'scope', scope: 'admin:write' },
  refusals: { 'launch.event_invalid': 'BAD_REQUEST', 'launch.issuer_not_found': 'NOT_FOUND', missing_operator: 'PRECONDITION_FAILED' },
  input: createInput.extend(approvalFields),
  output: z.object({ id: z.string(), status: z.enum(LAUNCH_STATUSES), revision: z.number().int(), confirmOperatorId: z.string() }),
  samples: [
    {
      verdict: 'accept',
      input: {
        id: 'USDC',
        issuerId: 'USDC',
        type: 'token_sale',
        projectName: 'USDC',
        symbol: 'USDC',
        periods: {
          announceAt: '2026-01-01T00:00:00.000Z',
          snapshotAt: '2026-01-01T00:00:00.000Z',
          openAt: '2026-01-01T00:00:00.000Z',
          closeAt: '2026-01-01T00:00:00.000Z',
          distributionAt: '2026-01-01T00:00:00.000Z',
        },
        allocation: { method: 'pro_rata', perUserCap: '1', ticketSize: '1', tierWeights: [] },
        terms: { price: '1', paymentAsset: 'USDC', rateSource: 'USDC' },
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_EVENTS_MOVE = defineProcedure({
  ...base,
  name: 'token.launch.events.move',
  kind: 'mutation',
  path: 'launch.events.move',
  access: { caller: 'scope', scope: 'admin:write' },
  refusals: { 'action_approval.missing': 'PRECONDITION_FAILED', 'launch.event_stale': 'CONFLICT' },
  input: z.object({
    id: launchId,
    to: z.enum(LAUNCH_STATUSES),
    expectedRevision: z.number().int().min(0),
    ...approvalFields,
  }),
  output: eventOutput.extend({ confirmOperatorId: z.string() }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC', to: 'draft', expectedRevision: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_EVENTS_LIST = defineProcedure({
  ...base,
  name: 'token.launch.events.list',
  kind: 'query',
  path: 'launch.events.list',
  access: { caller: 'public' },
  refusals: { 'launch.events_list_limit_unset': 'PRECONDITION_FAILED' },
  input: z
    .object({
      type: z.enum(LAUNCH_TYPES).optional(),
      state: z.enum(LAUNCH_STATES).optional(),
      /** Optional here so an omit reaches `launch.events_list_limit_unset`, not a Zod "Required". */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .default({}),
  output: z.array(eventOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_EVENTS_GET = defineProcedure({
  ...base,
  name: 'token.launch.events.get',
  kind: 'query',
  path: 'launch.events.get',
  access: { caller: 'public' },
  refusals: { 'launch.event_not_found': 'NOT_FOUND' },
  input: z.object({ id: launchId }),
  output: eventOutput,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_ELIGIBILITY = defineProcedure({
  ...base,
  name: 'token.launch.eligibility',
  kind: 'query',
  path: 'launch.eligibility',
  access: { caller: 'scope', scope: 'token:read' },
  refusals: {
    'launch.eligibility_unavailable': 'PRECONDITION_FAILED',
    'launch.min_kyc_tier_unset': 'PRECONDITION_FAILED',
    'launch.restricted_regions_unset': 'PRECONDITION_FAILED',
  },
  input: z.object({ id: launchId }),
  output: z.object({
    eventId: z.string(),
    eligible: z.boolean(),
    requirements: z.array(
      z.object({
        id: z.enum(['identity_verification', 'region', 'account_active', 'main_account', 'issuer_onboarded', 'event_open']),
        met: z.boolean(),
        required: z.string(),
        actual: z.string(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const TOKEN_LAUNCH_BASIS = defineProcedure({
  ...base,
  name: 'token.launch.basis',
  kind: 'query',
  path: 'launch.basis',
  access: { caller: 'scope', scope: 'token:read', module: 'token' },
  refusals: {},
  input: z.object({ id: launchId }),
  output: z.object({
    eventId: z.string(),
    method: z.enum(ALLOCATION_METHODS).nullable(),
    perUserCap: amountString.nullable(),
    ticketSize: amountString.nullable(),
    tierWeights: z.array(z.object({ minBasis: amountString, weight: z.number().int() })).nullable(),
    basis: amountString.nullable(),
    reason: z.enum(['snapshot_not_taken', 'no_holdings_at_snapshot']).nullable(),
    takenAt: z.string().nullable(),
    tickets: z.string().nullable(),
    tierWeight: z.number().int().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
