import { describe, expect, it } from 'vitest';
import { registerSignalShutdown, type SignalShutdownSteps } from './signal-shutdown.js';

/** Catalog key of `WS_COPY.shuttingDown`. Index passes the constant; this is the wire value. */
const CLOSE_REASON = 'ws.close.shutting_down';

type ShutdownSignal = 'SIGTERM' | 'SIGINT';

function fakeSignals() {
  const listeners = new Map<ShutdownSignal, Array<() => void>>();
  return {
    on(signal: ShutdownSignal, listener: () => void) {
      const list = listeners.get(signal) ?? [];
      list.push(listener);
      listeners.set(signal, list);
    },
    emit(signal: ShutdownSignal) {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener();
    },
  };
}

function recordingSteps(log: string[]): SignalShutdownSteps {
  return {
    disable() {
      log.push('disable');
    },
    stopPoller() {
      log.push('stopPoller');
    },
    async stopBus() {
      log.push('stopBus');
    },
    async closeGateway(reason) {
      log.push(`closeGateway:${reason}`);
    },
    async closePrivateGateway(reason) {
      log.push(`closePrivateGateway:${reason}`);
    },
    async closeDropCopyGateway(reason) {
      log.push(`closeDropCopyGateway:${reason}`);
    },
    async closeApp() {
      log.push('closeApp');
    },
  };
}

const ORDER = [
  'disable',
  'stopPoller',
  'stopBus',
  `closeGateway:${CLOSE_REASON}`,
  `closePrivateGateway:${CLOSE_REASON}`,
  `closeDropCopyGateway:${CLOSE_REASON}`,
  'closeApp',
  'exit:0',
];

describe('svc-ws signal shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s runs disable, stop, and the shutting-down closes, then exits 0', async (signal) => {
    const log: string[] = [];
    const signals = fakeSignals();
    registerSignalShutdown(
      signals,
      recordingSteps(log),
      (code) => {
        log.push(`exit:${code}`);
      },
      CLOSE_REASON,
    );

    signals.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));

    expect(log).toEqual(ORDER);
  });

  it('exits non-zero when a close rejects, and a second signal still exits', async () => {
    const exits: number[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    let rejectClose: (err: Error) => void = () => {};
    const closeGate = new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    let markWaiting: () => void = () => {};
    const waitingOnClose = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });

    const signals = fakeSignals();
    const steps: SignalShutdownSteps = {
      disable() {},
      stopPoller() {},
      async stopBus() {},
      closeGateway() {
        markWaiting();
        return closeGate;
      },
      async closePrivateGateway() {},
      async closeDropCopyGateway() {},
      async closeApp() {},
    };

    try {
      registerSignalShutdown(
        signals,
        steps,
        (code) => {
          exits.push(code);
        },
        CLOSE_REASON,
      );

      signals.emit('SIGTERM');
      await waitingOnClose;

      signals.emit('SIGTERM');
      signals.emit('SIGINT');
      expect(exits.length).toBe(2);

      const beforeRejection = exits.length;
      rejectClose(new Error('gateway close failed'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(exits.length).toBeGreaterThan(beforeRejection);
      const rejectionExit = exits[exits.length - 1];
      expect(rejectionExit).toEqual(expect.any(Number));
      expect(rejectionExit).not.toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
