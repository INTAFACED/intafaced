import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createTestDatabase } from '@intafaced/db';
import { migrateOutreach } from '../db/migrate.js';
import { OPS_IDEMPOTENCY_CONFLICT } from '../codes.js';
import {
  createMemoryRestoreRunStore,
  createPgRestoreRunStore,
  runFingerprint,
  type RestoreOutboxEntry,
  type RestoreRunStore,
} from './run-store.js';

const run = { restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', startedBy: 'founder-a', startedAt: '2026-10-20T12:05:00.000Z' };
const started: RestoreOutboxEntry = {
  event: 'coreOpsRestoreStarted',
  idempotencyKey: 'ops:restore:started:R-1',
  payload: { restoreNo: 'R-1' },
  createdAt: run.startedAt,
};
const stepRow = (step: 'restore_clean' | 'validate') => ({
  restoreNo: 'R-1',
  step,
  actor: 'founder-a',
  approverId: null,
  detail: { attested: true },
  at: '2026-10-20T12:06:00.000Z',
});

function contract(name: string, open: () => Promise<{ store: RestoreRunStore; close: () => Promise<void> }>) {
  describe(name, () => {
    it('keeps the first run for a key, conflicts a different body, and lists it', async () => {
      const { store, close } = await open();
      try {
        const fp = runFingerprint({ restoreNo: 'R-1', cutOff: run.cutOff });
        const first = await store.start('start-key-1', fp, run, started);
        expect(await store.start('start-key-1', fp, run, started)).toEqual(first);
        await expect(store.start('start-key-1', runFingerprint({ other: 1 }), run, started)).rejects.toMatchObject({
          code: OPS_IDEMPOTENCY_CONFLICT,
        });
        await expect(store.start('start-key-2', fp, run, started)).rejects.toMatchObject({ code: OPS_IDEMPOTENCY_CONFLICT });
        expect(await store.get('R-1')).toEqual(first);
        expect(await store.list()).toEqual([first]);
      } finally {
        await close();
      }
    });

    it('writes one row per step, returns the first on a repeat, and conflicts a reused key with another body', async () => {
      const { store, close } = await open();
      try {
        await store.start('start-key-1', 'fp', run, started);
        const fp = runFingerprint({ step: 'restore_clean' });
        const first = await store.appendStep('step-key-1', fp, stepRow('restore_clean'), null);
        expect(await store.appendStep('step-key-1', fp, stepRow('restore_clean'), null)).toEqual(first);
        expect(
          await store.appendStep('step-key-2', runFingerprint({ again: 1 }), { ...stepRow('restore_clean'), actor: 'someone-else' }, null),
        ).toEqual(first);
        await expect(store.appendStep('step-key-1', runFingerprint({ step: 'validate' }), stepRow('validate'), null)).rejects.toMatchObject(
          {
            code: OPS_IDEMPOTENCY_CONFLICT,
          },
        );
        expect(await store.steps('R-1')).toEqual([first]);
      } finally {
        await close();
      }
    });
  });
}

contract('memory restore run store', async () => ({ store: createMemoryRestoreRunStore(), close: async () => undefined }));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('durable restore runs on real PostgreSQL', () => {
  const open = async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    await migrateOutreach(sql);
    return { sql, database, close: async () => (await sql.end(), await database.drop()) };
  };

  contract('postgres restore run store', async () => {
    const opened = await open();
    return { store: createPgRestoreRunStore(opened.sql), close: opened.close };
  });

  it('lists a run and its steps after the service restarts, with one outbox row per business key', async () => {
    const opened = await open();
    try {
      const store = createPgRestoreRunStore(opened.sql);
      await store.start('start-key-1', 'fp', run, started);
      await store.start('start-key-1', 'fp', run, started);
      const step = await store.appendStep('step-key-1', 'fp1', stepRow('restore_clean'), null);
      await opened.sql.end();
      const restarted = postgres(opened.database.url, { max: 2, onnotice: () => undefined });
      try {
        await migrateOutreach(restarted);
        const again = createPgRestoreRunStore(restarted);
        expect((await again.get('R-1'))?.restoreNo).toBe('R-1');
        expect(await again.steps('R-1')).toEqual([step]);
        expect(await restarted`SELECT event FROM ops.restore_outbox`).toHaveLength(1);
      } finally {
        await restarted.end();
      }
    } finally {
      await opened.database.drop();
    }
  });

  it('stores one step row when the same step races, and refuses to edit or delete one', async () => {
    const opened = await open();
    try {
      const store = createPgRestoreRunStore(opened.sql);
      await store.start('start-key-1', 'fp', run, started);
      const rows = await Promise.all(
        Array.from({ length: 6 }, (_, i) => store.appendStep(`step-key-${i}`, `fp${i}`, stepRow('restore_clean'), null)),
      );
      expect(new Set(rows.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(await store.steps('R-1')).toHaveLength(1);
      await expect(opened.sql`UPDATE ops.restore_steps SET actor='x'`).rejects.toThrow(/restore_step_immutable/);
      await expect(opened.sql`DELETE FROM ops.restore_steps`).rejects.toThrow(/restore_step_immutable/);
    } finally {
      await opened.close();
    }
  });

  it('refuses to roll back while a run exists, and reverses cleanly when none does', async () => {
    const opened = await open();
    try {
      const store = createPgRestoreRunStore(opened.sql);
      await store.start('start-key-1', 'fp', run, started);
      await expect(migrateOutreach(opened.sql, 'down')).rejects.toThrow(/restore runs exist/);
      await opened.sql`DELETE FROM ops.restore_outbox`;
      await opened.sql`DELETE FROM ops.restore_runs`;
      await migrateOutreach(opened.sql, 'down');
    } finally {
      await opened.close();
    }
  });
});
