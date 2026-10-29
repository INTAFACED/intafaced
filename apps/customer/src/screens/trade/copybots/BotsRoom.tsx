import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Page,
  PageHeader,
  PageSection,
  Table,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type BadgeTone,
  type TableColumn,
} from '@intafaced/ui';
import { navigate } from '../../../app/location';
import { usePortfolio } from '../../../data';
import { useApi, useSession } from '../../../features/session/session';
import { createTradeApi } from '../../../features/trade/trade-api';
import { displayAmount } from '../../../shared/money';
import { createRoomApi, type BotListRow, type StudioStrategy } from './api';
import { BOT_TONE, BOT_WORD, BotDetail, percentFilled, type Algo, type Progress } from './BotDetail';
import { botName } from './bot-name';
import { roomCopy } from './copy';
import { algoServiceId, useWriteGuard, type Failure } from './guard';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, ModeNav, PendingBanner, RefusalNote } from './parts';
import { TwapWizard, type BotKind } from './TwapWizard';

type TabId = 'catalogue' | 'paper';
const TABS: readonly TabId[] = ['catalogue', 'paper'];
const SETUP_KINDS: readonly BotKind[] = ['twap', 'vwap', 'pov'];

/** A bot's kind as the hub and My bots name it. */
interface CatalogueRow {
  id: 'twap' | 'vwap' | 'pov' | 'grid' | 'dca' | 'studio';
  name: string;
  does: string;
  needs: string;
}
const CATALOGUE: readonly CatalogueRow[] = [
  {
    id: 'twap',
    name: 'Time-weighted (TWAP)',
    does: 'Splits one order into equal slices over a set time',
    needs: 'Market, side, amount, run time, gap between slices',
  },
  {
    id: 'vwap',
    name: 'Volume-weighted (VWAP)',
    does: 'Sizes slices to follow the market’s usual trading volume',
    needs: 'Same as TWAP, plus enough volume history',
  },
  {
    id: 'pov',
    name: 'Participation (POV)',
    does: 'Trades a fixed share of the market’s live volume',
    needs: 'Same as TWAP, plus a volume share',
  },
  {
    id: 'grid',
    name: 'Grid',
    does: 'Buys low and sells high inside a price range',
    needs: 'A price range, grid count, and a grid service',
  },
  {
    id: 'dca',
    name: 'Recurring buy (DCA)',
    does: 'Buys a fixed amount on a schedule',
    needs: 'An amount, a schedule, and a recurring-order service',
  },
  {
    id: 'studio',
    name: 'Strategy from Quant Studio',
    does: 'Runs your own rules on paper, with no money',
    needs: 'A saved strategy in Quant Studio',
  },
];

/** Each bot type in the hub, its own room or setup, and the name the hub gives it. */
const TYPE_LINK: Record<CatalogueRow['id'], { name: string; href: string }> = {
  twap: { name: 'Time-weighted (TWAP)', href: '/trade/bots?setup=twap' },
  vwap: { name: 'Volume-weighted (VWAP)', href: '/trade/bots?setup=vwap' },
  pov: { name: 'Participation (POV)', href: '/trade/bots?setup=pov' },
  grid: { name: 'Spot grid', href: '/trade/bots/grid' },
  dca: { name: 'Recurring buy (DCA)', href: '/trade/bots/dca' },
  studio: { name: 'Strategy from Quant Studio', href: '/trade/bots?tab=paper' },
};

type OpenBot = { algo: Algo | null; progress: Progress | null; failure: Failure | null };

/** Bot types with no engine yet: the room is reachable and says why nothing can be set up. */
const PARKED: Record<string, { title: string; reason: string }> = {
  '/trade/bots/grid': { title: 'Spot grid', reason: 'No grid service exists. Nothing is simulated.' },
  '/trade/bots/dca': { title: 'Recurring buy (DCA)', reason: 'No recurring-order service exists. Use Convert for a single trade.' },
};

export function BotsRoom({ path }: { path: string }) {
  const parked = PARKED[new URL(path, 'http://x').pathname.replace(/\/+$/, '')];
  return parked ? <ParkedBotRoom title={parked.title} reason={parked.reason} /> : <BotsHub path={path} />;
}

