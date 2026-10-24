import type { OpsRead } from '@/lib/console-announcements/model';
import type { FounderCallResult } from './founder-call';

/**
 * One svc-ops read as a console view: `read` with its data, `unconfigured` when svc-ops says it has no storage for it
 * (`unconfiguredCode`), or `unknown` with why it could not be read. Never a guess.
 */
export function opsReadOf<T>(result: FounderCallResult<T>, unconfiguredCode: string, what: string): OpsRead<T> {
  if (result.kind === 'ok') return { kind: 'read', data: result.data };
  if (result.kind === 'refused' && result.refusal.code === unconfiguredCode) return { kind: 'unconfigured' };
  const code = result.kind === 'refused' || result.kind === 'forbidden' ? result.refusal.code : null;
  const message =
    result.kind === 'forbidden'
      ? 'svc-ops did not accept your founder session for this read (it needs admin:read).'
      : result.kind === 'unavailable'
        ? 'svc-ops did not answer.'
        : result.kind === 'invalid'
          ? 'svc-ops answered in a shape this console does not understand.'
          : result.kind === 'not_built'
            ? `svc-ops has no ${what} on this deployment.`
            : 'svc-ops refused this read.';
  return { kind: 'unknown', message, code };
}
