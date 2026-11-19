import { describe, expect, it } from 'vitest';
import {
  TournamentError,
  assertMayWriteScore,
  assertScore,
  assertSeasonSlug,
  countStandingsAboveScore,
  bottomNStandings,
  maxScore,
  medianScore,
  minScore,
  standingCount,
  pageStandings,
  rankStandings,
  scoreOfUser,
  isInTopN,
  listStandingUserIds,
  standingNeighbors,
  standingOfUser,
  topNStandings,
  type StandingRecord,
  averageScore,
  hasStanding,
  scoreSpread,
  scoreRange,
  rankOfUser,
  isTopScorer,
  secondPlaceUser,
  lastPlaceUser,
  thirdPlaceUser,
  firstPlaceUser,
  scoreAtRank,
  userAtRank,
  podiumUserIds,
  isEmptyStandings,
  hasAnyStanding,
  bottomUser,
  scoresInRankOrder,
  hasPodiumDepth,
  rankedCount,
  averageTopNScore,
  isTiedForFirst,
  countAboveScore,
  hasUniqueLeader,
  firstSecondScoreGap,
  tiedForLeadUserIds,
  allScoresEqual,
  minRankForTopK,
  secondThirdScoreGap,
  userIdsBelowScore,
  userIdsAtOrAboveScore,
  hasClearLeader,
  lastTwoScoreGap,
  hasAtLeastStandings,
  midRankUser,
  totalScoreSum,
  standingCountLabel,
  maxScoreLabel,
  minScoreLabel,
  rankedUserIdsJoined,
  scoresInRankOrderJoined,
  podiumUserIdsJoined,
  standingUserIdsJoined,
  averageScoreLabel,
  firstPlaceUserLabel,
  lastPlaceUserLabel,
  midRankUserLabel,
  scoreSpreadLabel,
  scoreExtremumSnapshot,
  podiumSnapshot,
  scoreExtremumConsistent,
  standingDepthSnapshot,
  leaderboardHeadline,
  userStandingCard,
  topNStandingCards,
  userStandingPresent,
  filterStandingsMinScore,
  filterStandingsMaxScore,
  searchStandingUserIds,
  countStandingsInScoreRange,
  pageRankedStandings,
  pageRankedUserIds,
  standingsPageCount,
  reverseRankedStandings,
  standingUserIdsOnlyLeft,
  standingUserIdsInBoth,
  scoreDeltaForUser,
  standingsSameSize,
  safePageRankedStandings,
  clampStandingsPageIndex,
  rankedStandingsAtPage,
  isValidStandingsPage,
  standingsExportLines,
  standingsExportHeader,
  standingsExportText,
  standingsExportLineCount,
  parseStandingsExportLine,
  countStandingsExportDataLines,
  standingsExportHasHeader,
  standingsExportRoundTripOk,
  leaderboardStatusLine,
  leaderboardStatusLineIsEmpty,
  leaderboardStatusLineDetailed,
  leaderboardStatusLineTokenCount,
  parseLeaderboardStatusLine,
  leaderboardStatusLineMatches,
  leaderboardStatusLineDetailedConsistent,
  standingCountInRange,
  maxScoreAtLeast,
  clampStandingsPageSize,
  scoreSpreadAtMost,
} from './ladder.js';

const row = (userId: string, score: number, t: string): StandingRecord => ({
  seasonId: 's',
  userId,
  score,
  updatedAt: new Date(t),
});

