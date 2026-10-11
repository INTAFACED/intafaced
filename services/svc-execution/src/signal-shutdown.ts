export type SignalShutdownSteps = {
  stop: () => Promise<void>;
  close: () => Promise<void>;
  exit: (code: number) => void;
};

/**
 * Stop the capture lake, close the server, then exit.
 * The signal handler detaches this promise, so a rejection from stop or
 * close is caught here and shutdown still reaches process.exit. Close
 * still runs when stop rejects. A failure exits 1. A clean stop and close
 * exits 0.
 */
export async function finishSignalShutdown(steps: SignalShutdownSteps): Promise<void> {
  let failed = false;
  try {
    await steps.stop();
  } catch {
    failed = true;
  }
  try {
    await steps.close();
  } catch {
    failed = true;
  }
  steps.exit(failed ? 1 : 0);
}
