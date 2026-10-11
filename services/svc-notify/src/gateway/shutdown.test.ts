import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayShutdown } from './shutdown.js';

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('independent relay graceful shutdown', () => {
  it('still closes SQL when HTTP close rejects, without exposing the error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed: string[] = [];
    const shutdown = createRelayShutdown({
      closeHttp: async () => {
        closed.push('http');
        throw new Error('synthetic-private-credential');
      },
      closeSql: async () => {
        closed.push('sql');
      },
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(closed).toEqual(['http', 'sql']);
    expect(log.mock.calls).toEqual([['notify.relay.shutdown_unavailable']]);
    expect(process.exitCode).toBe(1);
  });

  it('reports SQL failure once and reuses the original shutdown promise', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closeHttp = vi.fn(async () => undefined);
    const closeSql = vi.fn(async () => {
      throw new Error('postgres://synthetic-private-credential@fixture');
    });
    const shutdown = createRelayShutdown({ closeHttp, closeSql });
    const first = shutdown();
    expect(shutdown()).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(shutdown()).toBe(first);
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(closeSql).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([['notify.relay.shutdown_unavailable']]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps SQL open until HTTP drain finishes across repeated calls', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let finishHttp!: () => void;
    const drained = new Promise<void>((resolve) => {
      finishHttp = resolve;
    });
    const closeHttp = vi.fn(() => drained);
    const closeSql = vi.fn(async () => undefined);
    const shutdown = createRelayShutdown({ closeHttp, closeSql });
    const first = shutdown();
    expect(shutdown()).toBe(first);
    await Promise.resolve();
    expect(closeSql).not.toHaveBeenCalled();
    finishHttp();
    await first;
    expect(shutdown()).toBe(first);
    expect(closeHttp).toHaveBeenCalledTimes(1);
    expect(closeSql).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  });
});
