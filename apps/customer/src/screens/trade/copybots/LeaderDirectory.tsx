import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Input, Table } from '@intafaced/ui';
import type { TableColumn } from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { displayAmount } from '../../../shared/money';
import type { LeaderMode, LeaderRow, RoomApi } from './api';
import { roomCopy } from './copy';
import { bpsText } from './desk';
import type { Failure } from './guard';
import { useLive } from './live';
import { Freshness, InfoNote, RefusalNote } from './parts';

/** What each tab of the directory lists. The service filters; this screen never filters or sorts the rows again. */
export const MODE_WORD: Record<LeaderMode, string> = { spot: 'Spot', futures: 'Futures', bot: 'Bots', signal: 'Signal' };

/** The ranked boards other exchanges show. Each one is asked for, and the service's refusal is shown as it comes. */
const RANKINGS: readonly { label: string; ask: { category: string } | { trending: true } }[] = [
  { label: 'Top return', ask: { category: 'top_return' } },
  { label: 'Most copied', ask: { category: 'most_copied' } },
  { label: 'Trending', ask: { trending: true } },
];

export const leaderPath = (leaderRef: string) => `/trade/copy/${encodeURIComponent(leaderRef)}`;

export function daysSince(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const start = Date.parse(iso);
  if (Number.isNaN(start) || start > now) return null;
  return String(Math.floor((now - start) / 86_400_000));
}

/** Followers the leader can still take. Unpublished capacity is unknown, never unlimited. */
export function roomLeft(row: Pick<LeaderRow, 'capacity' | 'copiersCount'>): string | null {
  if (row.capacity.value === null) return null;
  return String(Math.max(0, row.capacity.value - row.copiersCount));
}

