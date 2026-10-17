/**
 * Idle timeout for a multiplexed socket that holds no subscription.
 *
 * A published `WS_MUX_IDLE_MS` wins. Blank falls back to a connection idle
 * setting when the caller has one. This service's heartbeat is a ping cadence,
 * not that setting, so production passes `undefined` and refuses to mount the
 * multiplexed door instead of inventing a duration.
 */

export const MUX_IDLE_UNSET = 'ws.mux_idle_unset';

export function publishedPositiveMs(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Published mux idle, else the connection idle fallback, else unpublished. */
export function resolveMuxIdleMs(configured: number | undefined, connectionIdleMs: number | undefined): number | undefined {
  if (publishedPositiveMs(configured)) return configured;
  if (publishedPositiveMs(connectionIdleMs)) return connectionIdleMs;
  return undefined;
}

/** Startup guard: a mux gateway must not run without an idle timeout. */
export function requireMuxIdleMs(idleMs: number | undefined): number {
  if (!publishedPositiveMs(idleMs)) throw new Error(MUX_IDLE_UNSET);
  return idleMs;
}
