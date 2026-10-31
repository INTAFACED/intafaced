import type { Sql } from 'postgres';
import { createJobHost, type JobHost } from './job-host.js';
import { evaluateSecondsOf, quietSecondsOf, settleWorkers } from './worker-state.js';

export const MINING_WORKER_EVALUATE_JOB = 'mining.worker-evaluate';

/**
 * The worker evaluator: every `MINING_WORKER_EVALUATE_SECONDS` it looks at every worker, records a change between
 * online and offline once (`worker-state.ts`), and stamps the look. It runs only with Postgres, a published evaluation
 * interval and a published quiet interval; otherwise it stays off and the returned code says why. It is apart from the
 * epoch payout job, which needs `MINING_PAYOUT_INTERVAL_MS` and moves value; this one moves none.
 */
export function startWorkerEvaluator(deps: {
  readonly sql: Sql | null;
  readonly env: NodeJS.ProcessEnv;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly onError?: (name: string, err: unknown) => void;
}): { readonly host: JobHost; stop(): void } | { readonly off: string } {
  if (!deps.sql) return { off: 'mining.pg_unavailable' };
  const every = evaluateSecondsOf(deps.env);
  if (typeof every !== 'number') return { off: every };
  const quiet = quietSecondsOf(deps.env);
  if (typeof quiet !== 'number') return { off: quiet };
  const sql = deps.sql;
  const host = createJobHost({
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.setIntervalFn ? { setIntervalFn: deps.setIntervalFn } : {}),
    ...(deps.clearIntervalFn ? { clearIntervalFn: deps.clearIntervalFn } : {}),
  });
  host.every(MINING_WORKER_EVALUATE_JOB, every * 1000, async () => {
    await settleWorkers(sql, quiet, null, true);
  });
  return {
    host,
    stop() {
      host.stopAll();
    },
  };
}
