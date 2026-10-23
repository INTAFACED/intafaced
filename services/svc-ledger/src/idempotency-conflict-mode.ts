import { isExplicitDevOrTest } from '@intafaced/config';

/** Unset boots as refuse. detect is a dev/test switch, not the deployment default. */
export const DEFAULT_IDEMPOTENCY_CONFLICT_MODE = 'refuse' as const;

/**
 * `detect` returns an older transaction as success when the body differs.
 * That is allowed only when APP_ENV is exactly `dev` or `test`. Unset, blank,
 * staging, prod, and any other spelling refuse to boot.
 */
export function assertIdempotencyConflictBoot(mode: 'detect' | 'refuse', rawAppEnv: string | undefined): void {
  if (mode !== 'detect') return;
  if (isExplicitDevOrTest(rawAppEnv)) return;
  const shown = rawAppEnv === undefined || rawAppEnv.trim() === '' ? '<unset>' : rawAppEnv;
  throw new Error(
    `LEDGER_IDEMPOTENCY_CONFLICT_MODE=detect is refused unless APP_ENV is exactly dev or test (APP_ENV=${shown}). A reused idempotency key with a different body must not count as success.`,
  );
}
