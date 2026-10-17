/**
 * Conditional-order tick. Default off.
 *
 * The host does not invent a cadence. A blank interval leaves the host with no
 * timer even when the flag is on. evaluate() itself still refuses to claim a
 * row unless the caller passes enabled: true, so a process that never starts
 * the timer cannot fire by accident.
 */
import { createJobHost, type JobHost } from '../job-host.js';

export interface ConditionalJobsConfig {
  /** Master kill. False = host created, no interval, nothing claims a row. */
  readonly enabled: boolean;
  /** Null = do not schedule. There is no product default cadence. */
  readonly intervalMs: number | null;
}

export interface ConditionalJobsDeps {
  readonly config: ConditionalJobsConfig;
  readonly evaluate: () => Promise<unknown>;
  readonly onError?: (name: string, err: unknown) => void;
}

export interface ConditionalJobsHandle {
  readonly host: JobHost;
  stop(): void;
}

/** True only when the flag is on and an interval is set. A blank interval is no trigger. */
export function conditionalTriggerScheduled(
  config: ConditionalJobsConfig,
): config is ConditionalJobsConfig & { readonly intervalMs: number } {
  return config.enabled === true && config.intervalMs != null;
}

export function startConditionalOrderJobs(deps: ConditionalJobsDeps): ConditionalJobsHandle {
  const host = createJobHost({ onError: deps.onError });
  if (!conditionalTriggerScheduled(deps.config)) {
    return { host, stop: () => host.stopAll() };
  }
  host.every('futures.conditional', deps.config.intervalMs, async () => {
    await deps.evaluate();
  });
  return { host, stop: () => host.stopAll() };
}
