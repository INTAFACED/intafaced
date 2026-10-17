/**
 * Market-maker seed job assembly (trade.mm-bot residual).
 *
 * Default OFF. Never invents mid, markets, or inventory.
 * Seeds only when book depth is empty (honest reseed guard).
 * Mid comes from injected midSource (env map / oracle) — null → skip.
 *
 * Cancel/reseed lifecycle (A-TRADE-MM-2):
 * - Tracks last seed run per market.
 * - On empty book: cancel prior run (engine cancel + release remaining holds),
 *   then seed with a NEW runId (hold keys are per-order and idempotent).
 * - Prior cancel indeterminate → skip reseed this tick (no free book risk).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { MatchingClient } from '../spot/matching-client.js';
import type { MarketLifecyclePort } from '../market-lifecycle.js';
import type { Market } from '../spot/types.js';
import { createJobHost, type JobHost } from '../futures/job-host.js';
import { acceptedMmMidPrice, type AcceptedMmMid } from './accepted-mid.js';
import { mmSeedJobsArmed } from './seed-honesty.js';
import {
  cancelSeedMarket,
  seedMarket,
  type CancelSeedResult,
  type SeededOrderRecord,
  type SeedMarketResult,
  type SeedTradableMarket,
} from './seed-market.js';

export type MmSeedLastRun = { runId: string; levels: number };

/** Load durable last-run map. Corrupt/missing → empty (never invent runs). */
export function loadMmSeedLastRun(path: string | undefined): Map<string, MmSeedLastRun> {
  const out = new Map<string, MmSeedLastRun>();
  if (path == null || path.trim() === '') return out;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { runId?: string; levels?: number }>;
    for (const [marketId, v] of Object.entries(parsed)) {
      if (!marketId || typeof v?.runId !== 'string' || !v.runId.trim()) continue;
      const levels = Number(v.levels);
      if (!Number.isFinite(levels) || levels < 1) continue;
      out.set(marketId, { runId: v.runId.trim(), levels: Math.floor(levels) });
    }
  } catch {
    /* missing or corrupt — start empty */
  }
  return out;
}

export function saveMmSeedLastRun(path: string | undefined, map: Map<string, MmSeedLastRun>): void {
  if (path == null || path.trim() === '') return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const obj: Record<string, MmSeedLastRun> = {};
    for (const [k, v] of map) obj[k] = v;
    writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort — in-memory still works this process */
  }
}

export interface MmSeedTarget {
  marketId: string;
  baseAsset: string;
  quoteAsset: string;
}

export interface MmSeedJobsConfig {
  /** Master kill — false = host created, no intervals. */
  enabled: boolean;
  /** Tick interval when enabled. Unset/invalid = refuse to schedule. */
  intervalMs?: number | null;
  /** Null/unset → jobs stay unscheduled (`trade.mm_seed_bps_unset`). Never invent 10. */
  halfSpreadBps: number | null;
  /** Null/unset → jobs stay unscheduled (`trade.mm_seed_bps_unset`). Never invent 10. */
  stepBps: number | null;
  levels: number;
  qtyPerLevel: string;
  /**
   * Explicit markets to seed. Empty = job not scheduled even when enabled
   * (never invent a market list).
   */
  targets: readonly MmSeedTarget[];
}

