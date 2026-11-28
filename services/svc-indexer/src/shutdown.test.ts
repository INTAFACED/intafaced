import { describe, expect, it, vi } from 'vitest';
import { MemoryChainSource } from './chain/memory-source.js';
import { Indexer } from './indexer.js';
import { MemoryProjectionStore } from './projection/memory-store.js';
import { shutdownIndexer } from './shutdown.js';
import { bootIndexer } from './testing/boot.js';
import { CHAIN_ID } from './testing/conformance.js';

const DRAIN_STILL_RUNNING = 'indexer drain timed out on shutdown — leaving the database open';
const APP_CLOSE_FAILED = 'indexer shutdown: app.close failed';
const DB_CLOSE_FAILED = 'indexer shutdown: db.close failed';

type Log = { err: unknown; message: string };

function record() {
  const order: string[] = [];
  const logs: Log[] = [];
  return {
    order,
    logs,
    logError(err: unknown, message: string) {
      logs.push({ err, message });
    },
    exit(code: number) {
      order.push(`exit:${code}`);
    },
  };
}

describe('shutdownIndexer', () => {
  it('closes the app and the database after a clean drain, then exits', async () => {
    const rec = record();
    await expect(
      shutdownIndexer({
        stopAndDrain: async () => {
          rec.order.push('drain');
        },
        closeApp: async () => {
          rec.order.push('app');
        },
        closeDb: async () => {
          rec.order.push('db');
        },
        logError: rec.logError,
        exit: rec.exit,
      }),
    ).resolves.toBeUndefined();
    expect(rec.order).toEqual(['drain', 'app', 'db', 'exit:0']);
    expect(rec.logs).toEqual([]);
  });

  it('does not close the database when stopAndDrain throws because a sync is still running', async () => {
    const rec = record();
    const stillRunning = new Error('indexer still running after 30000ms drain');
    await expect(
      shutdownIndexer({
        stopAndDrain: async () => {
          rec.order.push('drain');
          throw stillRunning;
        },
        closeApp: async () => {
          rec.order.push('app');
        },
        closeDb: async () => {
          rec.order.push('db');
        },
        logError: rec.logError,
        exit: rec.exit,
      }),
    ).resolves.toBeUndefined();
    expect(rec.order).toEqual(['drain', 'app', 'exit:1']);
    expect(rec.logs).toEqual([{ err: stillRunning, message: DRAIN_STILL_RUNNING }]);
  });

  it('logs an app.close rejection, still closes the database, and exits', async () => {
    const rec = record();
    const appErr = new Error('app close failed');
    await expect(
      shutdownIndexer({
        stopAndDrain: async () => {
          rec.order.push('drain');
        },
        closeApp: async () => {
          rec.order.push('app');
          throw appErr;
        },
        closeDb: async () => {
          rec.order.push('db');
        },
        logError: rec.logError,
        exit: rec.exit,
      }),
    ).resolves.toBeUndefined();
    expect(rec.order).toEqual(['drain', 'app', 'db', 'exit:1']);
    expect(rec.logs).toEqual([{ err: appErr, message: APP_CLOSE_FAILED }]);
  });

  it('logs a db.close rejection and still exits', async () => {
    const rec = record();
    const dbErr = new Error('db close failed');
    await expect(
      shutdownIndexer({
        stopAndDrain: async () => {
          rec.order.push('drain');
        },
        closeApp: async () => {
          rec.order.push('app');
        },
        closeDb: async () => {
          rec.order.push('db');
          throw dbErr;
        },
        logError: rec.logError,
        exit: rec.exit,
      }),
    ).resolves.toBeUndefined();
    expect(rec.order).toEqual(['drain', 'app', 'db', 'exit:1']);
    expect(rec.logs).toEqual([{ err: dbErr, message: DB_CLOSE_FAILED }]);
  });

  it('logs both close rejections and exits once', async () => {
    const rec = record();
    const appErr = new Error('app close failed');
    const dbErr = new Error('db close failed');
    await expect(
      shutdownIndexer({
        stopAndDrain: async () => {
          rec.order.push('drain');
        },
        closeApp: async () => {
          rec.order.push('app');
          throw appErr;
        },
        closeDb: async () => {
          rec.order.push('db');
          throw dbErr;
        },
        logError: rec.logError,
        exit: rec.exit,
      }),
    ).resolves.toBeUndefined();
    expect(rec.order).toEqual(['drain', 'app', 'db', 'exit:1']);
    expect(rec.logs).toEqual([
      { err: appErr, message: APP_CLOSE_FAILED },
      { err: dbErr, message: DB_CLOSE_FAILED },
    ]);
  });

  it('index.ts calls shutdownIndexer and does not add a second timeout', async () => {
    // The booted service, shut down by its own signal handlers.
    const booted = await bootIndexer();
    const { Indexer: BootedIndexer } = await import('./indexer.js');
    const drain = vi.spyOn(BootedIndexer.prototype, 'stopAndDrain');
    try {
      expect(booted.signalHandlers.SIGTERM).toHaveLength(1);
      expect(booted.signalHandlers.SIGINT).toHaveLength(1);
      booted.raise('SIGTERM');
      // SIGINT on top of SIGTERM shares the one drain and close sequence.
      booted.raise('SIGINT');
      await booted.exited();
      // Let every callback already queued run (no clock): a second drain or close started by SIGINT would land here.
      for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((r) => setImmediate(r));
      // Drain first with the indexer's own bound (no second timeout passed in), then the app, then the database once.
      expect(drain).toHaveBeenCalledTimes(1);
      expect(drain.mock.calls[0]).toEqual([]);
      expect(booted.record.order).toEqual(['app', 'db', 'exit:0']);
      expect(booted.record.dbCloses).toBe(1);
      expect(booted.record.exits).toEqual([0]);
    } finally {
      drain.mockRestore();
      await booted.close();
    }

    // The bound is the indexer's: a pass that never finishes fails the drain after 30 s, with the bound named.
    vi.useFakeTimers({ now: new Date('2026-11-28T00:00:00.000Z') });
    try {
      const hanging = new Proxy(new MemoryChainSource(CHAIN_ID), {
        get: (target, key, receiver) => {
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === 'function' ? () => new Promise(() => undefined) : value;
        },
      });
      const indexer = new Indexer({
        source: hanging,
        store: new MemoryProjectionStore(CHAIN_ID),
        finalityDepth: 64,
        ingestEnabled: () => true,
        startHeight: 0,
      });
      indexer.start(60_000);
      const drained = indexer.stopAndDrain().then(
        () => null,
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(29_990);
      await vi.advanceTimersByTimeAsync(30);
      expect(await drained).toEqual(new Error('indexer still running after 30000ms drain'));
    } finally {
      vi.useRealTimers();
    }

    // shutdownIndexer adds no timer of its own.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const rec = record();
      await shutdownIndexer({
        stopAndDrain: async () => undefined,
        closeApp: async () => undefined,
        closeDb: async () => undefined,
        logError: rec.logError,
        exit: rec.exit,
      });
      expect(timers).not.toHaveBeenCalled();
      expect(rec.order).toEqual(['exit:0']);
    } finally {
      timers.mockRestore();
    }
  });
});
