import { describe, expect, it } from 'vitest';
import { TournamentError, type StandingRecord } from './ladder.js';
import {
  allowedNextStatuses,
  countSeasonsByStatus,
  filterSeasonsByStatus,
  isSeasonTerminal,
  listEndedSeasons,
  listFrozenSeasonIds,
  frozenSeasonCount,
  listFrozenSeasons,
  listLiveSeasonIds,
  listLiveSeasons,
  liveSeasonCount,
  listScheduledSeasonIds,
  listScheduledSeasons,
  listSeasonIds,
  freezeSeasonWithSnapshot,
  isScoreWritable,
  listScoreWritableSeasons,
  snapshotStandingsAtFreeze,
  transitionSeason,
  listEndedSeasonIds,
  endedSeasonCount,
  hasLiveSeason,
  scheduledSeasonCount,
  hasFrozenSeason,
  hasEndedSeason,
  hasScheduledSeason,
  totalSeasonCount,
  hasTerminalSeason,
  scoreWritableSeasonCount,
  liveSeasonRatio,
  isSeasonListEmpty,
  frozenSeasonRatio,
  endedSeasonRatio,
  scheduledSeasonRatio,
  allSeasonsEnded,
  openSeasonCount,
  hasScoreWritableSeason,
  openSeasonRatio,
  listScoreWritableSeasonIds,
  allSeasonsLive,
  allSeasonsScheduled,
  allSeasonsFrozen,
  distinctSeasonStatusCount,
  hasAtLeastSeasons,
  firstSeasonId,
  lastSeasonId,
  hasMixedSeasonStatuses,
  seasonCountLabel,
  liveSeasonCountLabel,
  seasonIdsJoined,
  liveSeasonIdsJoined,
  scheduledSeasonIdsJoined,
  frozenSeasonIdsJoined,
  endedSeasonIdsJoined,
  scoreWritableSeasonIdsJoined,
  liveSeasonRatioLabel,
  frozenSeasonRatioLabel,
  endedSeasonRatioLabel,
  openSeasonRatioLabel,
  seasonStatusSnapshot,
  seasonCountsConsistent,
  seasonOpenEndedPartition,
  seasonWritableSnapshot,
  seasonBoardHeadline,
  seasonCard,
  listSeasonCards,
  seasonPresent,
  filterSeasonCardsByStatus,
  searchSeasonIds,
  listWritableSeasonCards,
  listTerminalSeasonCards,
  pageSeasonIds,
  pageLiveSeasonIds,
  seasonListPageCount,
  reverseSeasonIds,
  seasonIdsOnlyLeft,
  seasonIdsInBoth,
  liveSeasonCountDelta,
  seasonsSameSize,
  safePageSeasonIds,
  clampSeasonPageIndex,
  seasonIdsAtPage,
  isValidSeasonPage,
  seasonsExportLines,
  seasonsExportHeader,
  seasonsExportText,
  seasonsExportLineCount,
  parseSeasonsExportLine,
  countSeasonsExportDataLines,
  seasonsExportHasHeader,
  seasonsExportRoundTripOk,
  seasonStatusLine,
  seasonStatusLineIsEmpty,
  seasonStatusLineDetailed,
  seasonStatusLineTokenCount,
  parseSeasonStatusLine,
  seasonStatusLineMatches,
  seasonStatusLineDetailedConsistent,
  seasonCountInRange,
  liveSeasonCountAtLeast,
  clampSeasonPageSize,
  openSeasonRatioAtLeast,
} from './season-lifecycle.js';

const base = {
  id: 's1',
  slug: 'summer-26',
  title: 'Summer',
  rulesSummary: 'Paper scores only',
  startsAt: new Date('2026-08-01T00:00:00.000Z'),
  endsAt: null,
};

const row = (userId: string, score: number, t: string): StandingRecord => ({
  seasonId: 's1',
  userId,
  score,
  updatedAt: new Date(t),
});

