/**
 * Copy-Intel Stage-1 — audited leader stats from fixtures only.
 *
 * Spec: docs/ops/trk/agents.copy-intel.md Stage 1.
 * D26-P1-A5: writes audited leader stats; NO returns-ranked marketing board
 * (see `returns-board-refuse.ts` — mirrors trade.copy ranking ban).
 *
 * Rules:
 *   · Stats are computed from caller-supplied leader performance rows.
 *   · Never invents PnL, win rate, or follower counts.
 *   · Output order is **input / fixture order** — never sorted by PnL or win rate.
 *   · Writes produce an audit record shape (in-memory Stage-1) with provenance.
 *   · No trade placement, no ledger, no profit-share — trade.copy product law residual.
 *   · Explicit `copyPlane: 'live'` stays unavailable until the sealed live
 *     leaders allowlist exists (`live-leader-plane-refuse.ts` — Class X).
 *   · realisedPnl is money: parse via ledger-client, never JS Number.
 */

import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { isLiveLeaderPlaneAllowlisted } from './live-leader-plane-refuse.js';

export type LeaderPerformanceFixture = {
  readonly leaderId: string;
  /** Realised PnL as decimal string (can be negative). null = unknown. */
  readonly realisedPnl: string | null;
  /** Closed trades in window. null = unknown. */
  readonly closedTrades: number | null;
  /** Winning closed trades. null = unknown. */
  readonly winningTrades: number | null;
  /** Window start ISO. */
  readonly windowStart: string;
  /** Window end ISO. */
  readonly windowEnd: string;
  /** Source system id for provenance (platform-owned name, not a vendor). */
  readonly source: string;
};

export type LeaderStat = {
  readonly leaderId: string;
  readonly realisedPnl: string;
  readonly closedTrades: number;
  readonly winRate: string;
  readonly windowStart: string;
  readonly windowEnd: string;
};

export type AuditWrite = {
  readonly id: string;
  readonly writtenAt: string;
  readonly source: string;
  readonly leaderId: string;
  readonly stat: LeaderStat;
  readonly provenance: {
    readonly fixture: true;
    readonly source: string;
    readonly windowStart: string;
    readonly windowEnd: string;
  };
};

export type IntelOk = {
  readonly status: 'ok';
  readonly stats: readonly LeaderStat[];
  readonly audit: readonly AuditWrite[];
  readonly skippedIncomplete: number;
};

export type IntelEmpty = {
  readonly status: 'empty';
  readonly userMessageKey: 'agents.copy_intel.empty';
};

export type IntelUnavailable = {
  readonly status: 'unavailable';
  readonly userMessageKey: 'agents.copy_intel.unavailable';
  readonly reason: 'no_data' | 'invalid_window' | 'copy_plane_dark';
};

export type IntelResult = IntelOk | IntelEmpty | IntelUnavailable;

/** Stage-2: trade.copy product plane. Dark → refuse invent PnL. */
export type CopyPlaneState = 'live' | 'dark';

/** Signed decimal money; null if unusable (refuse invent). */
function parseSignedAmount(s: string): Amount | null {
  try {
    return parseAmount(s);
  } catch {
    return null;
  }
}

function winRate(closed: number, winning: number): string | null {
  // A negative closed count is incomplete. Do not invent 0.0000 and skip the range check.
  if (closed < 0 || winning < 0 || winning > closed) return null;
  if (closed === 0) return '0.0000';
  return (winning / closed).toFixed(4);
}

/**
 * Stage-2 L3: optional allowlist of leader ids.
 * Empty/missing allowlist → all fixtures. Non-empty → only listed leaders.
 */
export function filterLeadersByAllowlist(
  fixtures: readonly LeaderPerformanceFixture[],
  allowlist: ReadonlySet<string> | readonly string[] | undefined,
): { readonly kept: readonly LeaderPerformanceFixture[]; readonly skippedNotAllowed: number } {
  if (!allowlist) return { kept: fixtures, skippedNotAllowed: 0 };
  const set = allowlist instanceof Set ? allowlist : new Set(allowlist);
  if (set.size === 0) return { kept: fixtures, skippedNotAllowed: 0 };
  const kept: LeaderPerformanceFixture[] = [];
  let skippedNotAllowed = 0;
  for (const row of fixtures) {
    if (set.has(row.leaderId)) kept.push(row);
    else skippedNotAllowed += 1;
  }
  return { kept, skippedNotAllowed };
}

/**
 * Build audited leader stats from fixtures. Incomplete rows are skipped;
 * empty input → empty; all incomplete → unavailable (never invent green leaders).
 * Stats are appended in fixture order — never ranked by returns (D26-P1-A5).
 */
