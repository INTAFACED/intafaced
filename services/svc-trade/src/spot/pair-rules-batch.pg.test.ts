/**
 * SP-order-entry-03 fix round: one batched DISTINCT ON read returns each
 * market's own latest approved row of trade.operator_risk_limits. Real Postgres via TEST_DATABASE_URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { currentRiskForMarkets } from '../admin/risk.js';
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

describe('SP-order-entry-03 batched pair-rules read', () => {
  let db: TestDatabase;
  const aId = randomUUID();
  const bId = randomUUID();
  const cId = randomUUID();
  const a = fakeMarket({ id: aId, symbol: 'BTC/USDT', maxQty: parseAmount('40') });
  const b = fakeMarket({ id: bId, symbol: 'ETH/USDT' });

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_risk_limits`;
  });

  async function insert(marketId: string, version: number, collar: string, slip: string | null) {
    await db.sql`
      INSERT INTO trade.operator_risk_limits
        (id, market_id, version, collar, fat_finger, slippage_cap, throttle, circuit_breaker, operator_id, approver_id, reason, approval_id)
      VALUES (${randomUUID()}, ${marketId}, ${version}, ${collar}, NULL, ${slip}, NULL, NULL, 'op', 'ap', 'test', ${randomUUID()})`;
  }

  it('two markets: B has a newer version, A still shows its own latest', async () => {
    await insert(aId, 1, '100', null);
    await insert(aId, 2, '200', '30');
    await insert(bId, 1, '900', null);
    await insert(bId, 2, '950', null);
    await insert(bId, 5, '999', null);
    const risks = await currentRiskForMarkets(db.sql, [aId, bId, cId]);
    expect(risks.get(aId)?.version).toBe('2');
    expect(risks.get(aId)?.collar).toBe('200');
    expect(risks.get(bId)?.version).toBe('5');
    expect(risks.get(bId)?.collar).toBe('999');
    expect(risks.has(cId)).toBe(false);
    const ruleA = presentPairRules(a, risks.get(aId) ?? null, 150);
    const ruleB = presentPairRules(b, risks.get(bId) ?? null, 150);
    expect(ruleA.protection.slippageCapBps).toBe('30');
    expect(ruleB.protection.slippageCapBps).toBe('150');
    expect(ruleA.riskVersion).toBe('2');
  });

  it('an empty id list makes no query and returns an empty map', async () => {
    expect((await currentRiskForMarkets(db.sql, [])).size).toBe(0);
  });
});