export interface MmSeedJobsDeps {
  ledger: Pick<LedgerClient, 'post' | 'balance'>;
  matching: Pick<MatchingClient, 'submit' | 'depth' | 'cancel'>;
  /**
   * Accepted configured/venue mid for a market. Null or unsealed → skip.
   */
  midSource: (marketId: string) => AcceptedMmMid | null | Promise<AcceptedMmMid | null>;
  /**
   * Catalog row for assertTradable (same gate as placeOrder). Null → skip
   * that market — never invent active/spot to bypass the gate (handoff §7).
   */
  marketFor: (marketId: string) => (SeedTradableMarket | Market) | null | Promise<(SeedTradableMarket | Market) | null>;
  marketLifecycle?: MarketLifecyclePort;
  now?: () => Date;
  /**
   * Mirrors TRADE_FUTURES_ENABLED. Passed through to seedMarket / assertTradable.
   * Default false when omitted.
   */
  futuresEnabled?: boolean;
  config: MmSeedJobsConfig;
  /**
   * Run id per seed cycle. Must be unique per cycle so holds re-draw after
   * cancel (default: ops-seed:{marketId}:{generation}).
   */
  runIdFor?: (marketId: string) => string;
  onError?: (name: string, err: unknown) => void;
  /** Optional observer for tests / ops logs. */
  onResult?: (marketId: string, result: SeedMarketResult | { skipped: string }) => void;
  /** Optional observer for prior-run cancel before reseed. */
  onCancelResult?: (marketId: string, result: CancelSeedResult) => void;
  /**
   * Durable last-run map path (TRADE_MM_SEED_STATE_PATH). Empty/undefined →
   * memory only (pre-persist behavior).
   */
  statePath?: string;
  /** SD-2 recorder — persist resting seed orders as seeded (optional). */
  recordSeededOrder?: (row: SeededOrderRecord) => Promise<void>;
  /**
   * Operator seed switch. Absent: the env arm is the only gate (previous behaviour).
   * Present and false: this market stays unseeded. Default in the table is off.
   */
  operatorSeedAllows?: (marketId: string) => Promise<boolean>;
}

export interface MmSeedJobsHandle {
  host: JobHost;
  stop(): void;
}

/**
 * Assemble MM seed jobs. Disabled or empty targets → stopped host.
 */
