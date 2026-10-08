import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildLeaderStats,
  type LeaderPerformanceFixture,
  isIntelOk,
  isIntelEmpty,
  intelLeaderCount,
  intelSkippedCount,
  intelBoardCard,
  intelStatusLine,
  parseIntelStatusLine,
  intelStatusLineMatches,
  intelExportHeader,
  intelExportLine,
  intelExportText,
  leaderStatExportHeader,
  leaderStatExportLines,
  intelLeaderCountInRange,
} from './stats.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

function row(partial: Partial<LeaderPerformanceFixture> & Pick<LeaderPerformanceFixture, 'leaderId'>): LeaderPerformanceFixture {
  return {
    realisedPnl: '12.5',
    closedTrades: 10,
    winningTrades: 6,
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-05T00:00:00.000Z',
    source: 'trade.copy.fixture',
    ...partial,
  };
}

describe('copy-intel buildLeaderStats (Stage-1 fixtures)', () => {
  it('returns empty when no fixtures — no invented leaders', () => {
    expect(buildLeaderStats([], { now: NOW })).toEqual({
      status: 'empty',
      userMessageKey: 'agents.copy_intel.empty',
    });
  });

  it('builds stats + audit provenance from complete fixtures', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1' }), row({ leaderId: 'L2', winningTrades: 10, realisedPnl: '-3' })], {
      now: NOW,
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.stats).toHaveLength(2);
    expect(r.stats[0]!.winRate).toBe('0.6000');
    expect(r.audit[0]!.provenance.fixture).toBe(true);
    expect(r.audit[0]!.source).toBe('trade.copy.fixture');
  });

  it('D26-P1-A5: never reorders by realised PnL (no marketing board)', () => {
    const r = buildLeaderStats([row({ leaderId: 'weak', realisedPnl: '-10' }), row({ leaderId: 'strong', realisedPnl: '1000' })], {
      now: NOW,
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.stats.map((s) => s.leaderId)).toEqual(['weak', 'strong']);
  });

  it('refuses invent path when all rows incomplete', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1', realisedPnl: null, closedTrades: null, winningTrades: null })], {
      now: NOW,
    });
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.copy_intel.unavailable',
      reason: 'no_data',
    });
  });

  it('refuses invalid windows', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1', windowStart: '2026-08-05T00:00:00.000Z', windowEnd: '2026-08-01T00:00:00.000Z' })], {
      now: NOW,
    });
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.copy_intel.unavailable',
      reason: 'invalid_window',
    });
  });

  it('does not invent win rate when winning > closed', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1', closedTrades: 5, winningTrades: 9 })], { now: NOW });
    expect(r.status).toBe('unavailable');
  });

  it('does not invent win rate when winning is below 0 on a positive closed count', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1', closedTrades: 5, winningTrades: -1 })], { now: NOW });
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.copy_intel.unavailable',
      reason: 'no_data',
    });
  });

  it('treats a negative closed count as incomplete and does not publish 0.0000', () => {
    const alone = buildLeaderStats(
      [row({ leaderId: 'L1', closedTrades: -1, winningTrades: 0, realisedPnl: '12.5' })],
      { now: NOW },
    );
    expect(alone).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.copy_intel.unavailable',
      reason: 'no_data',
    });

    const mixed = buildLeaderStats(
      [
        row({ leaderId: 'neg', closedTrades: -4, winningTrades: -1, realisedPnl: '99' }),
        row({ leaderId: 'ok', closedTrades: 10, winningTrades: 6, realisedPnl: '12.5' }),
      ],
      { now: NOW },
    );
    expect(mixed.status).toBe('ok');
    if (mixed.status !== 'ok') return;
    expect(mixed.stats).toEqual([
      {
        leaderId: 'ok',
        realisedPnl: '12.5',
        closedTrades: 10,
        winRate: '0.6000',
        windowStart: '2026-08-01T00:00:00.000Z',
        windowEnd: '2026-08-05T00:00:00.000Z',
      },
    ]);
    expect(mixed.skippedIncomplete).toBe(1);
    expect(mixed.audit).toHaveLength(1);
    expect(mixed.audit[0]!.leaderId).toBe('ok');
  });

  it('Stage-2: copy plane dark → refuse invent PnL', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1' })], { now: NOW, copyPlane: 'dark' });
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.copy_intel.unavailable',
      reason: 'copy_plane_dark',
    });
  });

  it('Stage-2: copy plane live without sealed allowlist → still dark (no invent leaders)', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1' })], { now: NOW, copyPlane: 'live', leaderAllowlist: ['L1'] });
    expect(r).toEqual({
      status: 'unavailable',
      userMessageKey: 'agents.copy_intel.unavailable',
      reason: 'copy_plane_dark',
    });
  });

  it('Stage-2 L3: leader allowlist drops out-of-scope — no invent leaders', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1' }), row({ leaderId: 'L2', realisedPnl: '5' })], {
      now: NOW,
      leaderAllowlist: ['L2'],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.stats.map((s) => s.leaderId)).toEqual(['L2']);
    expect(r.skippedIncomplete).toBe(1);
  });

  it('Stage-2 L3: allowlist miss → empty not invent', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1' })], { now: NOW, leaderAllowlist: ['NOPE'] });
    expect(r).toEqual({ status: 'empty', userMessageKey: 'agents.copy_intel.empty' });
  });
});

