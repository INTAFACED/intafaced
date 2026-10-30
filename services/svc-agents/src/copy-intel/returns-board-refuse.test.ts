/**
 * D26-P1-A5 — audited write path + explicit refuse of returns-ranked boards.
 * Public-door proofs live here so a unit-only pin cannot ship a ranked board.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { AgentError } from '../errors.js';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { COPY_INTEL_AGENT_ID } from './session-run.js';
import { buildLeaderStats, type LeaderPerformanceFixture, type LeaderStat } from './stats.js';
import {
  auditedStatsPreserveInputOrder,
  auditedWriteBoardCard,
  FORBIDDEN_RETURNS_RANK_KEYS,
  isForbiddenReturnsRankKey,
  isReturnsDescending,
  presentAuditedLeaderStats,
  rankLeadersByReturns,
  refuseReturnsRankedMarketingBoard,
  RETURNS_RANKED_BOARD_REFUSE_REASON,
  returnsRankedBoard,
  asksForReturnsRanking,
  COPY_INTEL_SESSION_AGENT_ID,
} from './returns-board-refuse.js';

const NOW = new Date('2026-08-12T08:00:00.000Z');
const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'an-agents-copy-intel-returns-board-public-door-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

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

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read', 'agents:execute'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function stubDeps(): AgentsRouterDeps {
  return {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'IFC',
  };
}

const highPnl = {
  leaderId: 'zulu-leader',
  realisedPnl: '999.00',
  closedTrades: 50,
  winRate: '0.9000',
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-07T00:00:00.000Z',
};

const lowPnl = {
  leaderId: 'alpha-leader',
  realisedPnl: '-10.00',
  closedTrades: 5,
  winRate: '0.2000',
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-07T00:00:00.000Z',
};

/** Comparator that ranks by performance — must not appear in production copy-intel. */
const RETURNS_SORT_SHIP = /\.sort\s*\([^;]{0,400}(realisedPnl|realizedPnl|winRate|win_rate|\broi\b|\bpnl\b|\breturns\b)/s;

describe('D26-P1-A5 returns-ranked marketing board refuse', () => {
  it('rankLeadersByReturns throws agents.refused (trade.copy mirror)', () => {
    try {
      rankLeadersByReturns();
      expect.unreachable('rank');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('agents.refused');
      expect((err as AgentError).userMessageKey).toBe('agents.copy_intel.unavailable');
      expect((err as AgentError).userMessageParams.reason).toBe(RETURNS_RANKED_BOARD_REFUSE_REASON);
    }
  });

  it('returnsRankedBoard refuses by that name', () => {
    try {
      returnsRankedBoard();
      expect.unreachable('named board');
    } catch (err) {
      expect((err as AgentError).code).toBe('agents.refused');
      expect((err as AgentError).userMessageParams.rankBy).toBe('returns');
      expect((err as AgentError).userMessageParams.reason).toBe(RETURNS_RANKED_BOARD_REFUSE_REASON);
    }
  });

  it('refuseReturnsRankedMarketingBoard names the forbidden rankBy', () => {
    try {
      refuseReturnsRankedMarketingBoard('winRate');
      expect.unreachable('refuse');
    } catch (err) {
      expect((err as AgentError).userMessageParams.rankBy).toBe('winRate');
    }
  });

  it('every forbidden rank key is detected', () => {
    for (const key of FORBIDDEN_RETURNS_RANK_KEYS) {
      expect(isForbiddenReturnsRankKey(key)).toBe(true);
    }
    expect(isForbiddenReturnsRankKey('leaderId')).toBe(false);
    expect(isForbiddenReturnsRankKey('input')).toBe(false);
  });

  it('presentAuditedLeaderStats refuses realisedPnl / winRate / returns ranking', () => {
    const built = buildLeaderStats([row({ leaderId: 'low', realisedPnl: '1' }), row({ leaderId: 'high', realisedPnl: '99' })], {
      now: NOW,
    });
    expect(built.status).toBe('ok');
    for (const rankBy of ['realisedPnl', 'winRate', 'returns', 'pnl', 'roi'] as const) {
      expect(() => presentAuditedLeaderStats(built, { rankBy })).toThrow(AgentError);
    }
  });

  it('buildLeaderStats preserves fixture order — high PnL last stays last', () => {
    const built = buildLeaderStats(
      [
        row({ leaderId: 'low', realisedPnl: '1.0' }),
        row({ leaderId: 'mid', realisedPnl: '50.0' }),
        row({ leaderId: 'high', realisedPnl: '999.0' }),
      ],
      { now: NOW },
    );
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    expect(built.stats.map((s) => s.leaderId)).toEqual(['low', 'mid', 'high']);
    expect(auditedStatsPreserveInputOrder(built.stats, ['low', 'mid', 'high'])).toBe(true);
    // Ascending PnL in input order is the opposite of a marketing board.
    expect(isReturnsDescending(built.stats)).toBe(false);
  });

  it('presentAuditedLeaderStats may sort by leaderId only — never by returns', () => {
    const built = buildLeaderStats([row({ leaderId: 'Z', realisedPnl: '1' }), row({ leaderId: 'A', realisedPnl: '900' })], { now: NOW });
    expect(built.status).toBe('ok');
    const presented = presentAuditedLeaderStats(built, { order: 'leaderId' });
    expect(presented.status).toBe('ok');
    if (presented.status !== 'ok') return;
    expect(presented.stats.map((s) => s.leaderId)).toEqual(['A', 'Z']);
    // A has higher PnL and comes first only because of leaderId — still not a returns board.
    expect(presented.stats[0]!.realisedPnl).toBe('900');
  });

  it('isReturnsDescending compares realisedPnl as bigint — Number() would collapse past MAX_SAFE_INTEGER', () => {
    const src = readFileSync(join(HERE, 'returns-board-refuse.ts'), 'utf8');
    expect(src).toMatch(/parseAmount/);
    expect(src).not.toMatch(/Number\(stats\[/);
    const high = '9007199254740993';
    const low = '9007199254740992';
    expect(Number(high)).toBe(Number(low));
    const stat = (leaderId: string, realisedPnl: string): LeaderStat => ({
      leaderId,
      realisedPnl,
      closedTrades: 1,
      winRate: '1.0000',
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-07T00:00:00.000Z',
    });
    expect(isReturnsDescending([stat('a', high), stat('b', low)])).toBe(true);
    expect(isReturnsDescending([stat('a', low), stat('b', high)])).toBe(false);
    expect(isReturnsDescending([stat('a', 'not-money'), stat('b', '1')])).toBe(false);
  });

  it('auditedWriteBoardCard reports ranking forbidden', () => {
    const built = buildLeaderStats([row({ leaderId: 'L1' })], { now: NOW });
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    expect(auditedWriteBoardCard(built)).toEqual({
      status: 'ok',
      auditedWrites: 1,
      ranking: 'forbidden',
    });
  });
});

describe('D26-P1-A5 public door — returns-ranked board refuses by name', () => {
  it('copyIntel.presentDirectory refuses every forbidden rank key', async () => {
    const caller = createAgentsRouter(stubDeps()).createCaller(signed());
    for (const sortBy of FORBIDDEN_RETURNS_RANK_KEYS) {
      const result = await caller.copyIntel.presentDirectory({ stats: [highPnl, lowPnl], sortBy });
      expect(result, sortBy).toEqual({
        status: 'refuse',
        reason: 'returns_ranked_board',
        userMessageKey: 'agents.copy_intel.unavailable',
      });
    }
  });

  it('copyIntel.runSession live without sealed leaders refuses no_live_leaders (no invented ROI)', async () => {
    const result = await createAgentsRouter(stubDeps())
      .createCaller(signed())
      .copyIntel.runSession({
        plane: 'live',
        fixtures: [
          {
            leaderId: 'ghost-roi',
            realisedPnl: '9999.00',
            closedTrades: 80,
            winningTrades: 79,
            windowStart: '2026-08-01T00:00:00.000Z',
            windowEnd: '2026-08-07T00:00:00.000Z',
            source: 'invented-roi',
          },
        ],
        leaderAllowlist: ['ghost-roi'],
      });
    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'no_live_leaders',
      userMessageKey: 'agents.copy_intel.unavailable',
    });
    expect(result.metering.billedAmount).toBe('0');
  });
});

describe('D26-P1-A5 production pin — a returns sort must not ship', () => {
  it('copy-intel production sources never .sort by PnL / winRate / returns / roi', () => {
    const files = readdirSync(HERE).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const name of files) {
      const src = readFileSync(join(HERE, name), 'utf8');
      if (RETURNS_SORT_SHIP.test(src)) hits.push(name);
    }
    expect(hits, `returns-ranked .sort still ships in: ${hits.join(', ')}`).toEqual([]);
  });
});