describe('tournament Stage-2 season lifecycle (no prizes)', () => {
  it('scheduled → live → frozen → ended', () => {
    let s = { ...base, status: 'scheduled' as const };
    s = transitionSeason(s, 'live');
    expect(s.status).toBe('live');
    expect(isScoreWritable(s.status)).toBe(true);
    s = transitionSeason(s, 'frozen');
    expect(isScoreWritable(s.status)).toBe(false);
    s = transitionSeason(s, 'ended');
    expect(s.status).toBe('ended');
  });

  it('refuses scheduled → frozen', () => {
    const s = { ...base, status: 'scheduled' as const };
    expect(() => transitionSeason(s, 'frozen')).toThrow(TournamentError);
  });

  it('ended is terminal', () => {
    const s = { ...base, status: 'ended' as const };
    expect(() => transitionSeason(s, 'live')).toThrow(TournamentError);
  });

  it('refuses frozen → live (no re-rank without a new season)', () => {
    const s = { ...base, status: 'frozen' as const };
    expect(() => transitionSeason(s, 'live')).toThrow(TournamentError);
    expect(isScoreWritable('frozen')).toBe(false);
    expect(transitionSeason(s, 'ended').status).toBe('ended');
  });

  it('freeze snapshot ranks standings with no money fields', () => {
    const live = { ...base, status: 'live' as const };
    const rows = [
      row('a', 10, '2026-08-01T12:00:00Z'),
      row('b', 50, '2026-08-01T13:00:00Z'),
      row('other-season', 99, '2026-08-01T10:00:00Z'),
    ];
    // foreign seasonId should be ignored by filter
    rows[2] = { ...rows[2]!, seasonId: 'other' };
    const snap = snapshotStandingsAtFreeze({
      seasonId: 's1',
      status: 'live',
      rows,
      frozenAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    expect(snap.standings.map((r) => r.userId)).toEqual(['b', 'a']);
    expect(snap.standings[0]).toMatchObject({ rank: 1, score: 50, userId: 'b' });
    expect(snap).not.toHaveProperty('prize');
    expect(snap).not.toHaveProperty('payout');
    expect(() => snapshotStandingsAtFreeze({ seasonId: 's1', status: 'scheduled', rows: [] })).toThrow(TournamentError);
  });

  it('freezeSeasonWithSnapshot freezes + captures rank table', () => {
    const live = { ...base, status: 'live' as const };
    const { season, snapshot } = freezeSeasonWithSnapshot(live, [row('z', 1, '2026-08-01T00:00:00Z')]);
    expect(season.status).toBe('frozen');
    expect(snapshot.standings).toHaveLength(1);
    expect(isScoreWritable(season.status)).toBe(false);
  });

  it('Stage-3: transition / freeze refuse prize attachment invent', () => {
    const withPrize = { ...base, status: 'live' as const, prize: '100.00' } as typeof base & {
      status: 'live';
      prize: string;
    };
    expect(() => transitionSeason(withPrize, 'frozen')).toThrow(TournamentError);
    expect(() =>
      snapshotStandingsAtFreeze({
        seasonId: 's1',
        status: 'live',
        rows: [],
        prizePool: '1',
      } as { seasonId: string; status: 'live'; rows: StandingRecord[]; prizePool: string }),
    ).toThrow(TournamentError);
  });

  it('L3 countSeasonsByStatus histogram without invent', () => {
    expect(countSeasonsByStatus([])).toEqual({
      scheduled: 0,
      live: 0,
      frozen: 0,
      ended: 0,
      total: 0,
      scoreWritable: 0,
    });
    const h = countSeasonsByStatus([
      { ...base, id: 'a', status: 'scheduled' },
      { ...base, id: 'b', status: 'live' },
      { ...base, id: 'c', status: 'live' },
      { ...base, id: 'd', status: 'frozen' },
      { ...base, id: 'e', status: 'ended' },
    ]);
    expect(h).toEqual({ scheduled: 1, live: 2, frozen: 1, ended: 1, total: 5, scoreWritable: 2 });
  });

  it('L3 listScoreWritableSeasons is live-only', () => {
    const list = listScoreWritableSeasons([
      { ...base, id: 'a', status: 'scheduled' },
      { ...base, id: 'b', status: 'live' },
      { ...base, id: 'c', status: 'frozen' },
    ]);
    expect(list.map((s) => s.id)).toEqual(['b']);
    expect(listScoreWritableSeasons([])).toEqual([]);
  });

  it('L3 allowedNextStatuses ends empty; live may freeze; frozen cannot re-open', () => {
    expect(allowedNextStatuses('ended')).toEqual([]);
    expect(allowedNextStatuses('live')).toContain('frozen');
    expect(allowedNextStatuses('scheduled')).toContain('live');
    expect(allowedNextStatuses('frozen')).toEqual(['ended']);
    expect(allowedNextStatuses('frozen')).not.toContain('live');
  });

  it('L3 filterSeasonsByStatus does not invent rows', () => {
    const seasons = [
      { ...base, id: 'a', status: 'scheduled' as const },
      { ...base, id: 'b', status: 'live' as const },
    ];
    expect(filterSeasonsByStatus(seasons, 'live').map((s) => s.id)).toEqual(['b']);
    expect(filterSeasonsByStatus(seasons, 'ended')).toEqual([]);
    expect(filterSeasonsByStatus([], 'live')).toEqual([]);
  });

  it('L3 isSeasonTerminal + listSeasonIds without invent', () => {
    expect(isSeasonTerminal('ended')).toBe(true);
    expect(isSeasonTerminal('live')).toBe(false);
    expect(listSeasonIds([])).toEqual([]);
    expect(
      listSeasonIds([
        { ...base, id: 'b', status: 'live' },
        { ...base, id: 'a', status: 'scheduled' },
      ]),
    ).toEqual(['a', 'b']);
  });

  it('L3 listScheduledSeasons + listEndedSeasons without invent', () => {
    const seasons = [
      { ...base, id: 'a', status: 'scheduled' as const },
      { ...base, id: 'b', status: 'live' as const },
      { ...base, id: 'c', status: 'ended' as const },
    ];
    expect(listScheduledSeasons(seasons).map((s) => s.id)).toEqual(['a']);
    expect(listEndedSeasons(seasons).map((s) => s.id)).toEqual(['c']);
    expect(listScheduledSeasons([])).toEqual([]);
  });

  it('L3 listFrozenSeasons + listLiveSeasonIds without invent', () => {
    const seasons = [
      { ...base, id: 'a', status: 'live' as const },
      { ...base, id: 'b', status: 'frozen' as const },
      { ...base, id: 'c', status: 'ended' as const },
    ];
    expect(listFrozenSeasons(seasons).map((s) => s.id)).toEqual(['b']);
    expect(listLiveSeasonIds(seasons)).toEqual(['a']);
    expect(listFrozenSeasons([])).toEqual([]);
  });

  it('L3 listLiveSeasons without invent', () => {
    const seasons = [
      { ...base, id: 'a', status: 'live' as const },
      { ...base, id: 'b', status: 'scheduled' as const },
    ];
    expect(listLiveSeasons(seasons).map((s) => s.id)).toEqual(['a']);
    expect(listLiveSeasons([])).toEqual([]);
  });
  it('L3 listScheduledSeasonIds without invent', () => {
    const seasons = [
      { ...base, id: 'a', status: 'scheduled' as const },
      { ...base, id: 'b', status: 'live' as const },
    ];
    expect(listScheduledSeasonIds(seasons)).toEqual(['a']);
    expect(listScheduledSeasonIds([])).toEqual([]);
  });

  it('L3 wave16 listEndedSeasonIds without invent', () => {
    const seasons = [
      { ...base, id: 'a', status: 'live' as const },
      { ...base, id: 'b', status: 'ended' as const },
      { ...base, id: 'c', status: 'ended' as const },
    ];
    expect(listEndedSeasonIds(seasons)).toEqual(['b', 'c']);
    expect(listEndedSeasonIds([])).toEqual([]);
  });

  it('L3 listFrozenSeasonIds without invent', () => {
    const seasons = [
      { ...base, id: 'a', status: 'frozen' as const },
      { ...base, id: 'b', status: 'live' as const },
    ];
    expect(listFrozenSeasonIds(seasons)).toEqual(['a']);
    expect(listFrozenSeasonIds([])).toEqual([]);
  });

  it('L3 liveSeasonCount without invent', () => {
    expect(liveSeasonCount([])).toBe(0);
    const seasons = [
      { ...base, id: 'a', status: 'live' as const },
      { ...base, id: 'b', status: 'live' as const },
      { ...base, id: 'c', status: 'ended' as const },
    ];
    expect(liveSeasonCount(seasons)).toBe(2);
  });

  it('L3 frozenSeasonCount without invent', () => {
    expect(frozenSeasonCount([])).toBe(0);
    const seasons = [
      { ...base, id: 'a', status: 'frozen' as const },
      { ...base, id: 'b', status: 'live' as const },
    ];
    expect(frozenSeasonCount(seasons)).toBe(1);
  });

  it('L3 wave21 endedSeasonCount + hasLiveSeason', () => {
    const seasons = [
      { ...base, id: 'a', status: 'live' as const },
      { ...base, id: 'b', status: 'ended' as const },
      { ...base, id: 'c', status: 'ended' as const },
    ];
    expect(endedSeasonCount(seasons)).toBe(2);
    expect(hasLiveSeason(seasons)).toBe(true);
    expect(hasLiveSeason([])).toBe(false);
    expect(endedSeasonCount([])).toBe(0);
  });

  it('L3 scheduledSeasonCount without invent', () => {
    expect(scheduledSeasonCount([])).toBe(0);
    const seasons = [
      { ...base, id: 'a', status: 'scheduled' as const },
      { ...base, id: 'b', status: 'live' as const },
    ];
    expect(scheduledSeasonCount(seasons)).toBe(1);
  });
});

describe('L3 wave25 season presence helpers', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'stage-1 non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });

  it('hasFrozen/Ended/Scheduled + totalSeasonCount', () => {
    expect(hasFrozenSeason([])).toBe(false);
    expect(hasEndedSeason([])).toBe(false);
    expect(hasScheduledSeason([])).toBe(false);
    expect(totalSeasonCount([])).toBe(0);
    const rows = [mk('s1', 'scheduled'), mk('s2', 'frozen'), mk('s3', 'ended')];
    expect(hasFrozenSeason(rows)).toBe(true);
    expect(hasEndedSeason(rows)).toBe(true);
    expect(hasScheduledSeason(rows)).toBe(true);
    expect(totalSeasonCount(rows)).toBe(3);
  });
});

describe('L3 wave26 season ratios + terminal', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'stage-1 non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });

  it('terminal + writable count + live ratio + empty', () => {
    expect(isSeasonListEmpty([])).toBe(true);
    expect(hasTerminalSeason([])).toBe(false);
    expect(scoreWritableSeasonCount([])).toBe(0);
    expect(liveSeasonRatio([])).toBeNull();
    const rows = [mk('s1', 'live'), mk('s2', 'ended'), mk('s3', 'scheduled')];
    expect(isSeasonListEmpty(rows)).toBe(false);
    expect(hasTerminalSeason(rows)).toBe(true);
    expect(scoreWritableSeasonCount(rows)).toBe(1);
    expect(liveSeasonRatio(rows)).toBe('0.3333');
  });
});