describe('rankStandings', () => {
  it('orders by score DESC then earlier update first', () => {
    const ranked = rankStandings([
      row('a', 10, '2026-08-01T12:00:00Z'),
      row('b', 20, '2026-08-01T13:00:00Z'),
      row('c', 20, '2026-08-01T11:00:00Z'),
    ]);
    expect(ranked.map((r) => r.userId)).toEqual(['c', 'b', 'a']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});

describe('validators', () => {
  it('accepts a clean slug', () => {
    expect(assertSeasonSlug('Summer-2026')).toBe('summer-2026');
  });
  it('refuses bad slug / score / frozen write', () => {
    expect(() => assertSeasonSlug('x')).toThrow(TournamentError);
    expect(() => assertScore(-1)).toThrow(TournamentError);
    expect(() => assertMayWriteScore('frozen')).toThrow(TournamentError);
    expect(() => assertMayWriteScore('live')).not.toThrow();
  });

  it('L3 pageStandings does not invent rows past total', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    const page = pageStandings(rows, { offset: 1, limit: 1 });
    expect(page.total).toBe(3);
    expect(page.standings).toHaveLength(1);
    expect(page.standings[0]!.userId).toBe('c');
    expect(pageStandings(rows, { offset: 50, limit: 10 }).standings).toEqual([]);
  });

  it('L3 pageStandings refuses blank limit — never invent 50', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(() => pageStandings(rows)).toThrow(TournamentError);
    expect(() => pageStandings(rows, {})).toThrow(TournamentError);
    expect(() => pageStandings(rows, { offset: 0 })).toThrow(TournamentError);
    expect(() => pageStandings(rows, { limit: Number.NaN })).toThrow(TournamentError);
    expect(() => pageStandings(rows, { limit: 0 })).toThrow(TournamentError);
    try {
      pageStandings(rows);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TournamentError);
      expect((e as TournamentError).code).toBe('academy.standings_limit_unset');
      expect((e as TournamentError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('L3 pageStandings accepts owner-published 50', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`u${i}`, 60 - i, '2026-08-01T12:00:00Z'));
    const page = pageStandings(rows, { limit: 50 });
    expect(page.limit).toBe(50);
    expect(page.standings).toHaveLength(50);
  });

  it('L3 standingOfUser returns null when missing — never invent', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(standingOfUser(rows, 'b')?.rank).toBe(1);
    expect(standingOfUser(rows, 'missing')).toBeNull();
    expect(standingOfUser(rows, '  ')).toBeNull();
  });

  it('L3 topNStandings clamps without invent podium', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(topNStandings(rows, 1).map((r) => r.userId)).toEqual(['b']);
    expect(topNStandings(rows, 0)).toEqual([]);
  });
});

