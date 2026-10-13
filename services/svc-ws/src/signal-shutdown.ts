/**
 * SIGTERM / SIGINT shutdown for svc-ws.
 *
 * Stop producing before closing sockets, so nothing is written to a socket
 * that is mid-close. Callers pass `WS_COPY.shuttingDown` as the close reason.
 *
 * A rejection from stop or any close still exits non-zero. The listener
 * promise does not reject. The listener stays registered with `on`, so a
 * second signal while the first shutdown is in flight still exits.
 */

export interface SignalShutdownSteps {
  disable(): void;
  stopPoller(): void;
  stopBus(): Promise<void>;
  closeGateway(reason: string): Promise<void>;
  closePrivateGateway(reason: string): Promise<void>;
  closeDropCopyGateway(reason: string): Promise<void>;
  closeApp(): Promise<void>;
}

export interface SignalShutdownTarget {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
}

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

const EXIT_OK = 0;
const EXIT_FAILED = 1;

export async function runSignalShutdown(steps: SignalShutdownSteps, exit: (code: number) => void, reason: string): Promise<void> {
  try {
    steps.disable();
    steps.stopPoller();
    await steps.stopBus();
    await steps.closeGateway(reason);
    await steps.closePrivateGateway(reason);
    await steps.closeDropCopyGateway(reason);
    await steps.closeApp();
    exit(EXIT_OK);
  } catch {
    exit(EXIT_FAILED);
  }
}

export function registerSignalShutdown(
  target: SignalShutdownTarget,
  steps: SignalShutdownSteps,
  exit: (code: number) => void,
  reason: string,
): void {
  let started = false;
  const onSignal = (): void => {
    if (started) {
      exit(EXIT_FAILED);
      return;
    }
    started = true;
    void runSignalShutdown(steps, exit, reason).catch(() => {
      exit(EXIT_FAILED);
    });
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    target.on(signal, onSignal);
  }
}
