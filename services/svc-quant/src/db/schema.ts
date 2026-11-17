import { boolean, integer, jsonb, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tstz } from '@intafaced/db/columns';

/**
 * Paper strategy library. Not a money book: no balance column, no ledger id.
 * Cash and risk stay text (decimal strings). Each save is a new version row.
 */
export const quant = pgSchema('quant');

export const strategies = quant.table(
  'strategies',
  {
    id: text('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    clientStrategyId: text('client_strategy_id').notNull(),
    deletedAt: tstz('deleted_at'),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [uniqueIndex('strategies_account_client_idx').on(t.accountId, t.clientStrategyId)],
);

export const strategyVersions = quant.table(
  'strategy_versions',
  {
    strategyId: text('strategy_id')
      .notNull()
      .references(() => strategies.id),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull(),
    source: text('source').notNull(),
    cash: text('cash').notNull(),
    blocks: jsonb('blocks').notNull(),
    risk: jsonb('risk').notNull(),
    environment: text('environment').notNull(),
    kind: text('kind').notNull(),
    claimLabel: text('claim_label').notNull(),
    live: boolean('live').notNull(),
    simulated: boolean('simulated').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.strategyId, t.version] })],
);

export const writeReceipts = quant.table(
  'write_receipts',
  {
    accountId: uuid('account_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    operation: text('operation').notNull(),
    response: jsonb('response').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.idempotencyKey] })],
);

export const backtestRuns = quant.table(
  'backtest_runs',
  {
    accountId: uuid('account_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: integer('strategy_version').notNull(),
    symbol: text('symbol').notNull(),
    result: jsonb('result').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.idempotencyKey] })],
);

export const runs = quant.table(
  'runs',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id'),
    scopeKey: text('scope_key').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    strategyId: text('strategy_id'),
    strategyVersion: integer('strategy_version'),
    startedAt: tstz('started_at').notNull(),
    finishedAt: tstz('finished_at'),
    outcomeCode: text('outcome_code'),
    result: jsonb('result'),
  },
  (t) => [uniqueIndex('runs_scope_key_idx').on(t.scopeKey, t.idempotencyKey)],
);

export const claims = quant.table(
  'claims',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .unique()
      .references(() => runs.id),
    userId: uuid('user_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    pnl: text('pnl').notNull(),
    environment: text('environment').notNull(),
    kind: text('kind').notNull(),
    claimLabel: text('claim_label').notNull(),
    live: boolean('live').notNull(),
    simulated: boolean('simulated').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [uniqueIndex('claims_user_key_idx').on(t.userId, t.idempotencyKey)],
);

export const schema = { strategies, strategyVersions, writeReceipts, backtestRuns, runs, claims };

/** The strategy API's Idempotency-Key (J-algo-dev-14 #4): what one key's backtest start asked for, by its hash. */
export const apiIdempotency = quant.table(
  'api_idempotency',
  {
    accountId: uuid('account_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.idempotencyKey] })],
);

/** The account owner's live approval policy (J-algo-dev-16 #4): no row is "not set". */
export const approvalPolicies = quant.table('approval_policies', {
  accountId: uuid('account_id').primaryKey(),
  required: boolean('required').notNull(),
  writeKey: text('write_key').notNull(),
  actor: uuid('actor').notNull(),
  setAt: tstz('set_at').notNull(),
});

/** One approval request of one strategy version, bound to its content hash; decided once by another member. */
export const strategyApprovals = quant.table('strategy_approvals', {
  id: uuid('id').primaryKey(),
  requestKey: text('request_key').notNull().unique(),
  accountId: uuid('account_id').notNull(),
  strategyId: text('strategy_id').notNull(),
  strategyVersion: integer('strategy_version').notNull(),
  contentHash: text('content_hash').notNull(),
  requester: uuid('requester').notNull(),
  reviewer: uuid('reviewer'),
  decision: text('decision').notNull(),
  reason: text('reason').notNull(),
  requestedAt: tstz('requested_at').notNull(),
  decidedAt: tstz('decided_at'),
});

/** The market data lake (J-algo-dev-16 #2): the exchange's own public ticks, book snapshots and taker fills. */
export const lakeRows = quant.table('lake_rows', {
  sourceKey: text('source_key').primaryKey(),
  kind: text('kind').notNull(),
  symbol: text('symbol').notNull(),
  observedAt: tstz('observed_at').notNull(),
  payload: jsonb('payload').notNull(),
});

/** One capture pass of one symbol and kind: ok, or a hole with its reason. */
export const lakePasses = quant.table(
  'lake_passes',
  {
    symbol: text('symbol').notNull(),
    kind: text('kind').notNull(),
    at: tstz('at').notNull(),
    ok: boolean('ok').notNull(),
    reason: text('reason'),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.kind, t.at] })],
);

/** Insert-only: an operator paused or resumed capture of one symbol, with a reason. */
export const lakeCaptureChanges = quant.table('lake_capture_changes', {
  id: uuid('id').primaryKey(),
  symbol: text('symbol').notNull(),
  capturing: boolean('capturing').notNull(),
  reason: text('reason').notNull(),
  actor: text('actor').notNull(),
  writeKey: text('write_key').notNull().unique(),
  at: tstz('at').notNull(),
});