describe('asksForReturnsRanking — a request for a returns board', () => {
  it('guards the same agent id the Copy-Intel session opens', () => {
    expect(COPY_INTEL_SESSION_AGENT_ID).toBe(COPY_INTEL_AGENT_ID);
  });

  it.each([
    'TEST: rank the leaders by returns',
    'sort leaders by PnL',
    'who are the top 10 leaders by ROI?',
    'show me the best performance leaderboard',
    'order leaders by win rate',
    'which traders have the highest returns?',
    'leaders sorted by profit please',
    'give me a ranking of the leaders by returns',
    'rank the copy leaders by PnL',
    'rank each leader by ROI',
    'which trader is most profitable?',
    'ordered list of leaders by PnL',
    'leaders: highest ROI',
    'clasifica a los líderes por rentabilidad',
    'classe les traders par rendement',
  ])('names %s a ranking', (text) => {
    expect(asksForReturnsRanking(text)).toBe(true);
  });

  it.each([
    'show leader L1 stats',
    'what is the drawdown of leader L2?',
    'rank my watchlist alphabetically',
    'returns for leader L3',
    'what is the PnL of my order?',
    'best performance month for leader L1',
    'sort out my returns report',
    'list the leaders I follow',
    'I lost money on my top leaders, what were my returns?',
    'Which leaders have the most followers, and how is performance computed?',
  ])('does not name %s a ranking', (text) => {
    expect(asksForReturnsRanking(text)).toBe(false);
  });
});