function ParkedBotRoom({ title, reason }: { title: string; reason: string }) {
  const { t } = roomCopy.useCopy();
  return (
    <Page width="full" className="cb-page">
      <ModeNav active="bots" />
      <PageHeader title={t(title as 'Spot grid')} description={t('This bot can’t be set up here.')} />
      <EmptyState
        variant="refused"
        title={t('Not available')}
        reason={t(reason as 'Spot grid')}
        action={{ label: t('Back to Bots'), href: '/trade/bots', variant: 'secondary' }}
      />
    </Page>
  );
}

function BotsHub({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const { session, userId } = useSession();
  const api = useMemo(() => createRoomApi(transport), [transport]);
  const tradeApi = useMemo(() => createTradeApi(transport), [transport]);
  const params = new URL(path, 'http://x').searchParams;
  const requested = params.get('tab');
  const tab: TabId = TABS.find((id) => id === requested) ?? 'catalogue';
  const setTab = (id: string) => navigate(`/trade/bots?tab=${id}`, true);

  const policy = useLive((signal) => api.algoPolicy(signal), 'bots-policy', 60_000);
  const markets = useLive((signal) => tradeApi.markets(signal), 'bots-markets', 300_000);
  const studio = useLive((signal) => api.studio(signal), 'bots-studio', 60_000);
  // My bots is the service's own list of this person's bots, so a new browser shows the same bots.
  const mine = useLive(
    (signal) => (session ? api.algoList(signal) : Promise.resolve({ ok: true as const, data: { rows: [], nextCursor: null } })),
    `bots-mine:${session ? (userId ?? 'in') : 'out'}`,
    10_000,
  );
  const openId = params.get('bot');
  const setOpenId = (id: string | null) => navigate(id ? `/trade/bots?bot=${encodeURIComponent(id)}` : '/trade/bots', true);
  const opened = useLive<OpenBot | null>(
    async (signal) => {
      if (!openId) return { ok: true, data: null };
      const [algo, progress] = await Promise.all([api.algoGet(openId, signal), api.algoProgress(openId, signal)]);
      return {
        ok: true,
        data: {
          algo: algo.ok ? algo.data : null,
          progress: progress.ok ? progress.data : null,
          failure: algo.ok ? (progress.ok ? null : progress) : algo,
        },
      };
    },
    `bots-open:${openId ?? 'none'}`,
    10_000,
  );
  const guard = useWriteGuard();
  const [wizard, setWizard] = useState<{ open: boolean; kind: BotKind }>({ open: false, kind: 'twap' });
  const [byId, setById] = useState('');
  const [byIdFailure, setByIdFailure] = useState<Failure | null>(null);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  const spot = (markets.data ?? []).filter((m) => m.spot && m.active && !m.paper && m.orderable);
  // The wizard asks for one asset's balance at a time; the data layer's balance read answers for the asset it is given.
  const balanceOf = useBalanceLookup();

  const open = opened.data;
  const setup = params.get('setup');
  useEffect(() => {
    const kind = SETUP_KINDS.find((k) => k === setup);
    if (kind) setWizard({ open: true, kind });
  }, [setup]);

  const openById = async () => {
    setByIdFailure(null);
    const id = byId.trim();
    if (!id) return;
    const result = await api.algoGet(id);
    if (!result.ok) {
      setByIdFailure(result);
      return;
    }
    setById('');
    setOpenId(result.data.id);
  };

  const check = async () => {
    const pending = guard.pending;
    if (!pending) return;
    if (pending.kind !== 'algo') {
      // Another room's unconfirmed request: only its own room can settle it, so nothing is cleared here.
      setVerdict(t('That request belongs to the spot desk or another room. Check it there; it stays locked until then.'));
      return;
    }
    setChecking(true);
    // A create is remembered by the id we chose; the service stores it as algo-<first 8 of your user id>-<that id>.
    const serviceId = algoServiceId(userId ?? null, pending);
    const result = await api.algoGet(serviceId);
    setChecking(false);
    if (result.ok) {
      setVerdict(
        pending.operation
          ? t('That bot is now {state}.', { state: t((BOT_WORD[result.data.status] ?? 'Unknown state') as 'Running') })
          : t('The bot was created. It is in My bots.'),
      );
      mine.reload();
      guard.settle(pending);
    } else if (result.code === 'trade.algo_not_found') {
      setVerdict(t('No bot exists with that request, so it did not go through. You can set it up again.'));
      guard.settle(pending);
    } else {
      setVerdict(t('We could not check right now. Try again in a moment.'));
    }
  };

  const catalogueStatus = (row: CatalogueRow): { tone: BadgeTone; word: string; reason: string | null; ready: boolean } => {
    if (row.id === 'twap' || row.id === 'vwap' || row.id === 'pov') {
      if (policy.data && !policy.data.capability.createEnabled)
        return { tone: 'warn', word: 'Switched off', reason: 'New bots can’t be created right now', ready: false };
      if (policy.data?.immatureKinds.includes(row.id))
        return {
          tone: 'warn',
          word: 'Needs trading history',
          reason: 'Volume history is still short. A slice may be refused when it is due.',
          ready: true,
        };
      return { tone: 'lime', word: policy.data ? 'Ready' : 'Checking', reason: null, ready: true };
    }
    if (row.id === 'studio')
      return { tone: 'warn', word: 'Paper only', reason: 'A strategy can’t trade live. It runs on paper.', ready: true };
    return {
      tone: 'neutral',
      word: 'Not built',
      reason:
        row.id === 'grid'
          ? 'No grid service exists. Nothing is simulated.'
          : 'No recurring-order service exists. Use Convert for a single trade.',
      ready: false,
    };
  };

  const catalogueColumns: TableColumn<CatalogueRow>[] = [
    { id: 'name', header: t('Bot'), value: (r) => t(r.name as 'Grid'), pin: 'start', width: 220 },
    { id: 'does', header: t('What it does'), cell: (r) => <span className="cb-wrap">{t(r.does as 'Grid')}</span>, width: 300 },
    { id: 'needs', header: t('What you provide'), cell: (r) => <span className="cb-wrap">{t(r.needs as 'Grid')}</span>, width: 300 },
    {
      id: 'status',
      header: t('Status'),
      cell: (r) => {
        const s = catalogueStatus(r);
        return (
          <span className="cb-statuscell">
            <Badge tone={s.tone}>{t(s.word as 'Ready')}</Badge>
            {s.reason ? <small>{t(s.reason as 'Ready')}</small> : null}
          </span>
        );
      },
      width: 260,
    },
    {
      id: 'go',
      header: t('Action'),
      headerLabel: t('Action'),
      cell: (r) => {
        const s = catalogueStatus(r);
        if (r.id === 'studio')
          return (
            <Button variant="secondary" size={28} onClick={() => setTab('paper')}>
              {t('See strategies')}
            </Button>
          );
        if (r.id === 'twap' || r.id === 'vwap' || r.id === 'pov')
          return (
            <Button size={28} disabled={!s.ready || !session} onClick={() => setWizard({ open: true, kind: r.id as BotKind })}>
              {t('Set up')}
            </Button>
          );
        return (
          <Button variant="secondary" size={28} disabled>
            {t('Not built')}
          </Button>
        );
      },
    },
  ];

  const nameOf = (r: BotListRow) => botName(r.kind, r.market, t);
  const mineColumns: TableColumn<BotListRow>[] = [
    {
      id: 'id',
      header: t('Bot'),
      value: nameOf,
      cell: (r) => <a href={`/trade/bots?bot=${encodeURIComponent(r.id)}`}>{nameOf(r)}</a>,
      pin: 'start',
      width: 200,
    },
    { id: 'side', header: t('Side'), value: (r) => (r.side === 'buy' ? t('Buy') : t('Sell')) },
    {
      id: 'status',
      header: t('State'),
      cell: (r) => <Badge tone={BOT_TONE[r.status] ?? 'neutral'}>{t((BOT_WORD[r.status] ?? 'Unknown state') as 'Running')}</Badge>,
    },
    {
      id: 'progress',
      header: t('Filled'),
      value: (r) => percentFilled(r.filledQty, r.totalQty)?.replace('%', '') ?? null,
      numeric: true,
      cell: (r) => percentFilled(r.filledQty, r.totalQty) ?? '—',
    },
    { id: 'total', header: t('Total'), value: (r) => r.totalQty, numeric: true, cell: (r) => displayAmount(r.totalQty) },
    { id: 'created', header: t('Started'), value: (r) => new Date(r.created).toLocaleString(), width: 200 },
    {
      id: 'open',
      header: t('Manage'),
      headerLabel: t('Manage'),
      cell: (r) => (
        <Button variant="secondary" size={28} onClick={() => setOpenId(r.id)}>
          {t('Manage')}
        </Button>
      ),
    },
  ];

  const paperColumns: TableColumn<StudioStrategy>[] = [
    { id: 'name', header: t('Strategy'), value: (r) => r.name, pin: 'start', width: 240 },
    { id: 'label', header: t('Kind'), cell: () => <Badge tone="warn">{t('Paper: not live performance')}</Badge>, width: 280 },
    { id: 'lang', header: t('Language'), value: (r) => r.language },
    { id: 'cash', header: t('Paper cash (TEST)'), value: (r) => r.cash, numeric: true, cell: (r) => displayAmount(r.cash) },
    {
      id: 'dd',
      header: t('Drawdown limit'),
      value: (r) => r.risk.maxDrawdown,
      numeric: true,
      cell: (r) => displayAmount(r.risk.maxDrawdown),
    },
    {
      id: 'not',
      header: t('Largest position'),
      value: (r) => r.risk.maxNotional,
      numeric: true,
      cell: (r) => displayAmount(r.risk.maxNotional),
    },
    { id: 'kill', header: t('Stops at a loss of'), value: (r) => r.risk.kill, numeric: true, cell: (r) => displayAmount(r.risk.kill) },
  ];

  const schedulerOff = policy.data !== null && !policy.data.capability.jobsEnabled;
  return (
    <Page width="full" className="cb-page">
      <ModeNav active="bots" />
      <PageHeader
        title={t('Bots')}
        description={t('Pick a bot, set its size and limits, see what it will cost before it starts, and stop it any time.')}
        meta={
          <span className="cb-meta">
            <AccountBadge paper={false} />
            <Freshness live={policy} staleAfterMs={180_000} />
          </span>
        }
      />
      <PendingBanner guard={guard} check={() => void check()} checking={checking} verdict={verdict} onDismiss={() => setVerdict(null)} />
      {policy.status === 'error' && policy.failure ? <RefusalNote failure={policy.failure} retry={policy.reload} /> : null}
      {schedulerOff ? (
        <InfoNote tone="warn">
          {t(
            'The scheduler that places slices is switched off in this environment. You can set up and watch bots, but no slice is placed until it runs.',
          )}
        </InfoNote>
      ) : null}

      <PageSection title={t('Bot types')} headingLevel={2}>
        <ul className="cb-types" aria-label={t('Bot types')}>
          {CATALOGUE.map((row) => {
            const s = catalogueStatus(row);
            const word = s.ready ? (row.id === 'studio' ? t('Available on paper only') : t('Available')) : null;
            return (
              <li key={row.id}>
                <a href={TYPE_LINK[row.id].href}>{t(TYPE_LINK[row.id].name as 'Spot grid')}</a>
                <span data-testid="bot-type-status">
                  {word ?? t('Not available: {reason}', { reason: t((s.reason ?? s.word) as 'Ready') })}
                </span>
              </li>
            );
          })}
        </ul>
      </PageSection>

      <PageSection
        title={t('My bots')}
        headingLevel={2}
        actions={
          <span className="cb-meta">
            <Freshness live={mine} staleAfterMs={45_000} />
            <Button variant="ghost" size={28} onClick={mine.reload}>
              {t('Refresh')}
            </Button>
          </span>
        }
      >
        {!session ? (
          <EmptyState
            variant="refused"
            title={t('You are signed out')}
            reason={t('Sign in to see your bots.')}
            action={{ label: t('Sign in'), href: '/login?redirect=%2Ftrade%2Fbots' }}
          />
        ) : (
          <>
            {mine.status === 'error' && mine.failure ? <RefusalNote failure={mine.failure} retry={mine.reload} /> : null}
            <Table
              label={t('My bots')}
              columns={mineColumns}
              rows={mine.data?.rows ?? []}
              getRowId={(r) => r.id}
              status={mine.status === 'loading' ? 'loading' : 'ready'}
              refreshing={mine.refreshing && mine.data !== null}
              onRowActivate={(r) => setOpenId(r.id)}
              minWidth={940}
              emptyState={
                <EmptyState
                  size="inline"
                  title={t('No bots')}
                  reason={t('Bots you start appear here, on every device you sign in on.')}
                  action={{ label: t('Set up a bot'), onClick: () => setTab('catalogue'), variant: 'secondary' }}
                />
              }
            />
            <form
              className="cb-byid"
              onSubmit={(event) => {
                event.preventDefault();
                void openById();
              }}
            >
              <Field label={t('Open a bot by ID')}>
                <Input kind="text" value={byId} onValueChange={setById} autoComplete="off" />
              </Field>
              <Button type="submit" variant="secondary" disabled={!byId.trim()}>
                {t('Open')}
              </Button>
            </form>
            {byIdFailure ? <RefusalNote failure={byIdFailure} /> : null}
          </>
        )}
      </PageSection>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList divider aria-label={t('Bot sections')}>
          <TabsTab value="catalogue">{t('Catalogue')}</TabsTab>
          <TabsTab value="paper">{t('Paper strategies')}</TabsTab>
        </TabsList>

        <TabsPanel value="catalogue">
          <PageSection title={t('Bot catalogue')} headingLevel={2}>
            <Table label={t('Bot catalogue')} columns={catalogueColumns} rows={CATALOGUE} getRowId={(r) => r.id} minWidth={1000} />
            <InfoNote>{t('Bots that are not built show their real status. Nothing here is simulated unless it says Paper.')}</InfoNote>
          </PageSection>
        </TabsPanel>

        <TabsPanel value="paper">
          <PageSection title={t('Paper strategies')} headingLevel={2} actions={<Freshness live={studio} staleAfterMs={180_000} />}>
            <InfoNote>
              {t('Paper strategies use pretend money. Their results are not live performance and are never shown as such.')}
            </InfoNote>
            <Table
              label={t('Paper strategies')}
              columns={paperColumns}
              rows={studio.data?.strategies ?? []}
              getRowId={(r) => r.id}
              status={studio.status === 'loading' ? 'loading' : studio.status === 'error' ? 'error' : 'ready'}
              onRetry={studio.reload}
              errorState={studio.failure ? <RefusalNote failure={studio.failure} retry={studio.reload} /> : undefined}
              minWidth={900}
              emptyState={
                <EmptyState
                  size="inline"
                  title={t('No paper strategies')}
                  reason={t('Write and save a strategy in Quant Studio and it appears here.')}
                  action={{ label: t('Open Quant Studio'), href: '/quant/studio', variant: 'secondary' }}
                />
              }
            />
            <KeyValue
              items={[
                { label: t('Running a strategy live'), value: t('Not built: a strategy cannot trade real money') },
                { label: t('Where to write one'), value: t('Quant Studio') },
              ]}
            />
            <div className="cb-action-row">
              <Button variant="secondary" render={<a href="/quant/studio" />} nativeButton={false}>
                {t('Open Quant Studio')}
              </Button>
            </div>
          </PageSection>
        </TabsPanel>
      </Tabs>

      <TwapWizard
        open={wizard.open}
        kind={wizard.kind}
        onOpenChange={(o) => {
          setWizard((w) => ({ ...w, open: o }));
          if (!o && setup) navigate('/trade/bots', true);
        }}
        api={api}
        guard={guard}
        policy={policy.data}
        markets={spot}
        available={balanceOf}
        onCreated={(algo) => {
          mine.reload();
          setOpenId(algo.id);
        }}
      />
      <BotDetail
        algo={open?.algo ?? null}
        progress={open?.progress ?? null}
        failure={open?.failure ?? null}
        onClose={() => setOpenId(null)}
        api={api}
        guard={guard}
        onChanged={() => {
          mine.reload();
          opened.reload();
        }}
      />
    </Page>
  );
}

/** Free balance by asset, from the data layer's portfolio read; null while it is unknown. */
function useBalanceLookup() {
  const portfolio = usePortfolio();
  return useCallback(
    (asset: string): string | null => {
      if (portfolio.status === 'empty') return '0';
      if (portfolio.status !== 'ready') return null;
      return portfolio.data.holdings.find((h) => h.asset === asset)?.available ?? '0';
    },
    [portfolio],
  );
}
