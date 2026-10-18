/**
 * TWAP slice scheduler (D-S-04 / trade.algo).
 *
 * Default OFF. This is the thing that was missing: `tickAllAlgos()` existed,
 * was correct, and had **zero callers**, so a user could create a TWAP, watch
 * it persist to Postgres, and never receive a single child order. The schedule
 * sat `active` forever.
 *
 * It invents nothing. Every slice still goes through `TwapEngine.tick`, which
 * gates on the mark, probes real book liquidity, and places children through
 * the ordinary `placeOrder` path with the ordinary holds and risk gates. This
 * file only decides WHEN to ask.
 *
 * Mount is legal only with ADR 2026-08-08 (interval is the promise / re-space
 * overdue) and the cancel honesty fixes in the same change — otherwise a tick
 * outage or resume turns a TWAP into a market-order burst, and a restart cancel
 * can flip the parent cancelled while children stay live.
 *
 * ── Why the interval is capped, not just defaulted ──────────────────────────
 *
 * `tickAll` emits at most ONE slice per parent per tick. So if this interval is
 * longer than a parent's `sliceIntervalMs`, the schedule silently STRETCHES and
 * never catches up — a 30-minute TWAP quietly becoming a 3-hour one, with no
 * miss recorded because nothing was missed. The engine's floor for
 * `sliceIntervalMs` is 1s, so this interval must be ≤ 1s to keep any legal
 * schedule on time. That is enforced in `env.ts` rather than trusted here.
 *
 * ── What this does NOT solve ───────────────────────────────────────────────
 *
 * `job-host` has no leader election, so every replica that boots with the flag
 * on runs every job. Child placement survives that — `clientOrderId` is
 * `algo:{parentId}:{sliceIndex}`, which derives a deterministic order id, so a
 * duplicate tick finds the original order rather than placing a second one.
 * The parent's `misses[]` array is last-write-wins across replicas, so a miss
 * record can be lost, which is an honesty regression rather than a money one.
 * Run one instance, or add an advisory lock, before running more.
 */
import { createJobHost, type JobHost } from '../futures/job-host.js';

export interface AlgoJobsConfig {
  /** Master kill — false = host created, no intervals. */
  enabled: boolean;
  /** Tick cadence. Must be ≤ the engine's minimum slice interval (see header). */
  intervalMs: number;
}

export interface AlgoJobsDeps {
  /** Usually the TradeService. Narrow on purpose — this job drives, it does not decide. */
  trade: { tickAllAlgos(): Promise<unknown> };
  config: AlgoJobsConfig;
  /** Durable "the loop ticked" write. Omitted in unit tests that only count ticks. */
  recordHeartbeat?: () => Promise<void>;
  onError?: (name: string, err: unknown) => void;
}

export interface AlgoJobsHandle {
  host: JobHost;
  stop(): void;
}

/** Assemble the TWAP scheduler. Disabled → stopped host, no intervals. */
export function startAlgoJobs(deps: AlgoJobsDeps): AlgoJobsHandle {
  const host = createJobHost({ onError: deps.onError });

  if (!deps.config.enabled) {
    return { host, stop: () => host.stopAll() };
  }

  // No market allowlist, unlike the funding and candle jobs. Those iterate a
  // list the operator supplies, so an empty list is the honest default. This
  // drives schedules a USER created and the store already holds — an allowlist
  // here would silently strand the orders of anyone trading a market the
  // operator forgot to name.
  host.every('algo.twap', deps.config.intervalMs, async () => {
    // Beat before and after: a slow tick must not read as a dead loop.
    await deps.recordHeartbeat?.();
    await deps.trade.tickAllAlgos();
    await deps.recordHeartbeat?.();
  });

  return { host, stop: () => host.stopAll() };
}
