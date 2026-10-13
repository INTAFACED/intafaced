import { describe, expect, it, vi } from 'vitest';
import { finishSignalShutdown } from './signal-shutdown.js';

describe('finishSignalShutdown', () => {
  it('runs stop, then close, then exits 0 when both succeed', async () => {
    const order: string[] = [];
    await finishSignalShutdown({
      stop: async () => {
        order.push('stop');
      },
      close: async () => {
        order.push('close');
      },
      exit: (code) => {
        order.push(`exit:${code}`);
      },
    });
    expect(order).toEqual(['stop', 'close', 'exit:0']);
  });

  it('still closes and exits non-zero when stop rejects, without rejecting the caller', async () => {
    const order: string[] = [];
    await expect(
      finishSignalShutdown({
        stop: async () => {
          order.push('stop');
          throw new Error('stop failed');
        },
        close: async () => {
          order.push('close');
        },
        exit: (code) => {
          order.push(`exit:${code}`);
        },
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['stop', 'close', 'exit:1']);
  });

  it('exits non-zero when close rejects, without rejecting the caller', async () => {
    const order: string[] = [];
    await expect(
      finishSignalShutdown({
        stop: async () => {
          order.push('stop');
        },
        close: async () => {
          order.push('close');
          throw new Error('close failed');
        },
        exit: (code) => {
          order.push(`exit:${code}`);
        },
      }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['stop', 'close', 'exit:1']);
  });

  it('a detached call still finishes when stop and close both reject, and that rejection is handled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const order: string[] = [];
    try {
      void finishSignalShutdown({
        stop: async () => {
          order.push('stop');
          throw new Error('stop failed');
        },
        close: async () => {
          order.push('close');
          throw new Error('close failed');
        },
        exit: (code) => {
          order.push(`exit:${code}`);
        },
      });
      await vi.waitFor(() => {
        expect(order.at(-1)).toBe('exit:1');
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(order).toEqual(['stop', 'close', 'exit:1']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
