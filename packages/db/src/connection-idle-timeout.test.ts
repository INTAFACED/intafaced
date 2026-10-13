/**
 * Unit card: createDb idle_in_transaction_session_timeout
 *
 * 1. Promise: every pooled session carries a bound on how long it may sit idle inside an open transaction.
 * 2. Break: a transaction that waits on another connection from the same pool (or on an HTTP call) pins its
 *    connection and locks forever and starves the pool.
 * 3. Done bar: default 60 s, owner-set value honoured, 0 disables; Postgres reports the value back.
 */
import { describe, expect, it } from 'vitest';
import { createDb } from './connection.js';

const url = process.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!url)('createDb idle-in-transaction bound (real Postgres)', () => {
  async function timeoutFor(extra: { idleInTransactionTimeoutMs?: number }): Promise<string> {
    const db = createDb({ url: url!, schema: 'public', max: 1, ...extra }, {});
    try {
      const [row] = await db.sql<{ idle_in_transaction_session_timeout: string }[]>`SHOW idle_in_transaction_session_timeout`;
      return row!.idle_in_transaction_session_timeout;
    } finally {
      await db.close();
    }
  }

  it('defaults to one minute', async () => {
    expect(await timeoutFor({})).toBe('1min');
  });

  it('honours an owner-set value and 0 disables', async () => {
    expect(await timeoutFor({ idleInTransactionTimeoutMs: 5_000 })).toBe('5s');
    expect(await timeoutFor({ idleInTransactionTimeoutMs: 0 })).toBe('0');
  });

  it('ends a session that idles inside a transaction past the bound', async () => {
    const victim = createDb({ url: url!, schema: 'idlebound_victim', max: 1, idleInTransactionTimeoutMs: 1_000 }, {});
    const observer = createDb({ url: url!, schema: 'idlebound_observer', max: 1 }, {});
    const idleSessions = async () => {
      const [row] = await observer.sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE application_name = 'idlebound_victim' AND state = 'idle in transaction'
      `;
      return Number(row!.n);
    };
    try {
      const reserved = await victim.sql.reserve();
      await reserved`BEGIN`;
      await reserved`SELECT 1`;
      expect(await idleSessions()).toBe(1);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(await idleSessions()).toBe(0);
    } finally {
      await victim.close().catch(() => undefined);
      await observer.close();
    }
  }, 15_000);
});
