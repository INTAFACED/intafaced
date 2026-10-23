import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { operatorOwnerBalances, recordOperatorAccess } from './operator-owner-balances.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** TEST amounts only. */
async function memoryReader(record: (e: unknown) => Promise<void>) {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('3.5'), rail: 'test', railRef: 'owner-bal-1' }));
  return { recordOperatorAccess: record, balances: ledger.balances.bind(ledger) };
}

describe('operatorOwnerBalances', () => {
  it('records the access first, then answers decimal-string balances', async () => {
    const order: string[] = [];
    const reader = await memoryReader(async (e) => {
      order.push('access');
      expect(e).toEqual({ actorId: OPERATOR, ownerType: 'user', ownerId: USER, requestId: 'req-1' });
    });
    const balances = reader.balances;
    reader.balances = async (...args) => {
      order.push('read');
      return balances(...args);
    };
    const out = await operatorOwnerBalances(reader, { actorId: OPERATOR, requestId: 'req-1' }, { ownerType: 'user', ownerId: USER });
    expect(order).toEqual(['access', 'read']);
    expect(out.balances.map((b) => b.amount)).toContain('3.5');
    for (const b of out.balances) expect(typeof b.amount).toBe('string');
  });

  it('refuses the read when the access row cannot be written', async () => {
    let read = false;
    const reader = await memoryReader(async () => Promise.reject(new Error('access log down')));
    reader.balances = async () => {
      read = true;
      return [];
    };
    await expect(
      operatorOwnerBalances(reader, { actorId: OPERATOR, requestId: null }, { ownerType: 'user', ownerId: USER }),
    ).rejects.toThrow('access log down');
    expect(read).toBe(false);
  });

  it('refuses a blank owner id and an unknown owner type before recording anything', async () => {
    let recorded = 0;
    const reader = await memoryReader(async () => {
      recorded += 1;
    });
    await expect(
      operatorOwnerBalances(reader, { actorId: OPERATOR, requestId: null }, { ownerType: 'user', ownerId: '  ' }),
    ).rejects.toThrow();
    await expect(
      operatorOwnerBalances(reader, { actorId: OPERATOR, requestId: null }, { ownerType: 'bank' as 'user', ownerId: USER }),
    ).rejects.toThrow();
    expect(recorded).toBe(0);
  });
});

// ── Postgres: the access log is real and append-only ─────────────────────────

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => (schema: string) => rewriteSchemaSql(readFileSync(join(drizzleDir, f), 'utf8'), 'ledger', schema));
// PG-hard: no skip. The access log is the audit of who read whose balances; a run without Postgres fails here.
{
  describe('operator_access_log (0024)', () => {
    let db: TestDb;
    beforeAll(async () => {
      db = await createTestDb({ service: 'ledger_access_log', url: URL, migrations });
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('stores one row per read with actor, target and time', async () => {
      await recordOperatorAccess(db.sql, { actorId: OPERATOR, ownerType: 'user', ownerId: USER, requestId: 'req-db-1' });
      const rows =
        await db.sql`SELECT actor_id, action, target_owner_type, target_owner_id, request_id, accessed_at FROM operator_access_log WHERE request_id = 'req-db-1'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: OPERATOR,
        action: 'owner_balances.read',
        target_owner_type: 'user',
        target_owner_id: USER,
      });
      expect(rows[0]?.accessed_at).toBeInstanceOf(Date);
    });

    it('refuses UPDATE, DELETE and TRUNCATE', async () => {
      await recordOperatorAccess(db.sql, { actorId: OPERATOR, ownerType: 'house', ownerId: 'fees', requestId: 'req-db-2' });
      await expect(db.sql`UPDATE operator_access_log SET actor_id = 'someone-else' WHERE request_id = 'req-db-2'`).rejects.toThrow(
        /append-only/,
      );
      await expect(db.sql`DELETE FROM operator_access_log WHERE request_id = 'req-db-2'`).rejects.toThrow(/append-only/);
      await expect(db.sql`TRUNCATE operator_access_log`).rejects.toThrow(/append-only/);
    });

    it('stores a transaction lookup and a business-key trace with their own action (0026)', async () => {
      const txId = '99999999-9999-4999-8999-999999999999';
      await recordOperatorAccess(db.sql, {
        actorId: OPERATOR,
        ownerType: 'transaction',
        ownerId: txId,
        requestId: 'req-db-3',
        action: 'transaction.read',
      });
      await recordOperatorAccess(db.sql, {
        actorId: OPERATOR,
        ownerType: 'business_key',
        ownerId: 'deposit:crypto-native:0xabc',
        requestId: 'req-db-3',
        action: 'trace.read',
      });
      const rows =
        await db.sql`SELECT action, target_owner_type, target_owner_id FROM operator_access_log WHERE request_id = 'req-db-3' ORDER BY id`;
      expect(rows.map((r) => ({ ...r }))).toEqual([
        { action: 'transaction.read', target_owner_type: 'transaction', target_owner_id: txId },
        { action: 'trace.read', target_owner_type: 'business_key', target_owner_id: 'deposit:crypto-native:0xabc' },
      ]);
    });

    it('refuses an empty actor and an unknown action', async () => {
      await expect(recordOperatorAccess(db.sql, { actorId: '', ownerType: 'user', ownerId: USER, requestId: null })).rejects.toThrow();
      await expect(
        db.sql`INSERT INTO operator_access_log (actor_id, action, target_owner_type, target_owner_id) VALUES ('op', 'export', 'user', 'u')`,
      ).rejects.toThrow();
    });
  });
}