describe('L3 wave27 season status ratios', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('ratios + all ended', () => {
    expect(frozenSeasonRatio([])).toBeNull();
    expect(allSeasonsEnded([])).toBe(false);
    const rows = [mk('a', 'frozen'), mk('b', 'ended'), mk('c', 'scheduled'), mk('d', 'ended')];
    expect(frozenSeasonRatio(rows)).toBe('0.2500');
    expect(endedSeasonRatio(rows)).toBe('0.5000');
    expect(scheduledSeasonRatio(rows)).toBe('0.2500');
    expect(allSeasonsEnded(rows)).toBe(false);
    expect(allSeasonsEnded([mk('x', 'ended')])).toBe(true);
  });
});

describe('L3 wave28 open seasons + writable ids', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('open count/ratio + writable', () => {
    expect(openSeasonCount([])).toBe(0);
    expect(hasScoreWritableSeason([])).toBe(false);
    expect(openSeasonRatio([])).toBeNull();
    expect(listScoreWritableSeasonIds([])).toEqual([]);
    const rows = [mk('a', 'live'), mk('b', 'ended'), mk('c', 'scheduled')];
    expect(openSeasonCount(rows)).toBe(2);
    expect(hasScoreWritableSeason(rows)).toBe(true);
    expect(openSeasonRatio(rows)).toBe('0.6667');
    expect(listScoreWritableSeasonIds(rows)).toEqual(['a']);
  });
});

