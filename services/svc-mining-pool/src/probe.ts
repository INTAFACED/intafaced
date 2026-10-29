import { connect as netConnect } from 'node:net';
import { readProbeTarget } from './connection.js';
import { MiningError } from './errors.js';
import { PROBE_LIMIT_MAX, PROBE_TIMEOUT_MAX_MS, PROBE_WINDOW_MAX_MS, publishedInt } from './env.js';

/** Count or window unpublished. A press is not attempted. */
export const PROBE_LIMIT_UNSET = 'mining.probe_limit_unset';

/** Wait bound unpublished. A press is not attempted, and no wait is invented. */
export const PROBE_TIMEOUT_UNSET = 'mining.probe_timeout_unset';

/** This account has used its published presses in the current window. */
export const PROBE_LIMIT_REACHED = 'mining.probe_limit_reached';

export type ProbeResultName = 'reachable' | 'refused' | 'timed_out';

export type ProbeView = {
  readonly result: ProbeResultName;
  readonly roundTripMs: string;
  readonly viewpoint: 'pool_network';
};

export type DialOutcome = { readonly kind: ProbeResultName; readonly roundTripMs: number };

export type Dial = (host: string, port: number, timeoutMs: number) => Promise<DialOutcome>;

/**
 * Presses already accepted in this process. The probe stores nothing, so the
 * window is not shared across processes and a restart clears it. Inside this
 * process the check is synchronous, before any dial, so two concurrent presses
 * cannot both pass a cap of one.
 */
export class ProbeRateLimit {
  private readonly hits = new Map<string, number[]>();

  allow(userId: string, nowMs: number, limit: number, windowMs: number): boolean {
    const fresh = (this.hits.get(userId) ?? []).filter((at) => nowMs - at < windowMs);
    if (fresh.length >= limit) {
      this.hits.set(userId, fresh);
      this.prune(nowMs, windowMs);
      return false;
    }
    fresh.push(nowMs);
    this.hits.set(userId, fresh);
    this.prune(nowMs, windowMs);
    return true;
  }

  private prune(nowMs: number, windowMs: number): void {
    if (this.hits.size <= 10_000) return;
    for (const [id, stamps] of this.hits) {
      const last = stamps[stamps.length - 1];
      if (last === undefined || nowMs - last >= windowMs) this.hits.delete(id);
    }
  }
}

export function readProbeBounds(env: NodeJS.ProcessEnv = process.env): { limit: number; windowMs: number; timeoutMs: number } {
  const limit = publishedInt(env.MINING_PROBE_LIMIT, 0, PROBE_LIMIT_MAX);
  const windowMs = publishedInt(env.MINING_PROBE_WINDOW_MS, 1, PROBE_WINDOW_MAX_MS);
  const timeoutMs = publishedInt(env.MINING_PROBE_TIMEOUT_MS, 1, PROBE_TIMEOUT_MAX_MS);
  if (limit === null || limit === 'invalid' || windowMs === null || windowMs === 'invalid') {
    throw new MiningError('Probe limit is not published', PROBE_LIMIT_UNSET);
  }
  if (timeoutMs === null || timeoutMs === 'invalid') {
    throw new MiningError('Probe timeout is not published', PROBE_TIMEOUT_UNSET);
  }
  return { limit, windowMs, timeoutMs };
}

function ms(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.trunc(n));
}

/** TCP connect to the owner's host and port. A failure is a result, never a thrown page. */
export function dialPool(host: string, port: number, timeoutMs: number): Promise<DialOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = netConnect({ host, port });
    const finish = (kind: ProbeResultName) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ kind, roundTripMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('reachable'));
    socket.once('timeout', () => finish('timed_out'));
    // Only the wait running out is a time-out. Any error before it (refused, reset, no route, no such host) is the
    // address not being reached, never a time-out the wait did not reach.
    socket.once('error', () => finish('refused'));
  });
}

/**
 * One reachability press for the signed account. Dials only the configured host
 * and port. Nothing is written. A blank limit or an exhausted window refuses
 * before the dial.
 */
export async function runProbe(args: {
  readonly env: NodeJS.ProcessEnv;
  readonly userId: string;
  readonly nowMs: number;
  readonly limiter: ProbeRateLimit;
  readonly dial: Dial;
}): Promise<ProbeView> {
  const target = readProbeTarget(args.env);
  const bounds = readProbeBounds(args.env);
  if (!args.limiter.allow(args.userId, args.nowMs, bounds.limit, bounds.windowMs)) {
    throw new MiningError('Probe limit reached', PROBE_LIMIT_REACHED);
  }
  const started = Date.now();
  let outcome: DialOutcome;
  try {
    outcome = await args.dial(target.host, target.port, bounds.timeoutMs);
  } catch {
    // A dial that fails outright did not reach the address; it is not a time-out.
    outcome = { kind: 'refused', roundTripMs: Date.now() - started };
  }
  return { result: outcome.kind, roundTripMs: ms(outcome.roundTripMs), viewpoint: 'pool_network' };
}
