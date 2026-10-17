/**
 * Startup NATS publish.
 *
 * Recover republishes fills, and a hold-check cancel publishes `orderCancelled`,
 * before the process listens. A JetStream ack timeout under load used to kill
 * the process after the book was already replayed and before anything was
 * announced. Retry the same publish (same idempotency key / JetStream msgID)
 * with a bounded backoff, then fail with a named error so the caller can exit
 * before listen. A later attempt does not mint a new message id.
 */

export const STARTUP_PUBLISH_ATTEMPTS = 4;
/** Delay before attempt 2, 3, and 4. Four tries, then stop. */
export const STARTUP_PUBLISH_BACKOFF_MS = [200, 400, 800] as const;

export class StartupPublishError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `svc-matching startup NATS publish timed out after ${attempts} attempts (${detail}); ` +
        'engine replayed but was not announced. Exiting before listen.',
    );
    this.name = 'StartupPublishError';
    this.attempts = attempts;
  }
}

/** NATS JetStream surfaces a lost ack as code TIMEOUT. Other failures are not retried here. */
export function isNatsPublishTimeout(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const record = err as { code?: unknown; message?: unknown; name?: unknown };
  if (record.code === 'TIMEOUT') return true;
  if (typeof record.message === 'string' && record.message.includes('TIMEOUT')) return true;
  if (record.name === 'NatsError' && typeof record.message === 'string' && /timeout/i.test(record.message)) return true;
  return false;
}

export async function publishWithStartupRetry(publish: () => Promise<unknown>, sleep: (ms: number) => Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= STARTUP_PUBLISH_ATTEMPTS; attempt += 1) {
    try {
      await publish();
      return;
    } catch (err) {
      last = err;
      if (!isNatsPublishTimeout(err)) throw err;
      if (attempt === STARTUP_PUBLISH_ATTEMPTS) throw new StartupPublishError(attempt, err);
      await sleep(STARTUP_PUBLISH_BACKOFF_MS[attempt - 1] ?? STARTUP_PUBLISH_BACKOFF_MS[STARTUP_PUBLISH_BACKOFF_MS.length - 1]!);
    }
  }
  throw new StartupPublishError(STARTUP_PUBLISH_ATTEMPTS, last);
}