describe('L3 wave52 copy-intel stats status/export', () => {
  it('empty ok and unavailable boards', () => {
    const empty = buildLeaderStats([], { now: NOW });
    expect(isIntelEmpty(empty)).toBe(true);
    expect(intelLeaderCount(empty)).toBe(0);
    expect(intelStatusLineMatches(empty)).toBe(true);
    expect(intelExportText(empty).startsWith(intelExportHeader())).toBe(true);
    expect(parseIntelStatusLine('nope')).toBeNull();

    const ok = buildLeaderStats([row({ leaderId: 'L1' })], { now: NOW });
    expect(isIntelOk(ok)).toBe(true);
    expect(intelLeaderCount(ok)).toBe(1);
    expect(intelBoardCard(ok).leaders).toBe(1);
    expect(intelStatusLineMatches(ok)).toBe(true);
    expect(leaderStatExportLines(ok)).toHaveLength(1);
    expect(leaderStatExportLines(ok)[0]).toContain('L1,');
    expect(leaderStatExportHeader()).toContain('leaderId');
    expect(intelLeaderCountInRange(ok, 1, 1)).toBe(true);
    expect(intelLeaderCountInRange(ok, 2, 1)).toBe(false);
    expect(intelExportLine(ok)).toContain('ok,1,');
    expect(intelSkippedCount(ok)).toBe(0);
  });
});

describe('copy-intel realisedPnl is money — bigint parse, never Number()', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('parses realised PnL as scaled bigint — never Number()', () => {
    const src = readFileSync(join(here, 'stats.ts'), 'utf8');
    expect(src).toMatch(/parseAmount/);
    expect(src).not.toMatch(/function parseDecimal/);
    expect(src).not.toMatch(/const n = Number\(/);
    expect(src).not.toMatch(/\bparseFloat\s*\(/);
  });

  it('keeps a past-MAX_SAFE_INTEGER PnL string (does not round, does not rank)', () => {
    const pastSafe = '9007199254740993';
    const r = buildLeaderStats([row({ leaderId: 'L1', realisedPnl: pastSafe })], { now: NOW });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.stats[0]!.realisedPnl).toBe(pastSafe);
    expect(r.stats[0]!.realisedPnl).not.toBe(String(Number(pastSafe)));
  });

  it('skips PnL with more than 18 decimal places — refuse invent', () => {
    const r = buildLeaderStats([row({ leaderId: 'L1', realisedPnl: '1.1234567890123456789' })], { now: NOW });
    expect(r.status).toBe('unavailable');
    if (r.status !== 'unavailable') return;
    expect(r.reason).toBe('no_data');
  });
});
