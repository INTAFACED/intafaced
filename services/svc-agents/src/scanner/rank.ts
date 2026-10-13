/**
 * Market Scanner Stage-1 — rank on fixtures only.
 *
 * Spec: docs/ops/trk/agents.scanner.md Stage 1.
 * Honesty: D26-P1-A3 / D26-P0-11 — ranked signals only after signal-inputs
 * law is sealed; else refuse (never invent ranking / market alpha).
 *
 * Rules:
 *   · P0-11 signal-inputs law must be sealed before any score is computed.
 *   · Input is caller-supplied fixture rows — never invented mid-function.
 *   · Missing/null quotes are refused, not filled with 0 or "placeholder" prices.
 *   · Stale rows (asOf older than maxAgeMs vs `now`) are dropped; if nothing
 *     remains, status is unavailable, not an empty green list.
 *   · Score is a relative rank key (string decimal), not a balance or quote.
 *   · last / volume24h are money strings: parse via ledger-client, never JS Number.
 *   · No model call, no ledger post, no auto-trade.
 */

import { parseAmount, SCALE, type Amount } from '@intafaced/ledger-client';
import {
  SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL,
  resolveScannerSignalInputsLaw,
  scannerSignalInputsGate,
  type ScannerSignalInputsGateRefuseReason,
  type ScannerSignalInputsLaw,
} from './signal-inputs-law.js';

export type MarketFixture = {
  readonly marketId: string;
  /** Last trade / mid as decimal string. null = no quote. */
  readonly last: string | null;
  /** 24h volume as decimal string. null = unknown. */
  readonly volume24h: string | null;
  /** 24h change in basis points. null = unknown. */
  readonly change24hBps: number | null;
  /** Observation time (ISO-8601). */
  readonly asOf: string;
  /** Max age of this row in ms for the rank call. */
  readonly maxAgeMs: number;
};

export type RankedSignal = {
  readonly marketId: string;
  /** Relative score as decimal string (higher = stronger absolute move × volume weight). */
  readonly score: string;
  readonly reasons: readonly string[];
};

export type RankOk = {
  readonly status: 'ok';
  readonly signals: readonly RankedSignal[];
  readonly rankedAt: string;
  readonly considered: number;
  readonly skippedStale: number;
  readonly skippedIncomplete: number;
};

export type RankEmpty = {
  readonly status: 'empty';
  readonly userMessageKey: 'agents.scanner.empty';
};

export type RankUnavailable = {
  readonly status: 'unavailable';
  readonly userMessageKey: 'agents.scanner.unavailable';
  readonly reason: 'stale' | 'no_quotes' | 'market_plane_dark';
};

/** D26-P1-A3 — P0-11 not sealed (or sealed incompletely). No ranked signals. */
export type RankRefuse = {
  readonly status: 'refuse';
  readonly reason: ScannerSignalInputsGateRefuseReason | 'rank_limit_unset';
  readonly userMessageKey: 'agents.scanner.tier_closed' | 'agents.scanner.signal_inputs_closed' | 'agents.scanner.rank_limit_unset';
  /** Present on P0-11 refuses. Absent when the rank page size is unpublished. */
  readonly residual?: typeof SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL;
};

export type RankResult = RankOk | RankEmpty | RankUnavailable | RankRefuse;

/** Stage-2: live market data plane. Dark → refuse invent signals. */
export type MarketPlaneState = 'live' | 'dark';

/** Signed decimal money; null if unusable (refuse invent). */
function parseSignedAmount(s: string): Amount | null {
  try {
    return parseAmount(s);
  } catch {
    return null;
  }
}

/**
 * ln of a positive bigint from its 53-bit mantissa. Unitless — never a book.
 * Number is applied only to that mantissa, never to a money decimal string.
 */
function lnPositiveBigint(n: bigint): number | null {
  if (n <= 0n) return null;
  const bits = n.toString(2).length;
  const shift = Math.max(0, bits - 53);
  const mantissa = Number(n >> BigInt(shift));
  if (!Number.isFinite(mantissa) || mantissa <= 0) return null;
  return Math.log(mantissa) + shift * Math.LN2;
}

/**
 * Sealed recipe `abs_change_x_log_volume`: ln(1 + volume) as a unitless rank key.
 * Volume stays scaled bigint. Never round a formatted money string through JS Number.
 */
function log1pVolumeWeight(vol: Amount): number | null {
  if (vol < 0n) return null;
  const lnNumer = lnPositiveBigint(SCALE + vol);
  const lnScale = lnPositiveBigint(SCALE);
  if (lnNumer == null || lnScale == null) return null;
  const weight = lnNumer - lnScale;
  return Number.isFinite(weight) ? weight : null;
}

function isFresh(asOf: string, maxAgeMs: number, nowMs: number): boolean {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxAgeMs && nowMs - t >= 0;
}

/** Owner-published rank page size. Blank / non-integer / <1 refuses. Never invent 20. */
function resolveRankPageLimit(limit: number | undefined): number | null {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return null;
  return limit;
}

/**
 * Stage-2 L3: optional allowlist of market ids the scanner may consider.
 * Empty/missing allowlist → all fixtures (caller already scoped).
 * Non-empty → only listed markets; others count as incomplete (not invent ghost ranks).
 */
