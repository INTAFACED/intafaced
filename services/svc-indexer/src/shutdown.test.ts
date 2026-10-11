import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shutdownIndexer } from './shutdown.js';

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

  it('index.ts calls shutdownIndexer and does not add a second timeout', () => {
    const indexSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const indexerSrc = readFileSync(new URL('./indexer.ts', import.meta.url), 'utf8');
    const shutdownSrc = readFileSync(new URL('./shutdown.ts', import.meta.url), 'utf8');
    expect(indexSrc).toMatch(/for \(const signal of \['SIGTERM', 'SIGINT'\] as const\)/);
    expect(indexSrc).toMatch(/process\.once\(signal,/);
    expect(indexSrc).toContain('shutdownIndexer(');
    expect(indexSrc).toContain('shutdownPromise ??=');
    expect(indexSrc).toMatch(/stopAndDrain:\s*\(\)\s*=>\s*indexer\.stopAndDrain\(\)/);
    expect(indexSrc).not.toMatch(/await\s+db\.close\(\)/);
    expect(indexSrc).not.toMatch(/stopAndDrain\(\s*[\d_]/);
    expect(indexerSrc).toMatch(/async stopAndDrain\(timeoutMs = 30_000\)/);
    expect(indexerSrc).toMatch(/throw new Error\(`indexer still running after \$\{timeoutMs\}ms drain`\)/);
    expect(shutdownSrc).not.toMatch(/30_000|setTimeout|timeoutMs/);
  });
});