describe('L3 standings board helpers', () => {
  it('standingNeighbors never invents missing place', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(standingNeighbors(rows, 'missing')).toBeNull();
    const n = standingNeighbors(rows, 'c');
    expect(n?.self.userId).toBe('c');
    expect(n?.above?.userId).toBe('b');
    expect(n?.below?.userId).toBe('a');
  });

  it('scoreOfUser + countStandingsAboveScore without invent', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(scoreOfUser(rows, 'b')).toBe(20);
    expect(scoreOfUser(rows, 'missing')).toBeNull();
    expect(scoreOfUser(rows, '  ')).toBeNull();
    expect(countStandingsAboveScore(rows, 15)).toBe(1);
    expect(countStandingsAboveScore([], 0)).toBe(0);
  });

  it('standingCount is length without invent', () => {
    expect(standingCount([])).toBe(0);
    expect(standingCount([row('a', 1, '2026-08-01T12:00:00Z')])).toBe(1);
  });

  it('L3 bottomNStandings empty when n<=0; never invents podium', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(bottomNStandings(rows, 0)).toEqual([]);
    const bot = bottomNStandings(rows, 1);
    expect(bot).toHaveLength(1);
    expect(bot[0]!.userId).toBe('a');
  });

  it('L3 wave13 isInTopN + listStandingUserIds', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(isInTopN(rows, 'b', 1)).toBe(true);
    expect(isInTopN(rows, 'a', 1)).toBe(false);
    expect(isInTopN(rows, 'missing', 3)).toBe(false);
    expect(isInTopN(rows, 'b', 0)).toBe(false);
    expect(listStandingUserIds(rows)).toEqual(['a', 'b', 'c']);
    expect(listStandingUserIds([])).toEqual([]);
  });

  it('L3 medianScore null when empty; never invent 0', () => {
    expect(medianScore([])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 30, '2026-08-01T11:00:00Z')];
    expect(medianScore(rows)).toBe(20);
  });

  it('L3 maxScore/minScore null when empty', () => {
    expect(maxScore([])).toBeNull();
    expect(minScore([])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z'), row('c', 20, '2026-08-01T11:00:00Z')];
    expect(maxScore(rows)).toBe(30);
    expect(minScore(rows)).toBe(10);
  });
  it('L3 averageScore null when empty', () => {
    expect(averageScore([])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(averageScore(rows)).toBe(15);
  });

  it('L3 wave16 scoreSpread + hasStanding', () => {
    expect(scoreSpread([])).toBeNull();
    expect(scoreSpread([row('a', 10, '2026-08-01T12:00:00Z')])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(scoreSpread(rows)).toBe(10);
    expect(hasStanding(rows, 'a')).toBe(true);
    expect(hasStanding(rows, 'missing')).toBe(false);
    expect(hasStanding(rows, '  ')).toBe(false);
  });

  it('L3 scoreRange matches scoreSpread', () => {
    expect(scoreRange([])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(scoreRange(rows)).toBe(20);
  });

  it('L3 rankOfUser null when missing', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(rankOfUser(rows, 'missing')).toBeNull();
    expect(rankOfUser(rows, 'b')).toBe(1);
  });

  it('L3 isTopScorer false when missing', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(isTopScorer(rows, 'missing')).toBe(false);
    expect(isTopScorer(rows, 'b')).toBe(true);
    expect(isTopScorer(rows, 'a')).toBe(false);
  });

  it('L3 secondPlaceUser null without podium', () => {
    expect(secondPlaceUser([])).toBeNull();
    expect(secondPlaceUser([row('a', 10, '2026-08-01T12:00:00Z')])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(secondPlaceUser(rows)).toBe('a');
  });

  it('L3 wave21 thirdPlaceUser + lastPlaceUser', () => {
    expect(thirdPlaceUser([])).toBeNull();
    expect(lastPlaceUser([])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(thirdPlaceUser(rows)).toBe('a');
    expect(lastPlaceUser(rows)).toBe('a');
    expect(thirdPlaceUser([row('b', 20, '2026-08-01T13:00:00Z')])).toBeNull();
  });

  it('L3 firstPlaceUser null when empty', () => {
    expect(firstPlaceUser([])).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(firstPlaceUser(rows)).toBe('b');
  });

  it('L3 scoreAtRank null when missing rank', () => {
    expect(scoreAtRank([], 1)).toBeNull();
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(scoreAtRank(rows, 1)).toBe(20);
    expect(scoreAtRank(rows, 2)).toBe(10);
    expect(scoreAtRank(rows, 3)).toBeNull();
  });

  it('L3 wave25 userAtRank + podium + empty guards', () => {
    expect(userAtRank([], 1)).toBeNull();
    expect(podiumUserIds([])).toEqual([]);
    expect(isEmptyStandings([])).toBe(true);
    expect(hasAnyStanding([])).toBe(false);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(userAtRank(rows, 1)).toBe('b');
    expect(userAtRank(rows, 2)).toBe('c');
    expect(userAtRank(rows, 0)).toBeNull();
    expect(podiumUserIds(rows)).toEqual(['b', 'c', 'a']);
    expect(isEmptyStandings(rows)).toBe(false);
    expect(hasAnyStanding(rows)).toBe(true);
  });

  it('L3 wave26 bottomUser + scores order + podium depth + rankedCount', () => {
    expect(bottomUser([])).toBeNull();
    expect(scoresInRankOrder([])).toEqual([]);
    expect(hasPodiumDepth([], 1)).toBe(false);
    expect(rankedCount([])).toBe(0);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 15, '2026-08-01T11:00:00Z')];
    expect(bottomUser(rows)).toBe('a');
    expect(scoresInRankOrder(rows)).toEqual([20, 15, 10]);
    expect(hasPodiumDepth(rows, 3)).toBe(true);
    expect(hasPodiumDepth(rows, 4)).toBe(false);
    expect(rankedCount(rows)).toBe(3);
  });

  it('L3 wave27 averageTopN + tied first + unique leader', () => {
    expect(averageTopNScore([], 3)).toBeNull();
    expect(isTiedForFirst([], 'a')).toBe(false);
    expect(hasUniqueLeader([])).toBe(false);
    const rows = [row('a', 20, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 10, '2026-08-01T11:00:00Z')];
    expect(averageTopNScore(rows, 2)).toBe(20);
    expect(isTiedForFirst(rows, 'a')).toBe(true);
    expect(hasUniqueLeader(rows)).toBe(false);
    expect(countAboveScore(rows, 10)).toBe(2);
    const uniq = [row('a', 30, '2026-08-01T12:00:00Z'), row('b', 10, '2026-08-01T13:00:00Z')];
    expect(hasUniqueLeader(uniq)).toBe(true);
  });

  it('L3 wave28 score gap + ties + equal + minRank', () => {
    expect(firstSecondScoreGap([])).toBeNull();
    expect(tiedForLeadUserIds([])).toEqual([]);
    expect(allScoresEqual([])).toBe(false);
    expect(minRankForTopK([], 1)).toBeNull();
    const rows = [row('a', 20, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 5, '2026-08-01T11:00:00Z')];
    expect(firstSecondScoreGap(rows)).toBe(0);
    expect(tiedForLeadUserIds(rows)).toEqual(['a', 'b']);
    expect(allScoresEqual(rows)).toBe(false);
    expect(minRankForTopK(rows, 2)).toBe(2);
    const equal = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 10, '2026-08-01T13:00:00Z')];
    expect(allScoresEqual(equal)).toBe(true);
  });

  it('L3 wave29 second-third gap + score filters + clear leader', () => {
    expect(secondThirdScoreGap([])).toBeNull();
    expect(userIdsBelowScore([], 10)).toEqual([]);
    expect(hasClearLeader([])).toBe(false);
    const rows = [row('a', 30, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z'), row('c', 10, '2026-08-01T11:00:00Z')];
    expect(secondThirdScoreGap(rows)).toBe(10);
    expect(userIdsBelowScore(rows, 25)).toEqual(['b', 'c']);
    expect(userIdsAtOrAboveScore(rows, 20)).toEqual(['a', 'b']);
    expect(hasClearLeader(rows)).toBe(true);
  });

  it('L3 wave30 last gap + at-least + mid user + sum', () => {
    expect(lastTwoScoreGap([])).toBeNull();
    expect(hasAtLeastStandings([], 1)).toBe(false);
    expect(midRankUser([])).toBeNull();
    expect(totalScoreSum([])).toBe(0);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z'), row('c', 20, '2026-08-01T11:00:00Z')];
    expect(hasAtLeastStandings(rows, 3)).toBe(true);
    expect(totalScoreSum(rows)).toBe(60);
    expect(midRankUser(rows)).toBe('c');
    expect(lastTwoScoreGap(rows)).toBe(10);
  });

  it('L3 wave31 score labels + ranked join', () => {
    expect(standingCountLabel([])).toBe('0');
    expect(maxScoreLabel([])).toBe('');
    expect(minScoreLabel([])).toBe('');
    expect(rankedUserIdsJoined([])).toBe('');
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(standingCountLabel(rows)).toBe('2');
    expect(maxScoreLabel(rows)).toBe('20');
    expect(minScoreLabel(rows)).toBe('10');
    expect(rankedUserIdsJoined(rows)).toBe('b,a');
  });

  it('L3 wave32 score/podium joins + average label', () => {
    expect(scoresInRankOrderJoined([])).toBe('');
    expect(podiumUserIdsJoined([])).toBe('');
    expect(standingUserIdsJoined([])).toBe('');
    expect(averageScoreLabel([])).toBe('');
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 20, '2026-08-01T13:00:00Z')];
    expect(scoresInRankOrderJoined(rows)).toBe('20,10');
    expect(podiumUserIdsJoined(rows)).toBe('b,a');
    expect(averageScoreLabel(rows)).toBe('15');
  });

  it('L3 wave33 place/spread labels', () => {
    expect(firstPlaceUserLabel([])).toBe('');
    expect(lastPlaceUserLabel([])).toBe('');
    expect(midRankUserLabel([])).toBe('');
    expect(scoreSpreadLabel([])).toBe('');
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(firstPlaceUserLabel(rows)).toBe('b');
    expect(lastPlaceUserLabel(rows)).toBe('a');
    expect(scoreSpreadLabel(rows)).toBe('20');
  });

  it('L3 wave34 extremum + podium + depth snapshots', () => {
    expect(scoreExtremumSnapshot([]).max).toBeNull();
    expect(podiumSnapshot([]).first).toBeNull();
    expect(scoreExtremumConsistent([])).toBe(true);
    expect(standingDepthSnapshot([]).empty).toBe(true);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z'), row('c', 20, '2026-08-01T11:00:00Z')];
    expect(scoreExtremumSnapshot(rows).max).toBe(30);
    expect(scoreExtremumConsistent(rows)).toBe(true);
    expect(podiumSnapshot(rows).first).toBe('b');
    expect(standingDepthSnapshot(rows).hasPodium3).toBe(true);
  });

  it('L3 wave36 leaderboard headline + user card + topN', () => {
    expect(leaderboardHeadline([]).empty).toBe(true);
    expect(userStandingCard([], 'a').present).toBe(false);
    expect(topNStandingCards([], 3)).toEqual([]);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(leaderboardHeadline(rows).first).toBe('b');
    expect(userStandingCard(rows, 'b').isTop).toBe(true);
    expect(userStandingPresent(rows, 'a')).toBe(true);
    expect(topNStandingCards(rows, 1)[0]!.userId).toBe('b');
  });

  it('L3 wave37 filter/search standings + score range count', () => {
    expect(filterStandingsMinScore([], 1)).toEqual([]);
    expect(searchStandingUserIds([], 'a')).toEqual([]);
    expect(countStandingsInScoreRange([], 0, 10)).toBe(0);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z'), row('c', 20, '2026-08-01T11:00:00Z')];
    expect(filterStandingsMinScore(rows, 20)).toHaveLength(2);
    expect(filterStandingsMaxScore(rows, 20)).toHaveLength(2);
    expect(searchStandingUserIds(rows, 'a')).toEqual(['a']);
    expect(countStandingsInScoreRange(rows, 10, 20)).toBe(2);
  });

  it('L3 wave38 page ranked + reverse + page count', () => {
    expect(pageRankedStandings([], { limit: 1 })).toEqual([]);
    expect(standingsPageCount([], 10)).toBe(0);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z'), row('c', 20, '2026-08-01T11:00:00Z')];
    expect(pageRankedUserIds(rows, { offset: 0, limit: 2 })).toEqual(['b', 'c']);
    expect(standingsPageCount(rows, 2)).toBe(2);
    expect(reverseRankedStandings(rows)[0]!.userId).toBe('a');
  });

  it('L3 pageRankedStandings refuses blank limit — never invent full list', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(() => pageRankedStandings(rows)).toThrow(TournamentError);
    expect(() => pageRankedStandings(rows, {})).toThrow(TournamentError);
    expect(() => pageRankedStandings(rows, { offset: 0 })).toThrow(TournamentError);
    expect(() => pageRankedStandings(rows, { limit: Number.NaN })).toThrow(TournamentError);
    expect(() => pageRankedStandings(rows, { limit: 0 })).toThrow(TournamentError);
    expect(() => pageRankedUserIds(rows)).toThrow(TournamentError);
    try {
      pageRankedStandings(rows);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TournamentError);
      expect((e as TournamentError).code).toBe('academy.standings_limit_unset');
    }
  });

  it('L3 pageRankedStandings accepts owner-published limit', () => {
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z'), row('c', 20, '2026-08-01T11:00:00Z')];
    expect(pageRankedStandings(rows, { limit: 2 }).map((r) => r.userId)).toEqual(['b', 'c']);
    expect(pageRankedUserIds(rows, { offset: 1, limit: 1 })).toEqual(['c']);
  });

  it('L3 wave39 standings diffs + score delta', () => {
    const left = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    const right = [row('b', 20, '2026-08-01T13:00:00Z'), row('c', 5, '2026-08-01T11:00:00Z')];
    expect(standingUserIdsOnlyLeft(left, right)).toEqual(['a']);
    expect(standingUserIdsInBoth(left, right)).toEqual(['b']);
    expect(scoreDeltaForUser(left, right, 'b')).toBe(10);
    expect(scoreDeltaForUser(left, right, 'a')).toBeNull();
    expect(standingsSameSize(left, right)).toBe(true);
  });

  it('L3 wave40 safe standings paging', () => {
    expect(safePageRankedStandings([], 0, 1)).toEqual([]);
    expect(isValidStandingsPage([], 0, 1)).toBe(false);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(safePageRankedStandings(rows, 0, 1)).toHaveLength(1);
    expect(clampStandingsPageIndex(rows, 99, 1)).toBe(1);
    expect(rankedStandingsAtPage(rows, 0, 1)[0]!.userId).toBe('b');
    expect(isValidStandingsPage(rows, 0, 1)).toBe(true);
  });

  it('L3 wave41 standings export', () => {
    expect(standingsExportLines([])).toEqual([]);
    expect(standingsExportHeader()).toBe('rank,userId,score');
    expect(standingsExportLineCount([])).toBe(1);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(standingsExportLines(rows)[0]).toBe('1,b,30');
    expect(standingsExportText(rows)).toContain('userId');
    expect(standingsExportLineCount(rows)).toBe(3);
  });

  it('L3 wave42 standings export parse + round-trip', () => {
    expect(parseStandingsExportLine('rank,userId,score')).toBeNull();
    expect(parseStandingsExportLine('1,a,10')).toEqual({ rank: 1, userId: 'a', score: 10 });
    expect(standingsExportRoundTripOk([])).toBe(true);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    const text = standingsExportText(rows);
    expect(standingsExportHasHeader(text)).toBe(true);
    expect(countStandingsExportDataLines(text)).toBe(2);
    expect(standingsExportRoundTripOk(rows)).toBe(true);
  });

  it('L3 wave44 leaderboard status lines', () => {
    expect(leaderboardStatusLineIsEmpty([])).toBe(true);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(leaderboardStatusLine(rows)).toContain('count=2');
    expect(leaderboardStatusLineDetailed(rows)).toContain('unique=1');
    expect(leaderboardStatusLineTokenCount(rows)).toBeGreaterThan(3);
  });

  it('L3 wave45 leaderboard status parse + match', () => {
    expect(parseLeaderboardStatusLine('count=0 first=- max=-')).toEqual({ count: 0, first: null, max: null });
    expect(leaderboardStatusLineMatches([])).toBe(true);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(leaderboardStatusLineMatches(rows)).toBe(true);
    expect(leaderboardStatusLineDetailedConsistent(leaderboardStatusLineDetailed(rows))).toBe(true);
  });

  it('L3 wave46 standings thresholds + clamps', () => {
    expect(standingCountInRange([], 0, 0)).toBe(true);
    expect(maxScoreAtLeast([], 1)).toBe(false);
    const rows = [row('a', 10, '2026-08-01T12:00:00Z'), row('b', 30, '2026-08-01T13:00:00Z')];
    expect(standingCountInRange(rows, 2, 2)).toBe(true);
    expect(maxScoreAtLeast(rows, 30)).toBe(true);
    expect(clampStandingsPageSize(rows, 99)).toBe(2);
    expect(scoreSpreadAtMost(rows, 20)).toBe(true);
  });
});
