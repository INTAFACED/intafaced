import { describe, expect, it, vi } from 'vitest';
import { createBusLifecycle, type BusLifecycleConnectResult } from './bus-lifecycle.js';

const log = { info: vi.fn(), warn: vi.fn() };

function ok(partial: Partial<BusLifecycleConnectResult> = {}): BusLifecycleConnectResult {
  return {
    close: vi.fn(async () => undefined),
    tradesUp: true,
    privateUp: false,
    ...partial,
  };
}

async function flushUntil(pred: () => boolean, turns = 40): Promise<void> {
  for (let i = 0; i < turns && !pred(); i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

describe('bus lifecycle reconnect', () => {
  it('retries after boot failure and flips tradesBus true without a restart', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const first = ok({ tradesUp: true });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 10,
      maxBackoffMs: 40,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      attempt: async () => {
        calls += 1;
        if (calls < 3) throw new Error('nats down');
        return first;
      },
    });

    lifecycle.start();
    // Drain the async loop: fail, sleep, fail, sleep, success.
    await flushUntil(() => lifecycle.tradesBus());

    expect(calls).toBe(3);
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(false);
    expect(sleeps).toEqual([10, 20]); // exponential
    expect(log.warn).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();

    await lifecycle.stop();
    expect(first.close).toHaveBeenCalled();
    expect(lifecycle.tradesBus()).toBe(false);
  });

  it('does not retry forever after stop mid-backoff', async () => {
    let calls = 0;
    // Box so TypeScript sees nested assignment (plain let T|null narrows to never at call site).
    const sleepGate: { release: (() => void) | null } = { release: null };
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 1_000,
      sleep: () =>
        new Promise<void>((resolve) => {
          sleepGate.release = resolve;
        }),
      attempt: async () => {
        calls += 1;
        throw new Error('still down');
      },
    });

    lifecycle.start();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);

    const stopPromise = lifecycle.stop();
    sleepGate.release?.();
    await stopPromise;

    // No further attempts after stop.
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(lifecycle.tradesBus()).toBe(false);
  });

  it('closes a late success that lands after stop', async () => {
    const attemptGate: { resolve: ((r: BusLifecycleConnectResult) => void) | null } = { resolve: null };
    const result = ok({ tradesUp: true, privateUp: true });
    const lifecycle = createBusLifecycle({
      log,
      attempt: () =>
        new Promise((resolve) => {
          attemptGate.resolve = resolve;
        }),
    });

    lifecycle.start();
    const stopPromise = lifecycle.stop();
    // Resolve attempt after stop was requested.
    attemptGate.resolve?.(result);
    await stopPromise;

    expect(result.close).toHaveBeenCalled();
    expect(lifecycle.tradesBus()).toBe(false);
    expect(lifecycle.privateBus()).toBe(false);
  });

  it('parks after first successful attach — does not re-attempt (nats.js owns mid-session)', async () => {
    let calls = 0;
    const first = ok({ tradesUp: true, privateUp: true });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 5,
      sleep: async () => undefined,
      attempt: async () => {
        calls += 1;
        return first;
      },
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.tradesBus());
    expect(lifecycle.tradesBus()).toBe(true);
    expect(calls).toBe(1);

    // Give the loop time to misbehave if it re-entered after success.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(true);

    await lifecycle.stop();
    expect(first.close).toHaveBeenCalled();
  });

  it('retries when attempt returns neither trades nor private up', async () => {
    let calls = 0;
    const empty = ok({ tradesUp: false, privateUp: false });
    const good = ok({ tradesUp: true, privateUp: true });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 5,
      sleep: async () => undefined,
      attempt: async () => {
        calls += 1;
        return calls === 1 ? empty : good;
      },
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.tradesBus());

    expect(calls).toBe(2);
    expect(empty.close).toHaveBeenCalled();
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(true);
    await lifecycle.stop();
  });

  it('retries drop-copy independently of the private half without tearing the tape', async () => {
    let attempts = 0;
    let dropTries = 0;
    let privateTries = 0;
    const first = ok({
      tradesUp: true,
      privateUp: false,
      dropCopyUp: false,
      retryPrivate: async () => {
        privateTries += 1;
        return privateTries >= 5;
      },
      retryDropCopy: async () => {
        dropTries += 1;
        return dropTries >= 2;
      },
    });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 5,
      sleep: async () => undefined,
      attempt: async () => {
        attempts += 1;
        return first;
      },
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.dropCopyBus());

    expect(attempts).toBe(1);
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.dropCopyBus()).toBe(true);
    expect(dropTries).toBe(2);
    expect(privateTries).toBeGreaterThanOrEqual(2);
    expect(first.close).not.toHaveBeenCalled();

    await flushUntil(() => lifecycle.privateBus());
    expect(lifecycle.privateBus()).toBe(true);
    expect(attempts).toBe(1);

    await lifecycle.stop();
    expect(first.close).toHaveBeenCalled();
  });

  it('retries private half without tearing the tape or re-attempting connect', async () => {
    let attempts = 0;
    let privateTries = 0;
    const first = ok({
      tradesUp: true,
      privateUp: false,
      retryPrivate: async () => {
        privateTries += 1;
        return privateTries >= 3;
      },
    });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 5,
      sleep: async () => undefined,
      attempt: async () => {
        attempts += 1;
        return first;
      },
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.privateBus());

    expect(attempts).toBe(1);
    expect(privateTries).toBe(3);
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(true);
    expect(first.close).not.toHaveBeenCalled();

    await lifecycle.stop();
    expect(first.close).toHaveBeenCalled();
  });

  it('treats a throwing retryPrivate as still-down and keeps the tape', async () => {
    let privateTries = 0;
    const first = ok({
      tradesUp: true,
      privateUp: false,
      retryPrivate: async () => {
        privateTries += 1;
        if (privateTries < 2) throw new Error('durable race');
        return true;
      },
    });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 5,
      sleep: async () => undefined,
      attempt: async () => first,
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.privateBus());

    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(true);
    expect(privateTries).toBe(2);
    expect(first.close).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  it('stop during private-half retry closes the tape and does not flip privateBus', async () => {
    const sleepGate: { release: (() => void) | null } = { release: null };
    const first = ok({
      tradesUp: true,
      privateUp: false,
      retryPrivate: async () => {
        throw new Error('should not run after stop if we stop during first backoff');
      },
    });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 1_000,
      sleep: () =>
        new Promise<void>((resolve) => {
          sleepGate.release = resolve;
        }),
      attempt: async () => first,
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.tradesBus());
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(false);

    const stopPromise = lifecycle.stop();
    sleepGate.release?.();
    await stopPromise;

    expect(first.close).toHaveBeenCalled();
    expect(lifecycle.tradesBus()).toBe(false);
    expect(lifecycle.privateBus()).toBe(false);
  });

  it('re-attaches after sessionLost without a process restart', async () => {
    let calls = 0;
    const lost: { fire: (() => void) | null } = { fire: null };
    const first = ok({
      tradesUp: true,
      privateUp: true,
      sessionLost: new Promise<void>((resolve) => {
        lost.fire = resolve;
      }),
    });
    const second = ok({ tradesUp: true, privateUp: true });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 5,
      sleep: async () => undefined,
      attempt: async () => {
        calls += 1;
        return calls === 1 ? first : second;
      },
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.tradesBus());
    expect(calls).toBe(1);
    expect(lifecycle.tradesBus()).toBe(true);

    lost.fire?.();
    await flushUntil(() => calls >= 2);

    expect(calls).toBe(2);
    expect(first.close).toHaveBeenCalled();
    expect(lifecycle.tradesBus()).toBe(true);
    expect(lifecycle.privateBus()).toBe(true);

    await lifecycle.stop();
  });

  it('stop while waiting on sessionLost does not re-attempt', async () => {
    let calls = 0;
    const lost: { fire: (() => void) | null } = { fire: null };
    const first = ok({
      tradesUp: true,
      privateUp: true,
      close: vi.fn(async () => {
        lost.fire?.();
      }),
      sessionLost: new Promise<void>((resolve) => {
        lost.fire = resolve;
      }),
    });
    const lifecycle = createBusLifecycle({
      log,
      attempt: async () => {
        calls += 1;
        return first;
      },
    });

    lifecycle.start();
    await flushUntil(() => lifecycle.tradesBus());
    expect(calls).toBe(1);

    await lifecycle.stop();
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(first.close).toHaveBeenCalled();
    expect(lifecycle.tradesBus()).toBe(false);
  });

  it('reports the tape down when sessionLost resolves while a private retry never attaches', async () => {
    let attempts = 0;
    let privateTries = 0;
    let sleeps = 0;
    const lost: { fire: (() => void) | null } = { fire: null };
    const sleepGate: { release: (() => void) | null } = { release: null };
    const secondGate: { release: (() => void) | null } = { release: null };
    const first = ok({
      tradesUp: true,
      privateUp: false,
      retryPrivate: async () => {
        privateTries += 1;
        return false;
      },
      sessionLost: new Promise<void>((resolve) => {
        lost.fire = resolve;
      }),
    });
    const second = ok({ tradesUp: true, privateUp: true });
    const lifecycle = createBusLifecycle({
      log,
      initialBackoffMs: 1_000,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          sleepGate.release = resolve;
        });
      },
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) return first;
        return new Promise((resolve) => {
          secondGate.release = () => resolve(second);
        });
      },
    });

    try {
      lifecycle.start();
      await flushUntil(() => lifecycle.tradesBus() && privateTries >= 1);
      expect(lifecycle.tradesBus()).toBe(true);
      expect(attempts).toBe(1);
      expect(privateTries).toBeGreaterThanOrEqual(1);
      expect(first.close).not.toHaveBeenCalled();

      lost.fire?.();
      await flushUntil(() => lifecycle.tradesBus() === false && attempts >= 2);

      expect(first.close).toHaveBeenCalled();
      expect(lifecycle.tradesBus()).toBe(false);
      expect(attempts).toBe(2);
    } finally {
      const stopping = lifecycle.stop();
      sleepGate.release?.();
      secondGate.release?.();
      await stopping;
    }
  });
});

describe('bus lifecycle interrupted half retry', () => {
  it('reattaches a lost session without waiting for a hung half and ignores its late success', async () => {
    let lose!: () => void;
    let release!: (up: boolean) => void;
    let calls = 0;
    const retry = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const first = ok({
      privateUp: false,
      retryPrivate: retry,
      sessionLost: new Promise<void>((resolve) => {
        lose = resolve;
      }),
    });
    const next = ok({ privateUp: false, dropCopyUp: true });
    const lifecycle = createBusLifecycle({
      log,
      sleep: async () => undefined,
      attempt: async () => {
        calls++;
        return calls === 1 ? first : next;
      },
    });
    try {
      lifecycle.start();
      await flushUntil(() => retry.mock.calls.length === 1);
      lose();
      await flushUntil(() => calls === 2);
      expect(calls).toBe(2);
      expect(first.close).toHaveBeenCalledTimes(1);
      release(true);
      await flushUntil(() => lifecycle.dropCopyBus());
      expect(lifecycle.privateBus()).toBe(false);
      expect(lifecycle.dropCopyBus()).toBe(true);
    } finally {
      release(false);
      await lifecycle.stop();
    }
  });
});
