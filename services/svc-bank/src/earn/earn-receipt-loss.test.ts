/**
 * Unit card: earn receipt loss keeps the owner's claim (CS-023, earn side)
 *
 * 1. Promise: when the ledger commits an earn deposit or withdraw and the reply
 *    is lost (an untyped error, or a typed transport error that is not a
 *    definite refusal), the customer's position is not deleted and not closed
 *    early. Recovery finishes it with exactly one ledger post.
 * 2. Break: the claim row is deleted on any post error, so the stake sits in the
 *    ledger with no owner row.
 * 3. Done bar: one deposit post, one withdraw post, position active then closed,
 *    balance back in available.
 * 4. Class M
 * 5. Paths: services/svc-bank/src/earn/earn-service.ts (deposit, resumePending, withdraw)
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerError, MemoryLedger, parseAmount as amt, formatAmount, recipes, userAvailable } from '@intafaced/ledger-client';
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

async function setup() {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: randomUUID() }));
  const earn = new EarnService(sql, ledger);
  const pool = await earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST', aprBps: 100, minDeposit: 0n });
  return { ledger, earn, pool };
}

function loseReplyOnce(ledger: MemoryLedger, reason: string, makeError: () => Error) {
  const post = ledger.post.bind(ledger);
  let lost = false;
  ledger.post = async (request) => {
    const receipt = await post(request);
    if (!lost && request.reason === reason) {
      lost = true;
      throw makeError();
    }
    return receipt;
  };
  return () => {
    ledger.post = post;
  };
}

describe('earn receipt loss keeps ownership', () => {
  it('a typed transport error after the deposit committed keeps the claim; recovery activates it once', async () => {
    const { ledger, earn, pool } = await setup();
    const positionId = randomUUID();
    const restore = loseReplyOnce(ledger, 'bank.earn.deposited', () => new LedgerError('ledger unavailable', 'ledger.unavailable'));

    await expect(earn.deposit({ poolId: pool.id, positionId, userId: USER, amount: amt('1000'), now: NOW })).rejects.toThrow();
    restore();
    expect(await sql`SELECT id FROM bank.earn_positions WHERE id = ${positionId}`).toHaveLength(1);

    const resumed = await earn.resumePending(10);
    expect(resumed.find((r) => r.positionId === positionId)?.outcome).toBe('completed');
    const position = await earn.position(positionId);
    expect(position.status).toBe('active');
    expect(formatAmount(position.principal)).toBe('1000');
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.earn.deposited')).toHaveLength(1);
  });

  it('a lost reply on withdraw leaves the position open; the retry closes it with one post', async () => {
    const { ledger, earn, pool } = await setup();
    const positionId = randomUUID();
    await earn.deposit({ poolId: pool.id, positionId, userId: USER, amount: amt('1000'), now: NOW });
    const restore = loseReplyOnce(ledger, 'bank.earn.withdrawn', () => new Error('receipt lost after ledger commit'));

    await expect(earn.withdraw(positionId, NOW)).rejects.toThrow();
    restore();
    expect((await earn.position(positionId)).status).toBe('active');

    const closed = await earn.withdraw(positionId, NOW);
    expect(closed.status).toBe('closed');
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.earn.withdrawn')).toHaveLength(1);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('1000');
  });
});
