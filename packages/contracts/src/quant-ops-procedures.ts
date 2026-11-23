import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  quantDisputeOpenInputSchema,
  quantDisputeResolveInputSchema,
  quantModerationEntrySchema,
  quantModerationInputSchema,
  quantModerationQueueInputSchema,
  quantModerationQueueSchema,
} from './quant-library.js';
import {
  quantEscapeCorpusInputSchema,
  quantEscapeCorpusSchema,
  quantPromotionAuditSchema,
  quantQuotaAssignInputSchema,
  quantQuotaAssignOutputSchema,
  quantQuotaProfileSchema,
  quantQuotaSetInputSchema,
  quantQuotaSetOutputSchema,
  quantSandboxLimitSetInputSchema,
  quantSandboxLimitSetOutputSchema,
} from './quant-algo.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `ops.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

export const QUANT_OPS_LIBRARY_QUEUE = defineProcedure({
  ...base,
  name: 'quant.ops.library.queue',
  kind: 'query',
  path: 'ops.library.queue',
  access: { caller: 'scope', scope: 'admin:read', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantModerationQueueInputSchema,
  output: quantModerationQueueSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const QUANT_OPS_LIBRARY_HIDE = defineProcedure({
  ...base,
  name: 'quant.ops.library.hide',
  kind: 'mutation',
  path: 'ops.library.hide',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantModerationInputSchema,
  output: quantModerationEntrySchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'USDC', reason: 'USDC', seq: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const QUANT_OPS_LIBRARY_UNHIDE = defineProcedure({
  ...base,
  name: 'quant.ops.library.unhide',
  kind: 'mutation',
  path: 'ops.library.unhide',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantModerationInputSchema,
  output: quantModerationEntrySchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'USDC', reason: 'USDC', seq: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const QUANT_OPS_LIBRARY_REMOVE = defineProcedure({
  ...base,
  name: 'quant.ops.library.remove',
  kind: 'mutation',
  path: 'ops.library.remove',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantModerationInputSchema,
  output: quantModerationEntrySchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'USDC', reason: 'USDC', seq: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const QUANT_OPS_LIBRARY_DISPUTE_OPEN = defineProcedure({
  ...base,
  name: 'quant.ops.library.dispute.open',
  kind: 'mutation',
  path: 'ops.library.dispute.open',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantDisputeOpenInputSchema,
  output: quantModerationEntrySchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'USDC', reason: 'USDC', ticketRef: 'USDC', seq: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const QUANT_OPS_LIBRARY_DISPUTE_RESOLVE = defineProcedure({
  ...base,
  name: 'quant.ops.library.dispute.resolve',
  kind: 'mutation',
  path: 'ops.library.dispute.resolve',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantDisputeResolveInputSchema,
  output: quantModerationEntrySchema,
  samples: [
    { verdict: 'accept', input: { disputeId: 'USDC', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One profile's limits and sandbox limits as stored. */
export const QUANT_OPS_QUOTA_PROFILE = defineProcedure({
  ...base,
  name: 'quant.ops.quota.profile',
  kind: 'query',
  path: 'ops.quota.profile',
  access: { caller: 'scope', scope: 'admin:read', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z.object({ profile: z.string().trim().min(1).max(80) }),
  output: quantQuotaProfileSchema,
  samples: [
    { verdict: 'accept', input: { profile: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Sets one limit of one profile; blank is "not set". A reason is required and kept with the actor. */
export const QUANT_OPS_QUOTA_SET = defineProcedure({
  ...base,
  name: 'quant.ops.quota.set',
  kind: 'mutation',
  path: 'ops.quota.set',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantQuotaSetInputSchema,
  output: quantQuotaSetOutputSchema,
  samples: [
    { verdict: 'accept', input: { profile: 'USDC', resource: 'strategies', limit: 'USDC', reason: 'USDC', idempotencyKey: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Sets one sandbox limit of one profile (J-algo-dev-12); blank is "not set". A reason is required and kept with the actor. */
export const QUANT_OPS_QUOTA_SANDBOX = defineProcedure({
  ...base,
  name: 'quant.ops.quota.sandbox',
  kind: 'mutation',
  path: 'ops.quota.sandbox',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantSandboxLimitSetInputSchema,
  output: quantSandboxLimitSetOutputSchema,
  samples: [
    { verdict: 'accept', input: { profile: 'USDC', limit: 'wall_clock_ms', value: 'USDC', reason: 'USDC', idempotencyKey: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Attaches an account to a profile. A reason is required and kept with the actor. */
export const QUANT_OPS_QUOTA_ASSIGN = defineProcedure({
  ...base,
  name: 'quant.ops.quota.assign',
  kind: 'mutation',
  path: 'ops.quota.assign',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantQuotaAssignInputSchema,
  output: quantQuotaAssignOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { accountId: '11111111-1111-4111-8111-111111111111', profile: 'USDC', reason: 'USDC', idempotencyKey: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Runs the escape corpus against the sandbox under one profile's limits (J-algo-dev-12 #5, ENGINE T-14). Each case
 * goes through the same door as a developer's run; each must end in a typed refusal, and the control run after
 * them must still run. Nothing is stored and no order reaches anything: the paper book of each case is its own.
 */
export const QUANT_OPS_SANDBOX_CORPUS = defineProcedure({
  ...base,
  name: 'quant.ops.sandbox.corpus',
  kind: 'mutation',
  path: 'ops.sandbox.corpus',
  access: { caller: 'scope', scope: 'admin:write', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantEscapeCorpusInputSchema,
  output: quantEscapeCorpusSchema,
  samples: [
    { verdict: 'accept', input: { profile: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The promotion audit (AL-lifecycle-01, J-algo-dev-13 #3): every stored gate decision across accounts, newest
 * first, with the one stage row an approval wrote, who pressed and the criteria the gate judged by.
 */
export const QUANT_OPS_LIFECYCLE_AUDIT = defineProcedure({
  ...base,
  name: 'quant.ops.lifecycle.audit',
  kind: 'query',
  path: 'ops.lifecycle.audit',
  access: { caller: 'scope', scope: 'admin:read', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: quantPromotionAuditSchema,
  samples: [{ verdict: 'accept' }],
});
