/**
 * Signal-handler body. index.ts arms SIGTERM/SIGINT and calls this.
 *
 * stopAndDrain already stopped the poll. A rejection means a sync is still
 * inside #running — do not db.close() under it. app.close, and db.close when
 * the drain finished, may reject: log those and still exit. This promise must
 * not reject, or process.once leaves the process up. No deadline of its own;
 * the drain budget stays the stopAndDrain default.
 */

const DRAIN_STILL_RUNNING = 'indexer drain timed out on shutdown — leaving the database open';
const APP_CLOSE_FAILED = 'indexer shutdown: app.close failed';
const DB_CLOSE_FAILED = 'indexer shutdown: db.close failed';

export async function shutdownIndexer(deps: {
  stopAndDrain: () => Promise<void>;
  closeApp: () => Promise<void>;
  closeDb: () => Promise<void>;
  logError: (err: unknown, message: string) => void;
  exit: (code: number) => void;
}): Promise<void> {
  let drained = false;
  try {
    try {
      await deps.stopAndDrain();
      drained = true;
    } catch (err) {
      logFailure(deps, err, DRAIN_STILL_RUNNING);
    }

    try {
      await deps.closeApp();
    } catch (err) {
      logFailure(deps, err, APP_CLOSE_FAILED);
    }

    if (drained) {
      try {
        await deps.closeDb();
      } catch (err) {
        logFailure(deps, err, DB_CLOSE_FAILED);
      }
    }
  } finally {
    deps.exit(0);
  }
}

function logFailure(
  deps: { logError: (err: unknown, message: string) => void },
  err: unknown,
  message: string,
): void {
  try {
    deps.logError(err, message);
  } catch {
    // A thrown logger must not skip exit or become an unhandled rejection.
  }
}