export function startMmSeedJobs(deps: MmSeedJobsDeps): MmSeedJobsHandle {
  const host = createJobHost({ onError: deps.onError });

  // SD-4/H2: disabled, unnamed targets, unset/invalid interval, or unset seed
  // bps → stopped host. Never invent 10 half-spread/step.
  const namedTargets =
    deps.config.targets.length > 0 &&
    deps.config.targets.every(
      (target) => target.marketId.trim() !== '' && target.baseAsset.trim() !== '' && target.quoteAsset.trim() !== '',
    );
  const seedBpsNamed =
    deps.config.halfSpreadBps != null &&
    Number.isInteger(deps.config.halfSpreadBps) &&
    deps.config.stepBps != null &&
    Number.isInteger(deps.config.stepBps);
  if (
    !mmSeedJobsArmed(deps.config.enabled, deps.config.targets.length) ||
    !namedTargets ||
    deps.config.intervalMs == null ||
    !Number.isFinite(deps.config.intervalMs) ||
    deps.config.intervalMs <= 0 ||
    !seedBpsNamed
  ) {
    return { host, stop: () => host.stopAll() };
  }

  /** Prior seed run per market — cancelled before reseed when book empty. */
  const lastRun = loadMmSeedLastRun(deps.statePath);
  let generation = 0;
  const runIdFor =
    deps.runIdFor ??
    ((marketId: string) => {
      generation += 1;
      return `ops-seed:${marketId}:${generation}`;
    });
  const persist = () => saveMmSeedLastRun(deps.statePath, lastRun);

  host.every('mm.seed', deps.config.intervalMs, async () => {
    for (const target of deps.config.targets) {
      if (!target.marketId.trim() || !target.baseAsset.trim() || !target.quoteAsset.trim()) {
        deps.onResult?.(target.marketId, { skipped: 'invalid_target' });
        continue;
      }
      if (deps.operatorSeedAllows && !(await deps.operatorSeedAllows(target.marketId))) {
        deps.onResult?.(target.marketId, { skipped: 'operator_seed_off' });
        continue;
      }

      // Only seed empty books — avoids re-submit/release race on live seed orders.
      const depth = await deps.matching.depth(target.marketId, 1);
      if (depth.bids.length > 0 || depth.asks.length > 0) {
        deps.onResult?.(target.marketId, { skipped: 'book_not_empty' });
        continue;
      }

      const mid = acceptedMmMidPrice(await deps.midSource(target.marketId));
      if (mid == null) {
        deps.onResult?.(target.marketId, { skipped: 'missing_mid' });
        continue;
      }

      // Catalog row required for assertTradable — no invent-active fallback.
      const market = await deps.marketFor(target.marketId);
      if (market == null) {
        deps.onResult?.(target.marketId, { skipped: 'market_unknown' });
        continue;
      }

      // Cancel prior seed: engine may already be empty (fills/cancels);
      // still release any leftover MM holds before a new runId draws again.
      // Includes runs restored from TRADE_MM_SEED_STATE_PATH after restart.
      const prior = lastRun.get(target.marketId);
      if (prior) {
        const cancelResult = await cancelSeedMarket(
          {
            marketId: target.marketId,
            baseAsset: target.baseAsset,
            quoteAsset: target.quoteAsset,
            levels: prior.levels,
            runId: prior.runId,
          },
          { ledger: deps.ledger, matching: deps.matching },
        );
        deps.onCancelResult?.(target.marketId, cancelResult);
        if (!cancelResult.ok) {
          deps.onResult?.(target.marketId, { skipped: `prior_${cancelResult.reason}` });
          continue;
        }
        lastRun.delete(target.marketId);
        persist();
      }

      const runId = runIdFor(target.marketId);
      const result = await seedMarket(
        {
          marketId: target.marketId,
          baseAsset: target.baseAsset,
          quoteAsset: target.quoteAsset,
          midPrice: mid,
          halfSpreadBps: deps.config.halfSpreadBps,
          stepBps: deps.config.stepBps,
          levels: deps.config.levels,
          qtyPerLevel: deps.config.qtyPerLevel,
          runId,
        },
        {
          ledger: deps.ledger,
          matching: deps.matching,
          market,
          ...(deps.marketLifecycle && isFullMarket(market) ? { marketLifecycle: deps.marketLifecycle, lifecycleMarket: market } : {}),
          now: deps.now,
          futuresEnabled: deps.futuresEnabled,
          recordSeededOrder: deps.recordSeededOrder,
        },
      );

      // Track runs that may leave live orders or stranded holds for cancel path.
      const trackable = result.placements.some(
        (p) =>
          p.status === 'resting' || p.status === 'submit_indeterminate' || p.status === 'rejected' || p.status === 'manufactured_cross',
      );
      if (trackable) {
        lastRun.set(target.marketId, { runId, levels: deps.config.levels });
        persist();
      }

      deps.onResult?.(target.marketId, result);
    }
  });

  return { host, stop: () => host.stopAll() };
}

function isFullMarket(market: SeedTradableMarket | Market): market is Market {
  return 'id' in market && 'tickSize' in market && 'schedule' in market && 'paper' in market;
}

/**
 * Parse `marketId:base:quote,...` — empty → []. Invalid segments skipped.
 * Never invents markets from thin air.
 */
export function parseMmSeedTargets(raw: string | undefined): MmSeedTarget[] {
  if (raw == null || raw.trim() === '') return [];
  const out: MmSeedTarget[] = [];
  for (const part of raw.split(',')) {
    const bits = part
      .trim()
      .split(':')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (bits.length !== 3) continue;
    const [marketId, baseAsset, quoteAsset] = bits as [string, string, string];
    out.push({ marketId, baseAsset, quoteAsset });
  }
  return out;
}

/**
 * Parse `marketId:mid,...` external mid map. Empty mid values omitted.
 */
export function parseMmSeedMids(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (raw == null || raw.trim() === '') return map;
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const marketId = part.slice(0, idx).trim();
    const mid = part.slice(idx + 1).trim();
    if (!marketId || !mid) continue;
    map.set(marketId, mid);
  }
  return map;
}
