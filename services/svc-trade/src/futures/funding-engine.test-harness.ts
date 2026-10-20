/**
 * Test-only helpers for the funding rate engine suites: a real-Postgres database with every svc-trade migration,
 * parameter seeding, and sample seeding. All figures passed in by tests are TEST fixtures, not owner numbers.
 * Not imported by production modules.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { BLANK_FUNDING_PARAMS, type FundingParams } from './funding-params.js';
import { sqlFundingSampleStore } from './funding-rate-computer.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');

export async function openFundingTestDb(): Promise<TestDatabase> {
  const migrations = readdirSync(drizzle)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort()
    .map((file) => readFileSync(join(drizzle, file), 'utf8'));
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return createTestDatabase({ service: 'trade', url: parsed.toString(), migrations });
}

export async function truncateFundingTables(db: TestDatabase): Promise<void> {
  await db.sql`TRUNCATE trade.funding_rate_samples, trade.funding_index_sources, trade.funding_params,
    trade.operator_audit, trade.operator_requests`;
  // Published periods are immutable by trigger; a test reset drops the triggers' protection with TRUNCATE, which
  // row-level triggers do not intercept.
  await db.sql`TRUNCATE trade.funding_rate_periods`;
}

/** Append the next params version for a market. */
export async function seedFundingParams(db: TestDatabase, marketId: string, params: Partial<FundingParams>): Promise<string> {
  const merged = { ...BLANK_FUNDING_PARAMS, ...params };
  const [row] = await db.sql<Array<{ v: string }>>`
    SELECT (COALESCE(MAX(version), 0) + 1)::text AS v FROM trade.funding_params WHERE market_id = ${marketId}`;
  const version = row!.v;
  await db.sql`INSERT INTO trade.funding_params (
      id, market_id, version, base_component, cap, cadence_seconds, trim_ratio_bps, min_samples, period_seconds,
      period_anchor, operator_id, approver_id, reason, approval_id
    ) VALUES (
      ${randomUUID()}, ${marketId}, ${version}::bigint, ${merged.baseComponent}, ${merged.cap}, ${merged.cadenceSeconds},
      ${merged.trimRatioBps}, ${merged.minSamples}, ${merged.periodSeconds}, ${merged.periodAnchor},
      'op-test', 'approver-test', 'test fixture', ${`seed-${version}`}
    )`;
  return version;
}

/** Record `count` samples one cadence apart from `start`, each at the given TEST mark and index. */
export async function seedSamples(
  db: TestDatabase,
  marketId: string,
  start: Date,
  count: number,
  cadenceSeconds: number,
  each: (i: number) => { mark: string | null; index: string | null } = () => ({ mark: '101', index: '100' }),
): Promise<void> {
  const store = sqlFundingSampleStore(db.sql);
  for (let i = 0; i < count; i += 1) {
    const { mark, index } = each(i);
    await store.record(marketId, {
      sampledAt: new Date(start.getTime() + i * cadenceSeconds * 1000),
      mark: mark == null ? null : amt(mark),
      index: index == null ? null : amt(index),
      gapReason: mark == null || index == null ? 'test_gap' : null,
    });
  }
}
