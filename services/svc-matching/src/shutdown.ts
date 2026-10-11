/**
 * SIGTERM / SIGINT drain.
 *
 * `setEnabled(false)` runs first. A rejection from `app.close()` or
 * `bus.close()` must not skip `journal.close()` or the exit: the journal
 * file descriptor and its writer lock stay held until `close()`. The caller
 * supplies `exit` so a unit test can observe the sequence without ending
 * the process.
 */
const drains = new WeakMap<object, Promise<void>>();

export function shutdownMatching(input: {
  engine: { setEnabled(enabled: boolean): void };
  app: { close(): Promise<unknown> };
  bus: { close(): Promise<unknown> };
  journal: { close(): void };
  exit: (code: number) => void;
}): Promise<void> {
  const existing = drains.get(input.journal);
  if (existing) return existing;
  const drain = drainMatching(input);
  drains.set(input.journal, drain);
  return drain;
}

async function drainMatching(input: Parameters<typeof shutdownMatching>[0]): Promise<void> {
  input.engine.setEnabled(false);
  try {
    await input.app.close();
  } catch {
    // HTTP close failed. The journal still has to release its descriptor.
  }
  try {
    await input.bus.close();
  } catch {
    // Bus close failed. The journal still has to release its descriptor.
  }
  try {
    input.journal.close();
  } catch {
    input.exit(1);
    return;
  }
  input.exit(0);
}
