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

export const schema = { strategies, strategyVersions, writeReceipts, backtestRuns };
