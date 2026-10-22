/**
 * SP-order-entry-03: the pair rules read the latest approved row of
 * trade.operator_risk_limits. Real Postgres via TEST_DATABASE_URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { currentRisk } from '../admin/risk.js';
import { fakeMarket } from '../public-rest.js';
import { presentPairRules } from './pair-rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

describe('SP-order-entry-03 pair rules from the operator risk table', () => {
  let db: TestDatabase;
  const marketId = randomUUID();
  const market = fakeMarket({ id: marketId, symbol: 'ETH/USDT', maxQty: parseAmount('40') });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_risk_limits`;
  });

  async function insert(version: number, collar: string | null, throttle: string | null) {
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (${randomUUID()}, ${marketId}, ${version}, ${collar}, NULL, NULL, ${throttle}, NULL, 'op', 'ap', 'test', ${randomUUID()})`;
  }

  it('no approved row: every protection value is "not set" and the version is 0', async () => {
    const rules = presentPairRules(market, await currentRisk(db.sql, marketId));
    expect(rules.protection).toEqual({
      collar: 'not set',
      fatFinger: 'not set',
      slippageCapBps: 'not set',
      openOrdersPerMarket: 'not set',
    });
    expect(rules.riskVersion).toBe('0');
    expect(rules.maxQty).toBe('40');
  });

  it('shows the latest approved version, not an older one', async () => {
    await insert(1, '1000', null);
    await insert(2, '2000', '15');
    const rules = presentPairRules(market, await currentRisk(db.sql, marketId));
    expect(rules.riskVersion).toBe('2');
    expect(rules.protection.collar).toBe('2000');
    expect(rules.protection.openOrdersPerMarket).toBe('15');
    expect(rules.protection.fatFinger).toBe('not set');
  });
});
