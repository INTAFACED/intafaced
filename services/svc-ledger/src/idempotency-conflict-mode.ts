import { isProductionPosture } from '@intafaced/config';

/**
 * The mode the ledger runs with. Staging and production posture (`isProductionPosture`: APP_ENV other than
 * dev/test, or NODE_ENV=production) always `refuse`, whatever LEDGER_IDEMPOTENCY_CONFLICT_MODE says: `detect`
 * is a rollout mode for dev and test and must not answer a reused key's different body with the original
 * on a real server. Dev and test keep the configured value (default `detect`).
 */
export function resolveIdempotencyConflictMode(
  configured: 'detect' | 'refuse',
  source: Record<string, string | undefined> = process.env,
): 'detect' | 'refuse' {
  return isProductionPosture(source) ? 'refuse' : configured;
}