describe('L3 wave29 all-status + distinct count', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('all live/scheduled/frozen + distinct', () => {
    expect(allSeasonsLive([])).toBe(false);
    expect(distinctSeasonStatusCount([])).toBe(0);
    expect(allSeasonsLive([mk('a', 'live'), mk('b', 'live')])).toBe(true);
    expect(allSeasonsScheduled([mk('a', 'scheduled')])).toBe(true);
    expect(allSeasonsFrozen([mk('a', 'frozen')])).toBe(true);
    expect(distinctSeasonStatusCount([mk('a', 'live'), mk('b', 'ended'), mk('c', 'live')])).toBe(2);
  });
});

describe('L3 wave30 season ends + mixed', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('at-least + first/last id + mixed', () => {
    expect(hasAtLeastSeasons([], 1)).toBe(false);
    expect(firstSeasonId([])).toBeNull();
    expect(lastSeasonId([])).toBeNull();
    expect(hasMixedSeasonStatuses([])).toBe(false);
    const rows = [mk('z', 'live'), mk('a', 'ended')];
    expect(hasAtLeastSeasons(rows, 2)).toBe(true);
    expect(firstSeasonId(rows)).toBe('a');
    expect(lastSeasonId(rows)).toBe('z');
    expect(hasMixedSeasonStatuses(rows)).toBe(true);
  });
});

