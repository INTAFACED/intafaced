import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createTestDatabase } from '@intafaced/db';
import { migrateOutreach } from './db/migrate.js';
import { OPS_IDEMPOTENCY_CONFLICT } from './codes.js';
import { createMemoryRestoreStore, createPgRestoreStore, stampFingerprint, type RestoreStampStore } from './restore-store.js';
import type { WatermarkStamp } from './operator-desks.js';

const stamp = (watermark: string): WatermarkStamp => ({
  service: 'svc-ledger',
  kind: 'joint',
  watermark,
  recordedAt: '2026-10-20T06:00:00.000Z',
  recordedBy: 'founder-a',
  approverId: 'founder-b',
});

function contract(
  name: string,
  open: () => Promise<{ store: RestoreStampStore; reopen: () => RestoreStampStore; close: () => Promise<void> }>,
) {
  describe(name, () => {
    it('keeps the first row for a key and conflicts a different body', async () => {
      const { store, close } = await open();
      try {
        const fingerprint = stampFingerprint({ watermark: 'seq-1' });
        expect(await store.find('restore-key-1', fingerprint)).toBeNull();
        const first = await store.append('restore-key-1', fingerprint, stamp('seq-1'));
        expect(await store.find('restore-key-1', fingerprint)).toEqual(first);
        expect(await store.append('restore-key-1', fingerprint, stamp('seq-1'))).toEqual(first);
        const other = stampFingerprint({ watermark: 'seq-2' });
        await expect(store.find('restore-key-1', other)).rejects.toMatchObject({ code: OPS_IDEMPOTENCY_CONFLICT });
        await expect(store.append('restore-key-1', other, stamp('seq-2'))).rejects.toMatchObject({ code: OPS_IDEMPOTENCY_CONFLICT });
        expect(await store.list()).toEqual([first]);
      } finally {
        await close();
      }
    });
  });
}

contract('memory restore store', async () => {
  const store = createMemoryRestoreStore();
  return { store, reopen: () => store, close: async () => undefined };
});

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('durable restore stamps on real PostgreSQL', () => {
  const open = async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    await migrateOutreach(sql);
    return {
      sql,
      database,
      store: createPgRestoreStore(sql),
      close: async () => {
        await sql.end();
        await database.drop();
      },
    };
  };

  contract('postgres restore store', async () => {
    const opened = await open();
    return { store: opened.store, reopen: () => createPgRestoreStore(opened.sql), close: opened.close };
  });

  it('lists a stamp after the service restarts', async () => {
    const opened = await open();
    try {
      const fingerprint = stampFingerprint({ watermark: 'seq-9' });
      const written = await opened.store.append('restore-key-9', fingerprint, stamp('seq-9'));
      await opened.sql.end();
      const restarted = postgres(opened.database.url, { max: 2, onnotice: () => undefined });
      try {
        await migrateOutreach(restarted);
        const store = createPgRestoreStore(restarted);
        expect(await store.list()).toEqual([written]);
        expect(await store.find('restore-key-9', fingerprint)).toEqual(written);
      } finally {
        await restarted.end();
      }
    } finally {
      await opened.database.drop();
    }
  });

  it('stores one row when the same key races', async () => {
    const opened = await open();
    try {
      const fingerprint = stampFingerprint({ watermark: 'seq-5' });
      const results = await Promise.all(Array.from({ length: 6 }, () => opened.store.append('restore-key-5', fingerprint, stamp('seq-5'))));
      expect(new Set(results.map((row) => JSON.stringify(row))).size).toBe(1);
      expect(await opened.store.list()).toHaveLength(1);
    } finally {
      await opened.close();
    }
  });

  it('refuses to edit or delete a stored stamp, and reverses cleanly', async () => {
    const opened = await open();
    try {
      await opened.store.append('restore-key-7', stampFingerprint({ watermark: 'seq-7' }), stamp('seq-7'));
      await expect(opened.sql`UPDATE ops.restore_stamps SET watermark='forged'`).rejects.toThrow(/restore_stamp_immutable/);
      await expect(opened.sql`DELETE FROM ops.restore_stamps`).rejects.toThrow(/restore_stamp_immutable/);
      await migrateOutreach(opened.sql, 'down');
      await migrateOutreach(opened.sql);
      expect(await opened.store.list()).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});
