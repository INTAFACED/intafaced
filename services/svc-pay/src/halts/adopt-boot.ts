/** How many times boot will ask the halt store to adopt its auto-trip config. */
export const ADOPT_CONFIG_ATTEMPTS = 5;
/** Backoff never grows past this. The schedule starts at 1s and doubles. */
export const ADOPT_CONFIG_BACKOFF_CAP_MS = 16_000;

/** Wait after a failed attempt, before the next one. Attempt 1 waits 1s; the cap is 16s. */
export function adoptConfigBackoffMs(failedAttempt: number): number {
  const shift = Math.max(0, failedAttempt - 1);
  const delay = 1_000 * 2 ** Math.min(shift, 16);
  return Math.min(ADOPT_CONFIG_BACKOFF_CAP_MS, delay);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `adopt` up to five times. Each failure is logged. The waits are 1s, 2s, 4s, 8s,
 * and would stop at 16s. The last failure returns: boot is not held open, and a down
 * database cannot turn this into an endless loop.
 */
export async function retryAdoptConfig(
  adopt: () => Promise<void>,
  onFailure: (error: unknown, attempt: number) => void,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  for (let attempt = 1; attempt <= ADOPT_CONFIG_ATTEMPTS; attempt += 1) {
    try {
      await adopt();
      return;
    } catch (error) {
      onFailure(error, attempt);
      if (attempt === ADOPT_CONFIG_ATTEMPTS) return;
      await sleep(adoptConfigBackoffMs(attempt));
    }
  }
}