export function filterFixturesByAllowlist(
  fixtures: readonly MarketFixture[],
  allowlist: ReadonlySet<string> | readonly string[] | undefined,
): { readonly kept: readonly MarketFixture[]; readonly skippedNotAllowed: number } {
  if (!allowlist) return { kept: fixtures, skippedNotAllowed: 0 };
  const set = allowlist instanceof Set ? allowlist : new Set(allowlist);
  if (set.size === 0) return { kept: fixtures, skippedNotAllowed: 0 };
  const kept: MarketFixture[] = [];
  let skippedNotAllowed = 0;
  for (const row of fixtures) {
    if (set.has(row.marketId)) kept.push(row);
    else skippedNotAllowed += 1;
  }
  return { kept, skippedNotAllowed };
}

/**
 * Rank fixture markets by |changeBps| × log1p(volume) when both present and fresh.
 * Incomplete rows are skipped; never zero-filled.
 *
 * Requires sealed D26-P0-11 signal-inputs law (recipe `abs_change_x_log_volume`).
 * Blank / unpublished law → typed refuse — never invent rankings.
 * Blank rank page size → typed refuse (`rank_limit_unset`) — never invent 20.
 */
export function rankFixtures(
  fixtures: readonly MarketFixture[],
  options: {
    now?: Date;
    /**
     * Rank page size. Omitted / blank / non-integer / <1 → refuse-closed
     * (`rank_limit_unset`). Never sneak a 20-row board. Owner may pass 20.
     */
    limit?: number;
    marketPlane?: MarketPlaneState;
    /** Stage-2: only rank these market ids when provided and non-empty. */
    marketAllowlist?: ReadonlySet<string> | readonly string[];
    /**
     * D26-P0-11 signal-inputs law. Omitted / null / unpublished → refuse-closed
     * (`signal_inputs_law_blank`). Never sneak a default ranked board.
     */
    signalInputsLaw?: ScannerSignalInputsLaw | null;
  } = {},
): RankResult {
  const inputsGate = scannerSignalInputsGate(resolveScannerSignalInputsLaw(options.signalInputsLaw));
  if (inputsGate.status === 'refuse') {
    return {
      status: 'refuse',
      reason: inputsGate.reason,
      userMessageKey: inputsGate.userMessageKey,
      residual: inputsGate.residual,
    };
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const limit = resolveRankPageLimit(options.limit);
  if (limit == null) {
    return {
      status: 'refuse',
      reason: 'rank_limit_unset',
      userMessageKey: 'agents.scanner.rank_limit_unset',
    };
  }
  if (options.marketPlane === 'dark') {
    return { status: 'unavailable', userMessageKey: 'agents.scanner.unavailable', reason: 'market_plane_dark' };
  }

  const { kept: scoped, skippedNotAllowed } = filterFixturesByAllowlist(fixtures, options.marketAllowlist);

  if (scoped.length === 0) {
    return { status: 'empty', userMessageKey: 'agents.scanner.empty' };
  }

  let skippedStale = 0;
  let skippedIncomplete = skippedNotAllowed;
  const candidates: { marketId: string; score: number; vol: Amount; reasons: string[] }[] = [];

  for (const row of scoped) {
    if (!row.marketId) {
      skippedIncomplete += 1;
      continue;
    }
    if (!isFresh(row.asOf, row.maxAgeMs, nowMs)) {
      skippedStale += 1;
      continue;
    }
    if (row.last == null || row.volume24h == null || row.change24hBps == null) {
      skippedIncomplete += 1;
      continue;
    }
    const last = parseSignedAmount(row.last);
    const vol = parseSignedAmount(row.volume24h);
    const volWeight = vol == null ? null : log1pVolumeWeight(vol);
    // Negative last is incomplete, same as a negative volume (volWeight null). Zero last still ranks.
    if (last == null || last < 0n || vol == null || volWeight == null) {
      skippedIncomplete += 1;
      continue;
    }

    const absBps = Math.abs(row.change24hBps);
    // log1p volume dampens huge books without inventing a "price".
    const score = absBps * volWeight;
    const reasons: string[] = [];
    if (absBps > 0) {
      reasons.push(row.change24hBps >= 0 ? 'change_up' : 'change_down');
    } else {
      reasons.push('change_flat');
    }
    if (vol > 0n) reasons.push('has_volume');
    candidates.push({ marketId: row.marketId, score, vol, reasons });
  }

  if (candidates.length === 0) {
    if (skippedStale > 0 && skippedIncomplete === 0) {
      return { status: 'unavailable', userMessageKey: 'agents.scanner.unavailable', reason: 'stale' };
    }
    if (skippedIncomplete > 0 || skippedStale > 0) {
      return { status: 'unavailable', userMessageKey: 'agents.scanner.unavailable', reason: 'no_quotes' };
    }
    return { status: 'empty', userMessageKey: 'agents.scanner.empty' };
  }

  candidates.sort((a, b) => b.score - a.score || (b.vol > a.vol ? 1 : b.vol < a.vol ? -1 : 0) || a.marketId.localeCompare(b.marketId));
  const top = candidates.slice(0, limit);

  return {
    status: 'ok',
    rankedAt: now.toISOString(),
    considered: scoped.length + skippedNotAllowed,
    skippedStale,
    skippedIncomplete,
    signals: top.map((c) => ({
      marketId: c.marketId,
      // Fixed precision string — relative rank key, not money.
      score: c.score.toFixed(6),
      reasons: c.reasons,
    })),
  };
}
