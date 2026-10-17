import type { RailProbeResult } from './rail-adapter.js';

/**
 * Bounded liveness loop for rail adapters.
 *
 * `lastUpdate` is the last confirmation the rail answered, not the last
 * payment. Without this loop an idle rail goes unknown after 30s and the
 * console reports it down with no reason. One timer per rail, unref'd, with
 * backoff after a failed probe. It does not scan blocks and it does not send
 * money. A failed probe leaves `lastContact` where it was.
 */
export const RAIL_PROBE_INTERVAL_MS = 10_000;
export const RAIL_PROBE_MAX_INTERVAL_MS = 60_000;

export interface ProbeableRail {
  readonly id: string;
  probe?: () => Promise<RailProbeResult>;
}

export function nextProbeDelayMs(previousMs: number, ok: boolean, baseMs: number, maxMs: number): number {
  if (ok) return baseMs;
  const previous = Number.isFinite(previousMs) && previousMs > 0 ? previousMs : baseMs;
  return Math.min(previous * 2, maxMs);
}

export class RailHealthProbeLoop {
  private stopped = true;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly rails: ProbeableRail[];

  constructor(rails: readonly ProbeableRail[], options: { intervalMs?: number; maxIntervalMs?: number } = {}) {
    this.rails = rails.filter((rail) => typeof rail.probe === 'function');
    this.baseMs = options.intervalMs ?? RAIL_PROBE_INTERVAL_MS;
    this.maxMs = options.maxIntervalMs ?? RAIL_PROBE_MAX_INTERVAL_MS;
  }

  /** Probes once immediately, then on a timer. The returned promise is that first pass. */
  start(): Promise<void> {
    this.stop();
    this.stopped = false;
    return Promise.all(this.rails.map((rail) => this.tick(rail, this.baseMs))).then(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async tick(rail: ProbeableRail, previousDelayMs: number): Promise<void> {
    if (this.stopped || !rail.probe) return;
    let ok = false;
    try {
      ok = (await rail.probe()).ok;
    } catch {
      ok = false;
    }
    if (this.stopped) return;
    const next = nextProbeDelayMs(previousDelayMs, ok, this.baseMs, this.maxMs);
    const timer = setTimeout(() => {
      void this.tick(rail, next);
    }, next);
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
    this.timers.set(rail.id, timer);
  }
}
