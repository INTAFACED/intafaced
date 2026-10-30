import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  KeyValue,
  Page,
  PageHeader,
  PageSection,
  StatusChip,
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
import { createRoomApi, type LeaderMode, type LeaderRow } from './api';
import { roomCopy } from './copy';
import { bpsText, deskState } from './desk';
import { FollowWizard } from './FollowWizard';
import { FollowDetail, STATE_TONE, quoteAsset, stateWord, type Follow } from './FollowDetail';
import { useWriteGuard } from './guard';
import { LeaderDirectory } from './LeaderDirectory';
import { LeaderPage } from './LeaderPage';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, ModeNav, PendingBanner, RefusalNote } from './parts';

type TabId = 'leaders' | 'futures' | 'spot' | 'bots' | 'signal' | 'follows' | 'rules';
const TABS: readonly TabId[] = ['leaders', 'futures', 'spot', 'bots', 'signal', 'follows', 'rules'];
/** The directory tabs and the market each one lists. Leaders lists every market. */
const TAB_MODE: Partial<Record<TabId, LeaderMode | null>> = {
  leaders: null,
  futures: 'futures',
  spot: 'spot',
  bots: 'bot',
  signal: 'signal',
};

/** `/trade/copy/<leaderRef>` is a leader's own page. */
export function leaderRefOf(pathname: string): string | null {
  const match = /^\/trade\/copy\/([^/]+)\/?$/.exec(pathname);
  if (!match || match[1] === 'following') return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** Who the follow wizard starts with: a typed leader ID, or a listed leader picked from the directory or their page. */
type WizardStart = { open: boolean; leader: string; listed: LeaderRow | null };

export function CopyRoom({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const leaderRef = leaderRefOf(new URL(path, 'http://x').pathname);
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

  const [wizard, setWizard] = useState<WizardStart>({ open: false, leader: '', listed: null });
  const followListed = (listed: LeaderRow) => setWizard({ open: true, leader: '', listed });
  const [openFollowId, setOpenFollowId] = useState<string | null>(null);
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
      const sentAt = Number(pending.id.slice(pending.id.lastIndexOf(':') + 1));
      // A leader typed by ID who turns out to be listed comes back named by its public ref only, so such a follow is
      // matched by being created after the request was sent (a minute's allowance for the two clocks).
      const found = fresh.data.some(
        (f) =>
          ['ACTIVE', 'PAUSED'].includes(f.relationshipState.toUpperCase()) &&
          (f.leaderRef === leader ||
            f.leaderId === leader ||
            (f.leaderId === null && f.createdAt !== undefined && Date.parse(f.createdAt) >= sentAt - 60_000)),
      );
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

  const followColumns: TableColumn<Follow>[] = [
    { id: 'leader', header: t('Leader'), value: (r) => r.leaderRef ?? r.leaderId, sortable: true, pin: 'start', width: 180 },
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

  const wizardNode = (
    <FollowWizard
      open={wizard.open}
      onOpenChange={(open) => setWizard((w) => ({ ...w, open }))}
      api={api}
      guard={guard}
      desk={desk.data}
      markets={spot}
      initialLeader={wizard.leader}
      listed={wizard.listed}
      onFollowed={() => {
        follows.reload();
        navigate('/trade/copy?tab=follows', true);
      }}
    />
  );
  if (leaderRef !== null) {
    return (
      <>
        <LeaderPage key={leaderRef} leaderRef={leaderRef} onFollow={followListed} />
        {wizardNode}
      </>
    );
  }

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
          <Button onClick={() => setWizard({ open: true, leader: '', listed: null })} disabled={!session}>
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
          <TabsTab value="futures">{t('Futures')}</TabsTab>
          <TabsTab value="spot">{t('Spot')}</TabsTab>
          <TabsTab value="bots">{t('Bots')}</TabsTab>
          <TabsTab value="signal">{t('Signal')}</TabsTab>
          <TabsTab value="follows">{t('My follows')}</TabsTab>
          <TabsTab value="rules">{t('Rules')}</TabsTab>
        </TabsList>

        <TabsPanel value="leaders">
          <PageSection title={t('Leader directory')} headingLevel={2}>
            {tab === 'leaders' ? <LeaderDirectory api={api} mode={TAB_MODE.leaders ?? null} onFollow={followListed} /> : null}
          </PageSection>
        </TabsPanel>
        <TabsPanel value="futures">
          <PageSection title={t('Futures leaders')} headingLevel={2}>
            {tab === 'futures' ? <LeaderDirectory api={api} mode={TAB_MODE.futures ?? null} onFollow={followListed} /> : null}
          </PageSection>
        </TabsPanel>
        <TabsPanel value="spot">
          <PageSection title={t('Spot leaders')} headingLevel={2}>
            {tab === 'spot' ? <LeaderDirectory api={api} mode={TAB_MODE.spot ?? null} onFollow={followListed} /> : null}
          </PageSection>
        </TabsPanel>
        <TabsPanel value="bots">
          <PageSection title={t('Bot leaders')} headingLevel={2}>
            {tab === 'bots' ? <LeaderDirectory api={api} mode={TAB_MODE.bots ?? null} onFollow={followListed} /> : null}
          </PageSection>
        </TabsPanel>
        <TabsPanel value="signal">
          <PageSection title={t('Signal leaders')} headingLevel={2}>
            {tab === 'signal' ? <LeaderDirectory api={api} mode={TAB_MODE.signal ?? null} onFollow={followListed} /> : null}
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
            <InfoNote>
              {t(
                'Leaving never sells your positions. After a stop, only the leader’s closes close what you copied. Close copied positions is a separate choice.',
              )}
            </InfoNote>
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
          </PageSection>
        </TabsPanel>
      </Tabs>

      {wizardNode}
      <FollowDetail follow={openFollow} onClose={() => setOpenFollowId(null)} api={api} guard={guard} onChanged={follows.reload} />
    </Page>
  );
}
