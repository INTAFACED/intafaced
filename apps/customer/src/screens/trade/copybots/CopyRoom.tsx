import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  KeyValue,
  Page,
  PageHeader,
  PageSection,
  StatusChip,
  Switch,
  Table,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@intafaced/ui';
import type { TableColumn } from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { useApi, useSession } from '../../../features/session/session';
import { createTradeApi } from '../../../features/trade/trade-api';
import { displayAmount } from '../../../shared/money';
import { createRoomApi } from './api';
import { roomCopy } from './copy';
import { bpsText, deskState } from './desk';
import { FollowWizard } from './FollowWizard';
import { FollowDetail, STATE_TONE, quoteAsset, stateWord, type Follow } from './FollowDetail';
import { useWriteGuard } from './guard';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, ModeNav, PendingBanner, RefusalNote } from './parts';

type TabId = 'leaders' | 'follows' | 'rules';
const TABS: readonly TabId[] = ['leaders', 'follows', 'rules'];

/** A row of the leader directory. The service has no directory (see TRCOPY-BACKEND-NEEDS), so this stays empty and says why. */
interface LeaderRow {
  id: string;
  name: string;
  record: 'live' | 'paper' | 'backtest';
  tenureDays: string;
  return30d: string | null;
  maxDrawdown: string | null;
  assets: string | null;
  copiers: string;
  leaderShare: string | null;
  capacityLeft: string | null;
}
const NO_LEADERS: readonly LeaderRow[] = [];

