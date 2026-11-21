import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { quantPaperListSchema, quantPaperRunSchema } from './quant-algo.js';
import { QUANT_TEAM_ROLES, quantEditLockSchema, quantSharedListSchema, quantSharedOpenSchema, quantTeamSchema } from './quant-team.js';

/**
 * svc-quant's strategy teams (J-algo-dev-08, AL-team-01), one record per call: the owner's side (`team.get`, `team.set`,
 * `team.remove`, `team.grant`), the edit lock (`team.lock`, `team.unlock`) and the teammate's side (`team.shared`,
 * `team.open`, `team.save`, `team.paperRuns`, `team.stop`, `team.order`). Every strategy and run stays simulated: none
 * moves value. svc-quant mounts each from here (`routes/team.ts`) and the customer app calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.version_not_found': 'NOT_FOUND',
  'quant.run_not_found': 'NOT_FOUND',
  'quant.permission_denied': 'FORBIDDEN',
  'quant.edit_locked': 'CONFLICT',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.quota_profile_unset': 'PRECONDITION_FAILED',
  'quant.quota_unset': 'PRECONDITION_FAILED',
  'quant.quota_exceeded': 'PRECONDITION_FAILED',
  'quant.edit_lock_unset': 'PRECONDITION_FAILED',
  'quant.release_note_limit_unset': 'PRECONDITION_FAILED',
  'quant.paper_manual_order_unsupported': 'PRECONDITION_FAILED',
  'quant.backtest_lake_missing': 'PRECONDITION_FAILED',
  'quant.team_member_invalid': 'BAD_REQUEST',
  'quant.grant_invalid': 'BAD_REQUEST',
  'quant.idempotency_conflict': 'BAD_REQUEST',
  'quant.params_invalid': 'BAD_REQUEST',
  'quant.backtest_history_range': 'BAD_REQUEST',
  'quant.cost_unset': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
const listed = (codes: readonly QuantRefusalCode[]): Refusals =>
  Object.freeze(Object.fromEntries(codes.map((code): [string, RefusalStatus] => [code, STATUS[code]])));
/** Every store read refuses by name when no database is wired. */
const NO_DATABASE = ['quant.database_url_unset', 'quant.database_pool_max_unset'] as const;
/** Every call but `team.shared` reads one strategy first: the caller's own, or one shared with them; else not found. */
const refuse = (...more: QuantRefusalCode[]): Refusals => listed(['quant.studio_not_found', ...NO_DATABASE, ...more]);

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

const strategyId = z.string().min(1).max(128);
/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const MEMBER = '22222222-2222-4222-8222-222222222222';

export const QUANT_TEAM_GET = defineProcedure({
  ...base,
  name: 'quant.team.get',
  kind: 'query',
  path: 'team.get',
  refusals: refuse(),
  input: z.object({ strategyId, ...accountField }),
  output: quantTeamSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: { strategyId: '' } },
    { verdict: 'refuse', input: { strategyId: 's-1', accountId: 'not-a-uuid' } },
  ],
});

export const QUANT_TEAM_SET = defineProcedure({
  ...base,
  name: 'quant.team.set',
  kind: 'mutation',
  path: 'team.set',
  // A new teammate counts against the plan's collaborators per strategy (the quota gate), each limit the owner's.
  refusals: refuse('quant.team_member_invalid', 'quant.quota_profile_unset', 'quant.quota_unset', 'quant.quota_exceeded'),
  input: z.object({
    strategyId,
    memberId: z.string().trim().min(1).max(64),
    role: z.enum(QUANT_TEAM_ROLES),
    liveControl: z.boolean(),
    ...accountField,
  }),
  output: quantTeamSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', memberId: MEMBER, role: 'view', liveControl: false } },
    { verdict: 'accept', input: { strategyId: 's-1', memberId: MEMBER, role: 'edit', liveControl: true } },
    { verdict: 'refuse', input: { strategyId: 's-1', memberId: MEMBER, role: 'admin', liveControl: false } },
    { verdict: 'refuse', input: { strategyId: 's-1', memberId: '', role: 'view', liveControl: false } },
  ],
});

export const QUANT_TEAM_REMOVE = defineProcedure({
  ...base,
  name: 'quant.team.remove',
  kind: 'mutation',
  path: 'team.remove',
  refusals: refuse(),
  input: z.object({ strategyId, memberId: z.string().guid(), ...accountField }),
  output: quantTeamSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', memberId: MEMBER } },
    { verdict: 'refuse', input: { strategyId: 's-1', memberId: 'not-a-uuid' } },
    { verdict: 'refuse', input: { strategyId: 's-1' } },
  ],
});

export const QUANT_TEAM_GRANT = defineProcedure({
  ...base,
  name: 'quant.team.grant',
  kind: 'mutation',
  path: 'team.grant',
  // A grant shorter or longer than the screen's bounds refuses as invalid; nothing is granted.
  refusals: refuse('quant.grant_invalid'),
  input: z.object({
    strategyId,
    seconds: z.number().int(),
    /** The grants the screen read: the key of this grant is `quant.grant:<strategy>:<seq>`, so a retry is the same grant. */
    seq: z.number().int().min(0),
    ...accountField,
  }),
  output: quantTeamSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', seconds: 3600, seq: 0 } },
    { verdict: 'refuse', input: { strategyId: 's-1', seconds: 60.5, seq: 0 } },
    { verdict: 'refuse', input: { strategyId: 's-1', seconds: 3600, seq: -1 } },
  ],
});