describe('L3 wave31 season labels + joins', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('labels and joined ids', () => {
    expect(seasonCountLabel([])).toBe('0');
    expect(liveSeasonCountLabel([])).toBe('0');
    expect(seasonIdsJoined([])).toBe('');
    expect(liveSeasonIdsJoined([])).toBe('');
    const rows = [mk('b', 'live'), mk('a', 'ended')];
    expect(seasonCountLabel(rows)).toBe('2');
    expect(liveSeasonCountLabel(rows)).toBe('1');
    expect(seasonIdsJoined(rows)).toBe('a,b');
    expect(liveSeasonIdsJoined(rows)).toBe('b');
  });
});

describe('L3 wave32 season status id joins', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('joins by status', () => {
    expect(scheduledSeasonIdsJoined([])).toBe('');
    expect(frozenSeasonIdsJoined([])).toBe('');
    expect(endedSeasonIdsJoined([])).toBe('');
    expect(scoreWritableSeasonIdsJoined([])).toBe('');
    const rows = [mk('s', 'scheduled'), mk('l', 'live'), mk('f', 'frozen'), mk('e', 'ended')];
    expect(scheduledSeasonIdsJoined(rows)).toBe('s');
    expect(frozenSeasonIdsJoined(rows)).toBe('f');
    expect(endedSeasonIdsJoined(rows)).toBe('e');
    expect(scoreWritableSeasonIdsJoined(rows)).toBe('l');
  });
});

describe('L3 wave33 season ratio labels', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('ratio labels empty and half', () => {
    expect(liveSeasonRatioLabel([])).toBe('');
    expect(frozenSeasonRatioLabel([])).toBe('');
    expect(endedSeasonRatioLabel([])).toBe('');
    expect(openSeasonRatioLabel([])).toBe('');
    const rows = [mk('a', 'live'), mk('b', 'ended')];
    expect(liveSeasonRatioLabel(rows)).toBe('0.5000');
    expect(endedSeasonRatioLabel(rows)).toBe('0.5000');
    expect(openSeasonRatioLabel(rows)).toBe('0.5000');
  });
});

describe('L3 wave34 season snapshots', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('status + open/ended + writable', () => {
    expect(seasonCountsConsistent([])).toBe(true);
    const rows = [mk('a', 'live'), mk('b', 'ended'), mk('c', 'scheduled')];
    expect(seasonCountsConsistent(rows)).toBe(true);
    expect(seasonStatusSnapshot(rows).live).toBe(1);
    expect(seasonOpenEndedPartition(rows)).toEqual({ open: 2, ended: 1 });
    expect(seasonWritableSnapshot(rows).hasWritable).toBe(true);
  });
});

describe('L3 wave36 season board cards', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('headline + card + list + present', () => {
    expect(seasonBoardHeadline([]).empty).toBe(true);
    expect(seasonCard([], 'x').present).toBe(false);
    expect(listSeasonCards([])).toEqual([]);
    const rows = [mk('a', 'live'), mk('b', 'ended')];
    expect(seasonBoardHeadline(rows).live).toBe(1);
    expect(seasonCard(rows, 'a').writable).toBe(true);
    expect(listSeasonCards(rows)).toHaveLength(2);
    expect(seasonPresent(rows, 'b')).toBe(true);
  });
});

describe('L3 wave37 season filters + search', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('filter/search/writable/terminal cards', () => {
    expect(filterSeasonCardsByStatus([], 'live')).toEqual([]);
    expect(searchSeasonIds([], 'a')).toEqual([]);
    const rows = [mk('alpha-live', 'live'), mk('beta-ended', 'ended')];
    expect(filterSeasonCardsByStatus(rows, 'live')).toHaveLength(1);
    expect(searchSeasonIds(rows, 'alpha')).toEqual(['alpha-live']);
    expect(listWritableSeasonCards(rows)).toHaveLength(1);
    expect(listTerminalSeasonCards(rows)).toHaveLength(1);
  });
});