export function CopyRoom({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const { session } = useSession();
  const api = useMemo(() => createRoomApi(transport), [transport]);
  const tradeApi = useMemo(() => createTradeApi(transport), [transport]);
  const params = new URL(path, 'http://x').searchParams;
  const requested = params.get('tab');
  const tab: TabId = TABS.find((id) => id === requested) ?? 'leaders';
  const setTab = (id: string) => navigate(`/trade/copy?tab=${id}`, true);

  const desk = useLive((signal) => api.copyDesk(signal), 'copy-desk', 30_000);
  const follows = useLive((signal) => api.follows(signal), `copy-follows:${session ? 'in' : 'out'}`, 15_000);
  const markets = useLive((signal) => tradeApi.markets(signal), 'copy-markets', 300_000);
  const guard = useWriteGuard();
  const state = deskState(desk.data);

  const [wizard, setWizard] = useState<{ open: boolean; leader: string }>({ open: false, leader: '' });
  const [openFollowId, setOpenFollowId] = useState<string | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  const spot = (markets.data ?? [])
    .filter((m) => m.spot && m.active && !m.paper)
    .sort((a, b) => Number(b.quote === 'USDT') - Number(a.quote === 'USDT'));
  const openFollow = follows.data?.find((f) => f.followId === openFollowId) ?? null;

  const check = async () => {
    const pending = guard.pending;
    if (!pending) return;
    if (pending.kind !== 'copy') {
      // Another room's unconfirmed request: only its own room can settle it, so nothing is cleared here.
      setVerdict(t('That request belongs to the spot desk or another room. Check it there; it stays locked until then.'));
      return;
    }
    setChecking(true);
    const fresh = await api.follows();
    setChecking(false);
    if (!fresh.ok) {
      setVerdict(t('We could not check right now. Try again in a moment.'));
      return;
    }
    follows.reload();
    if (pending.id.startsWith('follow:')) {
      const leader = pending.id.slice('follow:'.length, pending.id.lastIndexOf(':'));
      const found = fresh.data.some((f) => f.leaderId === leader && ['ACTIVE', 'PAUSED'].includes(f.relationshipState.toUpperCase()));
      setVerdict(
        found
          ? t('The follow was created. It is in My follows.')
          : t('No follow exists for that leader, so the request did not go through.'),
      );
    } else {
      const row = fresh.data.find((f) => f.followId === pending.id);
      setVerdict(
        row
          ? t('That follow is now {state}.', { state: t(stateWord(row.relationshipState) as 'Active') })
          : t('That follow is no longer in your list.'),
      );
    }
    guard.settle(pending);
  };

  const leaderColumns: TableColumn<LeaderRow>[] = [
    { id: 'name', header: t('Leader'), value: (r) => r.name, sortable: true, pin: 'start', width: 180 },
    {
      id: 'record',
      header: t('Record'),
      cell: (r) => (
        <Badge tone={r.record === 'live' ? 'lime' : 'warn'}>
          {r.record === 'live' ? t('Verified live') : r.record === 'paper' ? t('Paper') : t('Backtest')}
        </Badge>
      ),
    },
    { id: 'tenure', header: t('Days trading'), value: (r) => r.tenureDays, numeric: true, sortable: true },
    { id: 'ret', header: t('Return 30 days'), value: (r) => r.return30d, numeric: true, sortable: true },
    { id: 'dd', header: t('Largest drop'), value: (r) => r.maxDrawdown, numeric: true, sortable: true },
    { id: 'aum', header: t('Assets copied'), value: (r) => r.assets, numeric: true, sortable: true },
    { id: 'cop', header: t('Copiers'), value: (r) => r.copiers, numeric: true, sortable: true },
    { id: 'share', header: t('Fee share'), value: (r) => r.leaderShare, numeric: true },
    { id: 'cap', header: t('Room left'), value: (r) => r.capacityLeft, numeric: true },
    {
      id: 'go',
      header: t('Follow'),
      headerLabel: t('Follow'),
      cell: (r) => (
        <Button size={28} onClick={() => setWizard({ open: true, leader: r.id })}>
          {t('Follow')}
        </Button>
      ),
    },
  ];

  const followColumns: TableColumn<Follow>[] = [
    { id: 'leader', header: t('Leader'), value: (r) => r.leaderId, sortable: true, pin: 'start', width: 180 },
    { id: 'markets', header: t('Markets'), value: (r) => r.permittedMarkets.join(', ') },
    {
      id: 'state',
      header: t('State'),
      cell: (r) => (
        <Badge tone={STATE_TONE[r.relationshipState.toUpperCase()] ?? 'neutral'}>{t(stateWord(r.relationshipState) as 'Active')}</Badge>
      ),
    },
    {
      id: 'used',
      header: t('Used'),
      value: (r) => r.currentExposure,
      numeric: true,
      sortable: true,
      cell: (r) => `${displayAmount(r.currentExposure)} ${quoteAsset(r)}`.trim(),
    },
    {
      id: 'left',
      header: t('Left to use'),
      value: (r) => r.remainingExposure,
      numeric: true,
      sortable: true,
      cell: (r) => `${displayAmount(r.remainingExposure)} ${quoteAsset(r)}`.trim(),
    },
    {
      id: 'cap',
      header: t('Most in total'),
      value: (r) => r.maxAggregateExposure,
      numeric: true,
      cell: (r) => `${displayAmount(r.maxAggregateExposure)} ${quoteAsset(r)}`.trim(),
    },
    { id: 'ends', header: t('Permission ends'), value: (r) => new Date(r.expiresAt).toLocaleDateString() },
    {
      id: 'open',
      header: t('Manage'),
      headerLabel: t('Manage'),
      cell: (r) => (
        <Button variant="secondary" size={28} onClick={() => setOpenFollowId(r.followId)}>
          {t('Manage')}
        </Button>
      ),
    },
  ];

  const leaderFilter = search.trim().toLowerCase();
  const leaders = NO_LEADERS.filter(
    (r) =>
      (!verifiedOnly || r.record === 'live') &&
      (!leaderFilter || r.name.toLowerCase().includes(leaderFilter) || r.id.toLowerCase().includes(leaderFilter)),
  );

  return (
    <Page width="full" className="cb-page">
      <ModeNav active="copy" />
      <PageHeader
        title={t('Copy trading')}
        description={t(
          'You choose a leader and your own limits. A leader’s order is only a suggestion: every copied order passes your account’s normal checks.',
        )}
        meta={
          <span className="cb-meta">
            <AccountBadge paper={false} />
            {desk.status === 'loading' ? (
              <StatusChip kind="unknown" reason={t('Waiting for the first read')} />
            ) : state ? (
              <StatusChip
                kind={state.open ? 'live' : 'refused'}
                labels={{ live: t('Copy desk open'), refused: t('Copy desk closed') }}
                reason={state.reasons[0]}
              />
            ) : (
              <StatusChip kind="unknown" labels={{ unknown: t('Copy desk unknown') }} reason={t('Could not be read')} />
            )}
            <Freshness live={desk} staleAfterMs={90_000} />
          </span>
        }
        actions={
          <Button onClick={() => setWizard({ open: true, leader: '' })} disabled={!session}>
            {t('Follow by leader ID')}
          </Button>
        }
      />

      <PendingBanner guard={guard} check={() => void check()} checking={checking} verdict={verdict} onDismiss={() => setVerdict(null)} />

      {desk.status === 'error' && desk.failure ? <RefusalNote failure={desk.failure} retry={desk.reload} /> : null}
      {state && !state.open ? (
        <div className="cb-note" role="note" data-tone="warn">
          <div>
            <p className="cb-note-title">{t('Copy trading is closed right now')}</p>
            <ul className="cb-reasons">
              {state.reasons.map((reason) => (
                <li key={reason}>{t(reason as 'Automatic copying of leader orders is switched off')}</li>
              ))}
            </ul>
            <p className="cb-note-body">
              {t('You can still set everything up and manage follows you already have. A new follow is refused until it opens.')}
            </p>
          </div>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList divider aria-label={t('Copy trading sections')}>
          <TabsTab value="leaders">{t('Leaders')}</TabsTab>
          <TabsTab value="follows">{t('My follows')}</TabsTab>
          <TabsTab value="rules">{t('Rules and fees')}</TabsTab>
        </TabsList>

        <TabsPanel value="leaders">
          <PageSection title={t('Leader directory')} headingLevel={2}>
            <div className="cb-toolbar">
              <Input
                kind="text"
                value={search}
                onValueChange={setSearch}
                aria-label={t('Search leaders')}
                placeholder={t('Search by name or ID')}
              />
              <label className="cb-switch">
                <Switch checked={verifiedOnly} onCheckedChange={setVerifiedOnly} aria-label={t('Verified live record only')} />
                <span>{t('Verified live record only')}</span>
              </label>
            </div>
            <Table
              label={t('Leaders')}
              columns={leaderColumns}
              rows={leaders}
              getRowId={(r) => r.id}
              minWidth={980}
              emptyState={
                <EmptyState
                  size="inline"
                  variant="unavailable"
                  title={t('No leaders are listed')}
                  reason={t(
                    'There is no published leader directory, so nobody is listed or ranked. If a leader gave you their ID, you can follow them directly.',
                  )}
                  action={{ label: t('Follow by leader ID'), onClick: () => setWizard({ open: true, leader: '' }), variant: 'secondary' }}
                />
              }
            />
            <InfoNote>{t('Leaders are never ranked by profit. A leader’s return is shown as a fact, not a score.')}</InfoNote>
          </PageSection>
        </TabsPanel>

        <TabsPanel value="follows">
          <PageSection
            title={t('Your follows')}
            headingLevel={2}
            actions={
              <span className="cb-meta">
                <Freshness live={follows} staleAfterMs={45_000} />
                <Button variant="ghost" size={28} onClick={follows.reload}>
                  {t('Refresh')}
                </Button>
              </span>
            }
          >
            {!session ? (
              <EmptyState
                variant="refused"
                reason={t('Sign in to see the leaders you follow.')}
                title={t('You are signed out')}
                action={{ label: t('Sign in'), href: '/login?redirect=%2Ftrade%2Fcopy%3Ftab%3Dfollows' }}
              />
            ) : (
              <Table
                label={t('My follows')}
                columns={followColumns}
                rows={follows.data ?? []}
                getRowId={(r) => r.followId}
                status={follows.status === 'loading' ? 'loading' : follows.status === 'error' ? 'error' : 'ready'}
                refreshing={follows.refreshing && follows.data !== null}
                onRetry={follows.reload}
                onRowActivate={(r) => setOpenFollowId(r.followId)}
                minWidth={900}
                errorState={follows.failure ? <RefusalNote failure={follows.failure} retry={follows.reload} /> : undefined}
                emptyState={
                  <EmptyState
                    size="inline"
                    title={t('You aren’t following anyone')}
                    reason={t('When you follow a leader, it appears here with its limits, state and controls.')}
                    action={{ label: t('Find a leader'), onClick: () => setTab('leaders'), variant: 'secondary' }}
                  />
                }
              />
            )}
            {follows.status === 'ready' && follows.failure ? <RefusalNote failure={follows.failure} retry={follows.reload} /> : null}
            <InfoNote>{t('Stopping or leaving never sells your positions. Close copied positions is a separate choice.')}</InfoNote>
          </PageSection>
        </TabsPanel>

        <TabsPanel value="rules">
          <PageSection title={t('Rules and fees')} headingLevel={2}>
            <KeyValue
              items={[
                { label: t('How a leader is paid'), value: t('From the trading fee, never from your profit') },
                {
                  label: t('Leader’s share of the fee'),
                  value: desk.data ? (bpsText(desk.data.leaderShareBps) ?? t('Not approved')) : null,
                },
                { label: t('Your trading fee'), value: t('The same as trading alone') },
                { label: t('Ranking'), value: t('Leaders are not ranked by profit') },
                { label: t('Your limits'), value: t('You set them. A leader can never raise them') },
                { label: t('Stopping'), value: t('New copies stop; open positions stay yours') },
                {
                  label: t('Countries'),
                  value: desk.data
                    ? desk.data.jurisdictionPublished
                      ? t('A country list is published')
                      : t('Not approved, so new follows are refused')
                    : null,
                },
                {
                  label: t('Automatic copying'),
                  value: desk.data?.autoMirrorPlace ? (desk.data.autoMirrorPlace.published ? t('On') : t('Off')) : null,
                },
              ]}
            />
            <InfoNote>
              {t(
                'Copy trading can lose money. A leader’s past return is not a promise. Only copy what you can afford to lose, and set a loss limit.',
              )}
            </InfoNote>
          </PageSection>
        </TabsPanel>
      </Tabs>

      <FollowWizard
        open={wizard.open}
        onOpenChange={(open) => setWizard((w) => ({ ...w, open }))}
        api={api}
        guard={guard}
        desk={desk.data}
        markets={spot}
        initialLeader={wizard.leader}
        onFollowed={() => {
          follows.reload();
          setTab('follows');
        }}
      />
      <FollowDetail follow={openFollow} onClose={() => setOpenFollowId(null)} api={api} guard={guard} onChanged={follows.reload} />
    </Page>
  );
}
