/**
 * Unit card — a definite ledger refusal during earn recovery is final
 *
 * 1. Promise: a pending earn deposit that the ledger DEFINITELY refuses while
 *    `resumePending` re-drives it is closed, exactly as `deposit()` closes it.
 * 2. Break: `resumePending` kept the refused claim pending, so a deposit the
 *    customer saw fail would book later, when funds arrived, with nobody's
 *    current yes.
 * 3. Done bar: a refused claim is deleted and nothing is staked; an UNKNOWN
 *    failure still keeps the claim pending (the post may have committed).
 * 4. Class M
 * 5. Paths: services/svc-bank/src/earn/earn-service.ts (resumePending)
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { EarnService } from './earn-service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-01T12:00:00.000Z');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

async function pendingClaim(ledger: MemoryLedger, funded: string, claimed: string) {
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt(funded), rail: 'test', railRef: randomUUID() }));
  const earn = new EarnService(sql, ledger);
  const pool = await earn.createPool({ assetId: 'USDT', kind: 'flexible', name: `TEST-${randomUUID()}`, aprBps: 100, minDeposit: 0n });
  const positionId = randomUUID();
  // The claim as `deposit()` leaves it when its reply was lost: pending, nothing posted here.
  await sql`
    INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status)
    VALUES (${positionId}, ${pool.id}, ${USER}, 'USDT', ${claimed}::numeric, ${NOW}, ${null}, 'pending')
  `;
  return { earn, positionId };
}

describe('earn resumePending and a refused deposit', () => {
  it('closes the claim when the ledger definitely refuses, and never books it later', async () => {
    const ledger = new MemoryLedger();
    // Only 100 available: the 1000 deposit is a definite insufficient-funds refusal.
    const { earn, positionId } = await pendingClaim(ledger, '100', '1000');

    const first = await earn.resumePending(10);
    expect(first).toEqual([expect.objectContaining({ positionId, outcome: 'failed' })]);
    expect(await sql`SELECT id FROM bank.earn_positions WHERE id = ${positionId}`).toHaveLength(0);

    // Funds arrive later. A pass finds nothing: the refused deposit does not book.
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('5000'), rail: 'test', railRef: randomUUID() }));
    expect(await earn.resumePending(10)).toHaveLength(0);
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.earn.deposited')).toHaveLength(0);
  });

  it('keeps the claim pending on an UNKNOWN failure, which may have committed', async () => {
    const ledger = new MemoryLedger();
    const { earn, positionId } = await pendingClaim(ledger, '1000', '1000');
    const post = ledger.post.bind(ledger);
    ledger.post = async () => {
      throw new Error('svc-ledger unreachable');
    };

    const out = await earn.resumePending(10);
    expect(out).toEqual([expect.objectContaining({ positionId, outcome: 'failed' })]);
    const rows = await sql<Array<{ status: string }>>`SELECT status FROM bank.earn_positions WHERE id = ${positionId}`;
    expect(rows).toEqual([{ status: 'pending' }]);

    ledger.post = post;
    expect(await earn.resumePending(10)).toEqual([expect.objectContaining({ positionId, outcome: 'completed' })]);
  });
});