export function LeaderDirectory({
  api,
  mode,
  onFollow,
}: {
  api: RoomApi;
  /** null lists every mode. */
  mode: LeaderMode | null;
  onFollow: (leader: LeaderRow) => void;
}) {
  const { t } = roomCopy.useCopy();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [ranking, setRanking] = useState<{ label: string; failure: Failure | null } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  // A new search or tab starts again from the first page.
  useEffect(() => {
    setCursor(null);
    setPrevious([]);
  }, [mode, query]);

  const leaders = useLive(
    (signal) => api.leaders({ ...(mode ? { marketMode: mode } : {}), q: query, ...(cursor ? { cursor } : {}) }, signal),
    `copy-leaders:${mode ?? 'all'}:${query}:${cursor ?? ''}`,
    60_000,
  );

  const askRanking = async (item: (typeof RANKINGS)[number]) => {
    setRanking({ label: item.label, failure: null });
    const result = await api.rankedLeaders(item.ask);
    setRanking({ label: item.label, failure: result.ok ? null : result });
  };

  const na = t('Not published');
  const columns: TableColumn<LeaderRow>[] = [
    {
      id: 'name',
      header: t('Leader'),
      pin: 'start',
      width: 200,
      value: (r) => r.displayName,
      cell: (r) => (
        <a
          href={leaderPath(r.leaderRef)}
          onClick={(event) => {
            event.preventDefault();
            navigate(leaderPath(r.leaderRef));
          }}
        >
          {r.displayName}
        </a>
      ),
    },
    { id: 'mode', header: t('Market'), cell: (r) => <Badge tone="neutral">{t(MODE_WORD[r.marketMode] as 'Spot')}</Badge> },
    {
      id: 'record',
      header: t('Record'),
      cell: (r) => (
        <Badge tone={r.recordKind === 'verified_live' ? 'lime' : 'warn'}>
          {r.recordKind === 'verified_live' ? t('Verified live') : r.recordKind === 'paper' ? t('Paper') : t('Not verified')}
        </Badge>
      ),
    },
    { id: 'tenure', header: t('Days trading'), numeric: true, value: (r) => daysSince(r.tenureStart) },
    {
      id: 'ret',
      header: t('Published return'),
      numeric: true,
      value: (r) => r.publishedReturn.value,
      cell: (r) => (r.publishedReturn.value === null ? na : `${r.publishedReturn.value}%`),
    },
    {
      id: 'dd',
      header: t('Largest drop'),
      numeric: true,
      value: (r) => r.maximumDrawdown.value,
      cell: (r) => (r.maximumDrawdown.value === null ? na : `${r.maximumDrawdown.value}%`),
    },
    { id: 'cop', header: t('Copiers'), numeric: true, value: (r) => String(r.copiersCount) },
    {
      id: 'share',
      header: t('Fee share'),
      numeric: true,
      value: (r) => r.leaderShareBps.value,
      cell: (r) => bpsText(r.leaderShareBps.value) ?? t('Not approved'),
    },
    {
      id: 'cap',
      header: t('Room left'),
      numeric: true,
      value: (r) => roomLeft(r),
      cell: (r) => {
        const left = roomLeft(r);
        return left === null ? na : displayAmount(left);
      },
    },
    {
      id: 'go',
      header: t('Follow'),
      headerLabel: t('Follow'),
      cell: (r) => (
        <Button size={28} onClick={() => onFollow(r)} aria-label={t('Follow {name}', { name: r.displayName })}>
          {t('Follow')}
        </Button>
      ),
    },
  ];

  return (
    <>
      <div className="cb-toolbar">
        <Input
          kind="text"
          value={text}
          onValueChange={setText}
          aria-label={t('Search leaders')}
          placeholder={t('Search by name')}
          maxLength={80}
        />
        <Freshness live={leaders} staleAfterMs={120_000} />
      </div>
      <div className="cb-rankings" role="group" aria-label={t('Ranked lists')}>
        {RANKINGS.map((item) => (
          <Button key={item.label} variant="secondary" size={28} onClick={() => void askRanking(item)}>
            {t(item.label as 'Trending')}
          </Button>
        ))}
      </div>
      {ranking?.failure ? <RefusalNote failure={ranking.failure} /> : null}
      <Table
        label={t('Leaders')}
        columns={columns}
        rows={leaders.data?.leaders ?? []}
        getRowId={(r) => r.leaderRef}
        status={leaders.status === 'loading' ? 'loading' : leaders.status === 'error' ? 'error' : 'ready'}
        refreshing={leaders.refreshing && leaders.data !== null}
        onRetry={leaders.reload}
        minWidth={980}
        errorState={leaders.failure ? <RefusalNote failure={leaders.failure} retry={leaders.reload} /> : undefined}
        emptyState={
          <EmptyState
            size="inline"
            variant="empty"
            title={query ? t('No leader matches that name') : t('No leaders are listed')}
            reason={
              query
                ? t('Try another name, or clear the search.')
                : t('Leaders appear here once the platform lists them. If a leader gave you their ID, you can follow them directly.')
            }
          />
        }
      />
      {previous.length > 0 || leaders.data?.nextCursor ? (
        <span className="cb-meta">
          <Button
            variant="secondary"
            size={28}
            disabled={previous.length === 0}
            onClick={() => {
              setCursor(previous[previous.length - 1] ?? null);
              setPrevious((p) => p.slice(0, -1));
            }}
          >
            {t('Earlier')}
          </Button>
          <Button
            variant="secondary"
            size={28}
            disabled={!leaders.data?.nextCursor}
            onClick={() => {
              setPrevious((p) => [...p, cursor]);
              setCursor(leaders.data?.nextCursor ?? null);
            }}
          >
            {t('Later')}
          </Button>
        </span>
      ) : null}
      {leaders.status === 'ready' && leaders.failure ? <RefusalNote failure={leaders.failure} retry={leaders.reload} /> : null}
      <InfoNote>
        {t('Leaders are listed in the order they joined, never ranked by profit. A return is shown as the leader published it.')}
      </InfoNote>
    </>
  );
}
