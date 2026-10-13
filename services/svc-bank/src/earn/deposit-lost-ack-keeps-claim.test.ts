/**
 * Unit card — a committed earn deposit keeps its claim when the receipt is lost
 *
 * 1. Promise: once the ledger has committed bank.earn.deposited, the position
 *    that owns that stake survives a lost acknowledgement and can be recovered
 *    without the customer retrying.
 * 2. Break: deposit() deletes the pending row on any post error, so the stake
 *    sits in the ledger with no position, resumePending finds nothing, and a
 *    retry with the same positionId and a smaller amount becomes the record.
 * 3. Done bar: after commit-then-throw the row still exists; recovery (or the
 *    same-id retry) ends with principal 1000 matching the single ledger post;
 *    a changed amount under the same positionId never becomes the record.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/earn/earn-service.ts (deposit, resumePending)
 * 6. RED on 11ab823a8: row count 0, resumePending [], principal 500 vs ledger 1000
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount as amt, formatAmount, recipes } from '@intafaced/ledger-client';
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

describe('earn deposit with a lost ledger acknowledgement', () => {
  it('keeps the claim and never lets a changed amount become the record', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
    const earn = new EarnService(sql, ledger);
    const pool = await earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST', aprBps: 100, minDeposit: 0n });
    const positionId = randomUUID();

    const post = ledger.post.bind(ledger);
    let lost = false;
    ledger.post = async (request) => {
      const receipt = await post(request);
      if (!lost && request.reason === 'bank.earn.deposited') {
        lost = true;
        throw new Error('receipt lost after ledger commit');
      }
      return receipt;
    };
    await expect(earn.deposit({ poolId: pool.id, positionId, userId: USER, amount: amt('1000'), now: NOW })).rejects.toThrow();
    ledger.post = post;

    const rows = await sql`SELECT id FROM bank.earn_positions WHERE id = ${positionId}`;
    expect(rows).toHaveLength(1);

    await new EarnService(sql, ledger).resumePending(10);
    try {
      await earn.deposit({ poolId: pool.id, positionId, userId: USER, amount: amt('500'), now: NOW });
    } catch {
      // Refusing the changed amount is acceptable; adopting it is not.
    }

    const posts = ledger.journal().filter((tx) => tx.reason === 'bank.earn.deposited');
    expect(posts).toHaveLength(1);
    const position = await earn.position(positionId);
    expect(formatAmount(position.principal)).toBe('1000');
  });
});