describe('L3 wave38 season paging', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('page ids + reverse + page count', () => {
    expect(pageSeasonIds([], { limit: 1 })).toEqual([]);
    expect(seasonListPageCount([], 5)).toBe(0);
    const rows = [mk('a', 'live'), mk('b', 'ended'), mk('c', 'live')];
    expect(pageSeasonIds(rows, { offset: 0, limit: 2 })).toHaveLength(2);
    expect(pageLiveSeasonIds(rows, { limit: 10 })).toEqual(['a', 'c']);
    expect(seasonListPageCount(rows, 2)).toBe(2);
    expect(reverseSeasonIds(rows)[0]).toBe('c');
  });
});

describe('L3 wave39 season diffs', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('id diffs + live delta + same size', () => {
    const left = [mk('a', 'live'), mk('b', 'ended')];
    const right = [mk('b', 'live'), mk('c', 'scheduled')];
    expect(seasonIdsOnlyLeft(left, right)).toEqual(['a']);
    expect(seasonIdsInBoth(left, right)).toEqual(['b']);
    expect(liveSeasonCountDelta(left, right)).toBe(0);
    expect(seasonsSameSize(left, right)).toBe(true);
  });
});

describe('L3 wave40 season safe paging', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('safe page + clamp + at page + valid', () => {
    expect(safePageSeasonIds([], 0, 1)).toEqual([]);
    expect(isValidSeasonPage([], 0, 1)).toBe(false);
    const rows = [mk('a', 'live'), mk('b', 'ended')];
    expect(safePageSeasonIds(rows, 0, 1)).toHaveLength(1);
    expect(clampSeasonPageIndex(rows, 99, 1)).toBe(1);
    expect(seasonIdsAtPage(rows, 0, 1)).toHaveLength(1);
    expect(isValidSeasonPage(rows, 0, 1)).toBe(true);
  });
});

describe('L3 wave41 seasons export', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('export lines/text/count', () => {
    expect(seasonsExportLines([])).toEqual([]);
    expect(seasonsExportHeader()).toBe('id,status');
    const rows = [mk('a', 'live')];
    expect(seasonsExportLines(rows)).toEqual(['a,live']);
    expect(seasonsExportText(rows)).toContain('id,status');
    expect(seasonsExportLineCount(rows)).toBe(2);
  });
});

describe('L3 wave42 seasons export parse', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('parse + header + round-trip', () => {
    expect(parseSeasonsExportLine('id,status')).toBeNull();
    expect(parseSeasonsExportLine('a,live')).toEqual({ id: 'a', status: 'live' });
    const rows = [mk('a', 'live')];
    const text = seasonsExportText(rows);
    expect(seasonsExportHasHeader(text)).toBe(true);
    expect(countSeasonsExportDataLines(text)).toBe(1);
    expect(seasonsExportRoundTripOk(rows)).toBe(true);
  });
});

describe('L3 wave44 season status lines', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('status lines', () => {
    expect(seasonStatusLineIsEmpty([])).toBe(true);
    const rows = [mk('a', 'live'), mk('b', 'ended')];
    expect(seasonStatusLine(rows)).toContain('live=1');
    expect(seasonStatusLineDetailed(rows)).toContain('writable=1');
    expect(seasonStatusLineTokenCount(rows)).toBe(6);
  });
});

describe('L3 wave45 season status parse', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('parse + match + consistent', () => {
    expect(parseSeasonStatusLine('total=0 live=0 open=0 ended=0')).toEqual({ total: 0, live: 0, open: 0, ended: 0 });
    expect(seasonStatusLineMatches([])).toBe(true);
    const rows = [mk('a', 'live'), mk('b', 'ended')];
    expect(seasonStatusLineMatches(rows)).toBe(true);
    expect(seasonStatusLineDetailedConsistent(seasonStatusLineDetailed(rows))).toBe(true);
  });
});

describe('L3 wave46 season thresholds', () => {
  const mk = (id: string, status: 'scheduled' | 'live' | 'frozen' | 'ended'): import('./ladder.js').SeasonRecord => ({
    id,
    slug: id,
    title: id,
    status,
    rulesSummary: 'non-money',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: null,
  });
  it('range + atLeast + clamp + ratio', () => {
    expect(seasonCountInRange([], 0, 0)).toBe(true);
    const rows = [mk('a', 'live'), mk('b', 'ended')];
    expect(liveSeasonCountAtLeast(rows, 1)).toBe(true);
    expect(clampSeasonPageSize(rows, 99)).toBe(2);
    expect(openSeasonRatioAtLeast(rows, 0.5)).toBe(true);
  });
});