export const QUANT_TEAM_SHARED = defineProcedure({
  ...base,
  name: 'quant.team.shared',
  kind: 'query',
  path: 'team.shared',
  refusals: listed(NO_DATABASE),
  input: z.object({ ...accountField }).optional(),
  output: quantSharedListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: { accountId: 'not-a-uuid' } },
  ],
});

export const QUANT_TEAM_OPEN = defineProcedure({
  ...base,
  name: 'quant.team.open',
  kind: 'query',
  path: 'team.open',
  refusals: refuse(),
  input: z.object({ strategyId, ...accountField }),
  output: quantSharedOpenSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { strategyId: 'x'.repeat(129) } },
  ],
});

export const QUANT_TEAM_SAVE = defineProcedure({
  ...base,
  name: 'quant.team.save',
  kind: 'mutation',
  path: 'team.save',
  // View only is forbidden; another person's live lock is a conflict; a note needs the owner's cap, and stays under it.
  refusals: refuse(
    'quant.permission_denied',
    'quant.idempotency_conflict',
    'quant.edit_lock_unset',
    'quant.edit_locked',
    'quant.version_not_found',
    'quant.release_note_limit_unset',
    'quant.params_invalid',
  ),
  input: z.object({
    strategyId,
    /** The version the screen read: the save's key is `quant.team.save:<strategy>:<member>:v<n>`. */
    baseVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(128),
    releaseNote: z.string().max(2000).optional(),
    ...accountField,
  }),
  output: quantSharedOpenSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', baseVersion: 1, name: 'TEST strategy' } },
    { verdict: 'accept', input: { strategyId: 's-1', baseVersion: 2, name: 'TEST strategy', releaseNote: 'TEST note' } },
    { verdict: 'refuse', input: { strategyId: 's-1', baseVersion: 0, name: 'TEST strategy' } },
    { verdict: 'refuse', input: { strategyId: 's-1', baseVersion: 1, name: '' } },
  ],
});

export const QUANT_TEAM_LOCK = defineProcedure({
  ...base,
  name: 'quant.team.lock',
  kind: 'mutation',
  path: 'team.lock',
  // The owner or an edit teammate takes it; view only is forbidden, another person's live lock is a conflict.
  refusals: refuse('quant.permission_denied', 'quant.edit_lock_unset', 'quant.edit_locked'),
  input: z.object({ strategyId, ...accountField }),
  output: quantEditLockSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: { strategyId: '' } },
    { verdict: 'refuse', input: { strategyId: 1 } },
  ],
});

export const QUANT_TEAM_UNLOCK = defineProcedure({
  ...base,
  name: 'quant.team.unlock',
  kind: 'mutation',
  path: 'team.unlock',
  refusals: refuse('quant.permission_denied'),
  input: z.object({ strategyId, ...accountField }),
  output: quantEditLockSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { strategyId: 's-1', accountId: 'not-a-uuid' } },
  ],
});

export const QUANT_TEAM_PAPER_RUNS = defineProcedure({
  ...base,
  name: 'quant.team.paperRuns',
  kind: 'query',
  path: 'team.paperRuns',
  refusals: refuse(),
  input: z.object({ strategyId, ...accountField }),
  output: quantPaperListSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: { strategyId: '' } },
  ],
});

const runId = z.string().min(1).max(128);

export const QUANT_TEAM_ORDER = defineProcedure({
  ...base,
  name: 'quant.team.order',
  kind: 'mutation',
  path: 'team.order',
  // Never places an order: no live control is forbidden, and with it a paper run takes no manual order.
  refusals: refuse('quant.permission_denied', 'quant.run_not_found', 'quant.paper_manual_order_unsupported'),
  input: z.object({
    strategyId,
    runId,
    side: z.enum(['buy', 'sell']),
    size: z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/, 'size — a decimal string'),
    ...accountField,
  }),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', runId: 'r-1', side: 'buy', size: '0.5' } },
    { verdict: 'refuse', input: { strategyId: 's-1', runId: 'r-1', side: 'hold', size: '0.5' } },
    { verdict: 'refuse', input: { strategyId: 's-1', runId: 'r-1', side: 'sell', size: '-1' } },
    { verdict: 'refuse', input: { strategyId: 's-1', runId: 'r-1', side: 'sell', size: 1 } },
  ],
});

export const QUANT_TEAM_STOP = defineProcedure({
  ...base,
  name: 'quant.team.stop',
  kind: 'mutation',
  path: 'team.stop',
  // No live control is forbidden. The stopped run is then read as the owner's paper screen reads it: from the
  // exchange's closed candles and its published fees, each refusing by name when not wired or not answering.
  refusals: refuse(
    'quant.permission_denied',
    'quant.run_not_found',
    'quant.backtest_lake_missing',
    'quant.backtest_history_range',
    'quant.cost_unset',
  ),
  input: z.object({ strategyId, runId, ...accountField }),
  output: quantPaperRunSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', runId: 'r-1' } },
    { verdict: 'refuse', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: { strategyId: 's-1', runId: '' } },
  ],
});

export const QUANT_TEAM_PROCEDURES = [
  QUANT_TEAM_GET,
  QUANT_TEAM_SET,
  QUANT_TEAM_REMOVE,
  QUANT_TEAM_GRANT,
  QUANT_TEAM_SHARED,
  QUANT_TEAM_OPEN,
  QUANT_TEAM_SAVE,
  QUANT_TEAM_LOCK,
  QUANT_TEAM_UNLOCK,
  QUANT_TEAM_PAPER_RUNS,
  QUANT_TEAM_ORDER,
  QUANT_TEAM_STOP,
] as const;