export function buildLeaderStats(
  fixtures: readonly LeaderPerformanceFixture[],
  options: {
    now?: Date;
    idPrefix?: string;
    copyPlane?: CopyPlaneState;
    /** Stage-2 L3: only include these leader ids when provided and non-empty. */
    leaderAllowlist?: ReadonlySet<string> | readonly string[];
  } = {},
): IntelResult {
  const now = options.now ?? new Date();
  const idPrefix = options.idPrefix ?? 'ci';
  if (options.copyPlane === 'dark') {
    return { status: 'unavailable', userMessageKey: 'agents.copy_intel.unavailable', reason: 'copy_plane_dark' };
  }
  // Live plane without a sealed allowlist is still dark — never invent leaders.
  // Reason stays `copy_plane_dark` so the public door schema does not grow.
  if (options.copyPlane === 'live' && !isLiveLeaderPlaneAllowlisted(options.leaderAllowlist)) {
    return { status: 'unavailable', userMessageKey: 'agents.copy_intel.unavailable', reason: 'copy_plane_dark' };
  }

  const { kept: scoped, skippedNotAllowed } = filterLeadersByAllowlist(fixtures, options.leaderAllowlist);

  if (scoped.length === 0) {
    return { status: 'empty', userMessageKey: 'agents.copy_intel.empty' };
  }

  let skippedIncomplete = skippedNotAllowed;
  const stats: LeaderStat[] = [];
  const audit: AuditWrite[] = [];
  let seq = 0;

  for (const row of scoped) {
    if (!row.leaderId || !row.source) {
      skippedIncomplete += 1;
      continue;
    }
    const ws = Date.parse(row.windowStart);
    const we = Date.parse(row.windowEnd);
    if (!Number.isFinite(ws) || !Number.isFinite(we) || we < ws) {
      return { status: 'unavailable', userMessageKey: 'agents.copy_intel.unavailable', reason: 'invalid_window' };
    }
    if (row.realisedPnl == null || row.closedTrades == null || row.winningTrades == null) {
      skippedIncomplete += 1;
      continue;
    }
    if (!Number.isInteger(row.closedTrades) || !Number.isInteger(row.winningTrades)) {
      skippedIncomplete += 1;
      continue;
    }
    const pnl = parseSignedAmount(row.realisedPnl);
    if (pnl == null) {
      skippedIncomplete += 1;
      continue;
    }
    const wr = winRate(row.closedTrades, row.winningTrades);
    if (wr == null) {
      skippedIncomplete += 1;
      continue;
    }

    const stat: LeaderStat = {
      leaderId: row.leaderId,
      realisedPnl: row.realisedPnl,
      closedTrades: row.closedTrades,
      winRate: wr,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
    };
    stats.push(stat);
    seq += 1;
    audit.push({
      id: `${idPrefix}-${seq}`,
      writtenAt: now.toISOString(),
      source: row.source,
      leaderId: row.leaderId,
      stat,
      provenance: {
        fixture: true,
        source: row.source,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
      },
    });
  }

  if (stats.length === 0) {
    return { status: 'unavailable', userMessageKey: 'agents.copy_intel.unavailable', reason: 'no_data' };
  }

  return { status: 'ok', stats, audit, skippedIncomplete };
}

/** L3 — true when intel ok. */
export function isIntelOk(result: IntelResult): result is IntelOk {
  return result.status === 'ok';
}

/** L3 — leader count (ok only; else 0 — no invent). */
export function intelLeaderCount(result: IntelResult): number {
  return result.status === 'ok' ? result.stats.length : 0;
}

/** L3 — skipped incomplete count (ok only). */
export function intelSkippedCount(result: IntelResult): number {
  return result.status === 'ok' ? result.skippedIncomplete : 0;
}

/** L3 — board card. */
export function intelBoardCard(result: IntelResult): {
  readonly status: IntelResult['status'];
  readonly leaders: number;
  readonly skipped: number;
  readonly reason: string | null;
} {
  if (result.status === 'ok') {
    return { status: 'ok', leaders: result.stats.length, skipped: result.skippedIncomplete, reason: null };
  }
  if (result.status === 'empty') {
    return { status: 'empty', leaders: 0, skipped: 0, reason: null };
  }
  return { status: 'unavailable', leaders: 0, skipped: 0, reason: result.reason };
}

/** L3 — status line. */
export function intelStatusLine(result: IntelResult): string {
  const c = intelBoardCard(result);
  return `status=${c.status} leaders=${c.leaders} skipped=${c.skipped} reason=${c.reason ?? '-'}`;
}

/** L3 — parse status. Invalid → null. */
export function parseIntelStatusLine(
  line: string,
): { readonly status: string; readonly leaders: number; readonly skipped: number; readonly reason: string | null } | null {
  const m = line.trim().match(/^status=(\S+) leaders=(\d+) skipped=(\d+) reason=(\S+)$/);
  if (!m) return null;
  return { status: m[1]!, leaders: Number(m[2]), skipped: Number(m[3]), reason: m[4] === '-' ? null : m[4]! };
}

/** L3 — true when status matches. */
export function intelStatusLineMatches(result: IntelResult): boolean {
  const p = parseIntelStatusLine(intelStatusLine(result));
  if (!p) return false;
  const c = intelBoardCard(result);
  return p.status === c.status && p.leaders === c.leaders && p.skipped === c.skipped && p.reason === c.reason;
}

/** L3 — export header. */
export function intelExportHeader(): string {
  return 'status,leaders,skipped,reason';
}

/** L3 — export line. */
export function intelExportLine(result: IntelResult): string {
  const c = intelBoardCard(result);
  return `${c.status},${c.leaders},${c.skipped},${c.reason ?? ''}`;
}

/** L3 — full export. */
export function intelExportText(result: IntelResult): string {
  return [intelExportHeader(), intelExportLine(result)].join('\n');
}

/** L3 — leader export header. */
export function leaderStatExportHeader(): string {
  return 'leaderId,closedTrades,winRate,realisedPnl';
}

/** L3 — leader export lines from ok result. Empty/unavailable → []. */
export function leaderStatExportLines(result: IntelResult): readonly string[] {
  if (result.status !== 'ok') return [];
  return result.stats.map((s) => `${s.leaderId},${s.closedTrades},${s.winRate},${s.realisedPnl}`);
}

/** L3 — true when leader count is within [min,max]. Invalid → false. */
export function intelLeaderCountInRange(result: IntelResult, min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = intelLeaderCount(result);
  return n >= min && n <= max;
}

/** L3 — true when status is empty. */
export function isIntelEmpty(result: IntelResult): result is IntelEmpty {
  return result.status === 'empty';
}
