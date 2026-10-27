import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, KeyValue, Page, PageHeader, PageSection, Table } from '@intafaced/ui';
import type { TableColumn } from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { useApi, useSession } from '../../../features/session/session';
import { displayAmount } from '../../../shared/money';
import { createRoomApi, type LeaderProfile, type LeaderRow, type LeaderTrade } from './api';
import { roomCopy } from './copy';
import { bpsText } from './desk';
import { daysSince, MODE_WORD, roomLeft } from './LeaderDirectory';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, ModeNav, RefusalNote } from './parts';

const METRIC_WORD: Record<LeaderProfile['metrics'][number]['key'], string> = {
  publishedReturn: 'Published return',
  maximumDrawdown: 'Largest drop',
  winRate: 'Win rate',
  sharpeRatio: 'Sharpe ratio',
};

/** A signed percent to two places, rounded half up, for display only: "-10.004" is "−10.00%". */
export function percentText(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (Number((fraction + '000').charAt(2)) >= 5) cents += 1n;
  const text = `${displayAmount((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
  return `${negative && cents > 0n ? '−' : ''}${text}%`;
}

/** A listed leader's own page: the facts the platform published, what each figure means, and the leader's real trades. */
export function LeaderPage({ leaderRef, onFollow }: { leaderRef: string; onFollow: (leader: LeaderRow) => void }) {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const { session } = useSession();
  const api = useMemo(() => createRoomApi(transport), [transport]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const profile = useLive((signal) => api.leaderProfile(leaderRef, signal), `copy-leader:${leaderRef}`, 60_000);
  const trades = useLive(
    (signal) => api.leaderTrades(leaderRef, cursor, signal),
    `copy-leader-trades:${leaderRef}:${cursor ?? ''}`,
    60_000,
  );
  const leader = profile.data?.leader ?? null;
  const na = t('Not published');
  const notSet = t('Not set by the platform');

  const tradeColumns: TableColumn<LeaderTrade>[] = [
    { id: 'symbol', header: t('Market'), value: (r) => r.symbol, pin: 'start', width: 120 },
    {
      id: 'state',
      header: t('State'),
      cell: (r) => <Badge tone={r.state === 'open' ? 'lime' : 'neutral'}>{r.state === 'open' ? t('Open') : t('Closed')}</Badge>,
    },
    { id: 'opened', header: t('Opened'), value: (r) => (r.openedAt ? new Date(r.openedAt).toLocaleString() : t('Before this record')) },
    {
      id: 'entry',
      header: t('Entry price'),
      numeric: true,
      value: (r) => r.entryPrice,
      cell: (r) => (r.entryPrice ? displayAmount(r.entryPrice) : t('Unknown')),
    },
    { id: 'qty', header: t('Amount'), numeric: true, value: (r) => r.qty, cell: (r) => displayAmount(r.qty) },
    {
      id: 'margin',
      header: t('Margin'),
      numeric: true,
      value: (r) => r.margin,
      cell: (r) => (r.margin ? displayAmount(r.margin) : t('Unknown')),
    },
    {
      id: 'tpsl',
      header: t('TP / SL'),
      value: (r) =>
        r.takeProfit || r.stopLoss
          ? `${r.takeProfit ? displayAmount(r.takeProfit) : '—'} / ${r.stopLoss ? displayAmount(r.stopLoss) : '—'}`
          : t('None set'),
    },
    {
      id: 'close',
      header: t('Close price'),
      numeric: true,
      value: (r) => r.closePrice,
      cell: (r) => (r.closePrice ? displayAmount(r.closePrice) : t('Still open')),
    },
    {
      id: 'roi',
      header: t('Return before fees'),
      numeric: true,
      value: (r) => r.roiPercent,
      cell: (r) => (r.roiPercent === null ? '—' : percentText(r.roiPercent)),
    },
  ];

  const back = (
    <Button variant="secondary" onClick={() => navigate('/trade/copy')}>
      {t('All leaders')}
    </Button>
  );

  if (profile.status === 'error' && profile.failure) {
    return (
      <Page width="full" className="cb-page">
        <ModeNav active="copy" />
        <PageHeader title={t('Leader')} actions={back} />
        <RefusalNote failure={profile.failure} retry={profile.reload} />
      </Page>
    );
  }

  return (
    <Page width="full" className="cb-page">
      <ModeNav active="copy" />
      <PageHeader
        title={leader?.displayName ?? t('Leader')}
        description={t('What the platform published about this leader, and the leader’s own trades.')}
        meta={
          <span className="cb-meta">
            <AccountBadge paper={false} />
            {leader ? <Badge tone="neutral">{t(MODE_WORD[leader.marketMode] as 'Spot')}</Badge> : null}
            {leader ? (
              <Badge tone={leader.recordKind === 'verified_live' ? 'lime' : 'warn'}>
                {leader.recordKind === 'verified_live' ? t('Verified live') : t('Not verified')}
              </Badge>
            ) : null}
            <Freshness live={profile} staleAfterMs={120_000} />
          </span>
        }
        actions={
          <span className="cb-meta">
            {back}
            <Button onClick={() => leader && onFollow(leader)} disabled={!leader || !session}>
              {t('Start copying')}
            </Button>
          </span>
        }
      />

      <PageSection title={t('About this leader')} headingLevel={2}>
        <KeyValue
          items={[
            { label: t('Days trading'), value: leader ? (daysSince(leader.tenureStart) ?? na) : null },
            { label: t('Copiers'), value: leader ? String(leader.copiersCount) : null },
            { label: t('Room left'), value: leader ? (roomLeft(leader) ?? na) : null },
            { label: t('Leader’s share of the fee'), value: leader ? (bpsText(leader.leaderShareBps.value) ?? t('Not approved')) : null },
            { label: t('Markets traded'), value: leader ? (leader.assets.length ? leader.assets.join(', ') : na) : null },
          ]}
        />
      </PageSection>

      <PageSection title={t('Performance')} headingLevel={2}>
        <dl className="cb-metrics">
          {(profile.data?.metrics ?? []).map((m) => (
            <div key={m.key} data-testid="cb-metric" className="cb-metric" data-metric={m.key}>
              <dt>{t(METRIC_WORD[m.key] as 'Win rate')}</dt>
              <dd>
                {m.definition === null ? (
                  notSet
                ) : (
                  <>
                    <strong>{m.value === null ? (m.reason === 'not_held' ? notSet : na) : `${m.value}%`}</strong>
                    <span className="cb-metric-def">{m.definition}</span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <InfoNote>{t('Figures are shown as the leader published them, not ranked or scored.')}</InfoNote>
      </PageSection>

      <PageSection title={t('Trades')} headingLevel={2} actions={<Freshness live={trades} staleAfterMs={120_000} />}>
        <Table
          label={t('Leader trades')}
          columns={tradeColumns}
          rows={trades.data?.trades ?? []}
          getRowId={(r) => r.tradeId}
          status={trades.status === 'loading' ? 'loading' : trades.status === 'error' ? 'error' : 'ready'}
          refreshing={trades.refreshing && trades.data !== null}
          onRetry={trades.reload}
          minWidth={900}
          errorState={trades.failure ? <RefusalNote failure={trades.failure} retry={trades.reload} /> : undefined}
          emptyState={
            <EmptyState size="inline" title={t('No trades on record')} reason={t('This leader has not traded on a live spot market.')} />
          }
        />
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
            {t('Newer')}
          </Button>
          <Button
            variant="secondary"
            size={28}
            disabled={!trades.data?.nextCursor}
            onClick={() => {
              setPrevious((p) => [...p, cursor]);
              setCursor(trades.data?.nextCursor ?? null);
            }}
          >
            {t('Older')}
          </Button>
        </span>
        <InfoNote>{t('Spot trades: margin is what the leader paid, with no leverage. Buys and sells are paired oldest first.')}</InfoNote>
      </PageSection>
    </Page>
  );
}
