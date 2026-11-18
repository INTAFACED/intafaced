import { useState } from 'react';
import { Badge, EmptyState, KeyValue, PageSection, Table, Tabs, TabsList, TabsPanel, TabsTab, type TableColumn } from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import type { LeadCopier, LeadTrade, RoomApi } from './api';
import { roomCopy } from './copy';
import { useLive } from './live';
import { RefusalNote } from './parts';

const MISSION_TITLE = {
  apply: 'Apply to lead',
  fund: 'Hold the mission minimum on your venue account',
  listed: 'Be approved by two founders',
} as const;

/**
 * The lead's own account (J-copy-bots-otc-04 #3, #4 and #8; CB-copy-12, CB-copy-15, CB-copy-18): the new-trader missions
 * and their progress, the lead account once approved with its leading instrument list and the way to the lead trading
 * screen, the lead trades with their counts, and each copier's state. Every figure is the service's; nothing is counted
 * here.
 */
export function LeadAccount({ api }: { api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const missions = useLive((signal) => api.leadMissions(signal), 'copy-lead-missions', 15_000);
  const mine = useLive((signal) => api.myLead(signal), 'copy-my-lead', 15_000);
  const lead = mine.data ?? null;

  return (
    <>
      <PageSection title={t('New-trader missions')} headingLevel={2}>
        {missions.status === 'error' && missions.failure ? <RefusalNote failure={missions.failure} retry={missions.reload} /> : null}
        {missions.data ? (
          <>
            <p>{t('{done} of {total} missions done', { done: String(missions.data.done), total: String(missions.data.total) })}</p>
            <ul className="cb-reasons" aria-label={t('New-trader missions')}>
              {missions.data.missions.map((m) => (
                <li key={m.id}>
                  <strong>{t(MISSION_TITLE[m.id])}</strong>{' '}
                  <Badge tone={m.done ? 'lime' : 'neutral'} variant="outline" density="dense">
                    {m.done ? t('Done') : t('Not done')}
                  </Badge>{' '}
                  {t('{done} of {total}', { done: m.done ? '1' : '0', total: '1' })} · {m.detail}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </PageSection>

      <section aria-label={t('Your lead account')}>
        <PageSection title={t('Your lead account')} headingLevel={2}>
          {mine.status === 'error' && mine.failure ? <RefusalNote failure={mine.failure} retry={mine.reload} /> : null}
          {mine.status === 'ready' && !lead ? (
            <EmptyState
              size="inline"
              title={t('No lead account')}
              reason={t('Your lead account opens when two founders approve your application.')}
            />
          ) : null}
          {lead ? (
            <>
              <KeyValue
                items={[
                  { label: t('Lead account'), value: lead.leaderRef },
                  { label: t('Application'), value: lead.applicationId.slice(0, 8) },
                  { label: t('Display name'), value: lead.displayName },
                  { label: t('Listing'), value: lead.state },
                  {
                    label: t('Leading instruments'),
                    value: lead.instruments.length > 0 ? lead.instruments.join(', ') : t('Not set by the platform'),
                  },
                ]}
              />
              <p>
                <a href={`/trade/spot/${(lead.instruments[0] ?? 'BTC/USDT').replace('/', '-')}?lead=1`}>
                  {t('Open the lead trading screen')}
                </a>
              </p>
            </>
          ) : null}
        </PageSection>
      </section>

      {lead ? <LeadTrades api={api} /> : null}
    </>
  );
}

function LeadTrades({ api }: { api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const trades = useLive((signal) => api.leadTrades(signal), 'copy-lead-trades', 10_000);
  const copiers = useLive((signal) => api.leadCopiers(signal), 'copy-lead-copiers', 15_000);
  const [tab, setTab] = useState<'ongoing' | 'history'>('ongoing');

  const columns: TableColumn<LeadTrade>[] = [
    { id: 'order', header: t('Order'), value: (r) => r.orderId.slice(0, 8), pin: 'start' },
    { id: 'pair', header: t('Pair'), value: (r) => r.symbol },
    { id: 'side', header: t('Side'), value: (r) => (r.side === 'buy' ? t('Buy') : t('Sell')) },
    {
      id: 'price',
      header: t('Price'),
      numeric: true,
      value: (r) => r.price ?? '',
      cell: (r) => (r.price ? displayAmount(r.price) : t('Market')),
    },
    { id: 'amount', header: t('Amount'), numeric: true, value: (r) => r.amount, cell: (r) => displayAmount(r.amount) },
    { id: 'filled', header: t('Filled'), numeric: true, value: (r) => r.filled, cell: (r) => displayAmount(r.filled) },
    { id: 'status', header: t('Status'), value: (r) => r.status },
    { id: 'at', header: t('Time'), value: (r) => new Date(r.at).toLocaleString() },
  ];
  const copierColumns: TableColumn<LeadCopier>[] = [
    { id: 'follow', header: t('Copier'), value: (r) => `Copy ${r.followRef}`, pin: 'start' },
    { id: 'status', header: t('Status'), value: (r) => copierStatus(r.status) },
    { id: 'since', header: t('Since'), value: (r) => new Date(r.since).toLocaleString() },
  ];
  const copierStatus = (s: LeadCopier['status']) =>
    s === 'Active'
      ? t('Active')
      : s === 'Paused'
        ? t('Paused')
        : s === 'Stopping'
          ? t('Stopping')
          : s === 'Close only'
            ? t('Close only')
            : t('Stopped');
  const status = (s: string) => (s === 'loading' ? 'loading' : s === 'error' ? 'error' : 'ready');
  const counts = trades.data?.counts;

  return (
    <>
      <section aria-label={t('Lead trades')}>
        <PageSection title={t('Lead trades')} headingLevel={2}>
          {trades.status === 'error' && trades.failure ? <RefusalNote failure={trades.failure} retry={trades.reload} /> : null}
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'ongoing' | 'history')}>
            <TabsList aria-label={t('Lead trades')}>
              <TabsTab value="ongoing">{counts ? t('Ongoing ({n})', { n: String(counts.ongoing) }) : t('Ongoing')}</TabsTab>
              <TabsTab value="history">{counts ? t('History ({n})', { n: String(counts.history) }) : t('History')}</TabsTab>
            </TabsList>
            {(['ongoing', 'history'] as const).map((which) => (
              <TabsPanel key={which} value={which}>
                <Table
                  label={which === 'ongoing' ? t('Ongoing lead trades') : t('Lead trade history')}
                  columns={columns}
                  rows={trades.data?.[which] ?? []}
                  getRowId={(r) => r.orderId}
                  status={status(trades.status)}
                  onRetry={trades.reload}
                  minWidth={720}
                  emptyState={
                    <EmptyState
                      size="inline"
                      title={which === 'ongoing' ? t('No lead trade resting') : t('No lead trade in your history')}
                      reason={t('An order you place with Lead trade on shows here.')}
                    />
                  }
                />
              </TabsPanel>
            ))}
          </Tabs>
        </PageSection>
      </section>
      <PageSection title={t('Your copiers')} headingLevel={2}>
        <Table
          label={t('Your copiers')}
          columns={copierColumns}
          rows={copiers.data ?? []}
          getRowId={(r) => r.followRef}
          status={status(copiers.status)}
          onRetry={copiers.reload}
          minWidth={480}
          emptyState={<EmptyState size="inline" title={t('No copiers')} reason={t('Someone who copies you shows here.')} />}
        />
      </PageSection>
    </>
  );
}
