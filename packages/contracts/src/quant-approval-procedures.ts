import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { quantApprovalPolicySchema, quantApprovalStateSchema } from './quant-research.js';

/**
 * svc-quant's live approval (RC-algo-dev-01; J-algo-dev-16 #4), one record per call the app makes: a strategy's approval
 * state (`approval.get`), the account's policy (`approval.policy.set`), the owner's ask for a review (`approval.request`)
 * and a teammate's decision (`approval.decide`). Each is a setting of a simulated strategy's go-live gate: none moves
 * value. svc-quant mounts each from here (`routes/approval.ts`) and the customer app calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.approval_policy_unset': 'PRECONDITION_FAILED',
  'quant.approval_self_review': 'FORBIDDEN',
  'quant.approval_not_reviewer': 'FORBIDDEN',
  'quant.approval_decided': 'CONFLICT',
  'quant.approval_hash_stale': 'CONFLICT',
  // `toTrpc` names no status for it, so it leaves as its fallback, BAD_REQUEST.
  'quant.approval_not_found': 'BAD_REQUEST',
  // A teammate row whose stored timestamp cannot be read (svc-quant's team store on Postgres).
  'quant.params_invalid': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
/** Every call reads the account's stores: no database wired refuses by name. */
const refuse = (...more: QuantRefusalCode[]): Refusals =>
  Object.freeze(
    Object.fromEntries(
      (['quant.database_url_unset', 'quant.database_pool_max_unset', ...more] as const).map((code): [string, RefusalStatus] => [
        code,
        STATUS[code],
      ]),
    ),
  );

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

const strategyId = z.string().min(1).max(128);
/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

/** One strategy's approvals and whether its newest version may go live now. The owner or a teammate reads it. */
export const QUANT_APPROVAL_GET = defineProcedure({
  ...base,
  name: 'quant.approval.get',
  kind: 'query',
  path: 'approval.get',
  refusals: refuse('quant.studio_not_found', 'quant.params_invalid'),
  input: z.object({ strategyId, ...accountField }),
  output: quantApprovalStateSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'accept', input: { strategyId: 's-1', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { strategyId: '' } },
    { verdict: 'refuse', input: { strategyId: 's-1', accountId: 'not-a-uuid' } },
  ],
});

/** Whether the account's live use needs an independent review; the business key makes a second press one row. */
export const QUANT_APPROVAL_POLICY_SET = defineProcedure({
  ...base,
  name: 'quant.approval.policy.set',
  kind: 'mutation',
  path: 'approval.policy.set',
  refusals: refuse(),
  input: z.object({ required: z.boolean(), idempotencyKey: z.string().min(1).max(200), ...accountField }),
  output: quantApprovalPolicySchema,
  samples: [
    { verdict: 'accept', input: { required: true, idempotencyKey: 'from:unset:to:true' } },
    { verdict: 'accept', input: { required: false, idempotencyKey: 'from:x:to:false', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { required: 'yes', idempotencyKey: 'k' } },
    { verdict: 'refuse', input: { required: true, idempotencyKey: '' } },
  ],
});

/** The owner asks for a review of one version, bound to its hash now; with no policy set it refuses by name. */
export const QUANT_APPROVAL_REQUEST = defineProcedure({
  ...base,
  name: 'quant.approval.request',
  kind: 'mutation',
  path: 'approval.request',
  refusals: refuse('quant.studio_not_found', 'quant.approval_policy_unset'),
  input: z.object({ strategyId, strategyVersion: z.number().int().positive(), ...accountField }),
  output: quantApprovalStateSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 1 } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 0 } },
    { verdict: 'refuse', input: { strategyId: 's-1' } },
  ],
});

/**
 * A teammate decides one request, once: the requester or the owner refuses self-review, a non-teammate is no reviewer,
 * a changed version refuses stale, and a decided request answers again only the same reviewer's same decision.
 */
export const QUANT_APPROVAL_DECIDE = defineProcedure({
  ...base,
  name: 'quant.approval.decide',
  kind: 'mutation',
  path: 'approval.decide',
  refusals: refuse(
    'quant.studio_not_found',
    'quant.params_invalid',
    'quant.approval_not_found',
    'quant.approval_self_review',
    'quant.approval_not_reviewer',
    'quant.approval_decided',
    'quant.approval_hash_stale',
  ),
  input: z.object({
    strategyId,
    approvalId: z.string().min(1).max(64),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().max(500),
    ...accountField,
  }),
  output: quantApprovalStateSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', approvalId: 'a-1', decision: 'approved', reason: '' } },
    { verdict: 'accept', input: { strategyId: 's-1', approvalId: 'a-1', decision: 'rejected', reason: 'TEST too risky' } },
    { verdict: 'refuse', input: { strategyId: 's-1', approvalId: 'a-1', decision: 'pending', reason: '' } },
    { verdict: 'refuse', input: { strategyId: 's-1', approvalId: 'a-1', decision: 'approved' } },
  ],
});

export const QUANT_APPROVAL_PROCEDURES = [
  QUANT_APPROVAL_GET,
  QUANT_APPROVAL_POLICY_SET,
  QUANT_APPROVAL_REQUEST,
  QUANT_APPROVAL_DECIDE,
] as const;
