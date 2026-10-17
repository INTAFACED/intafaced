import { useCallback, useMemo, useState } from 'react';
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
import { createRoomApi, type StudioStrategy } from './api';
import { BOT_TONE, BOT_WORD, BotDetail, percentFilled, type Algo, type Progress } from './BotDetail';
import { roomCopy } from './copy';
import { useWriteGuard, type Failure } from './guard';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, ModeNav, PendingBanner, RefusalNote } from './parts';
import { TwapWizard, type BotKind } from './TwapWizard';

type TabId = 'catalogue' | 'mine' | 'paper';
const TABS: readonly TabId[] = ['catalogue', 'mine', 'paper'];

type Ref = { id: string; symbol: string; kind: string; at: number };
const refsKey = (userId: string | null) => `bots-created:${userId ?? 'signed-out'}`;
function readRefs(key: string): Ref[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(
          (r): r is Ref =>
            typeof r === 'object' && r !== null && typeof (r as Ref).id === 'string' && typeof (r as Ref).symbol === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
function writeRefs(key: string, refs: Ref[]) {
  try {
    localStorage.setItem(key, JSON.stringify(refs.slice(0, 100)));
  } catch {
    /* the list is a convenience; the service still holds every schedule */
  }
}

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

interface BotRow {
  ref: Ref;
  algo: Algo | null;
  progress: Progress | null;
  failure: Failure | null;
}

export function BotsRoom({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const { session, userId } = useSession();
  const api = useMemo(() => createRoomApi(transport), [transport]);
  const tradeApi = useMemo(() => createTradeApi(transport), [transport]);
  const params = new URL(path, 'http://x').searchParams;
  const requested = params.get('tab');
  const tab: TabId = TABS.find((id) => id === requested) ?? 'catalogue';
  const setTab = (id: string) => navigate(`/trade/bots?tab=${id}`, true);

  const key = refsKey(userId ?? null);
  const [refs, setRefs] = useState<Ref[]>(() => readRefs(key));
  const remember = useCallback(
    (ref: Ref) => {
      const next = [ref, ...readRefs(key).filter((r) => r.id !== ref.id)];
      writeRefs(key, next);
      setRefs(next);
    },
    [key],
  );

  const policy = useLive((signal) => api.algoPolicy(signal), 'bots-policy', 60_000);
  const markets = useLive((signal) => tradeApi.markets(signal), 'bots-markets', 300_000);
  const studio = useLive((signal) => api.studio(signal), 'bots-studio', 60_000);
  const idsKey = refs.map((r) => r.id).join(',');
  const rows = useLive<BotRow[]>(
    async (signal) => {
      const out: BotRow[] = await Promise.all(
        refs.map(async (ref): Promise<BotRow> => {
          const [algo, progress] = await Promise.all([api.algoGet(ref.id, signal), api.algoProgress(ref.id, signal)]);
          return {
            ref,
            algo: algo.ok ? algo.data : null,
            progress: progress.ok ? progress.data : null,
            failure: algo.ok ? (progress.ok ? null : progress) : algo,
          };
        }),
      );
      return { ok: true, data: out };
    },
    `bots-rows:${session ? 'in' : 'out'}:${idsKey}`,
    10_000,
  );
  const guard = useWriteGuard();
  const [wizard, setWizard] = useState<{ open: boolean; kind: BotKind }>({ open: false, kind: 'twap' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [byId, setById] = useState('');
  const [byIdFailure, setByIdFailure] = useState<Failure | null>(null);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  const spot = (markets.data ?? []).filter((m) => m.spot && m.active && !m.paper && m.orderable);
  // The wizard asks for one asset's balance at a time; the data layer's balance read answers for the asset it is given.
  const balanceOf = useBalanceLookup();

  const open = rows.data?.find((r) => r.ref.id === openId) ?? null;

  const openById = async () => {
    setByIdFailure(null);
    const id = byId.trim();
    if (!id) return;
    const result = await api.algoGet(id);
    if (!result.ok) {
      setByIdFailure(result);
      return;
    }
    remember({ id: result.data.id, symbol: result.data.symbol, kind: result.data.kind, at: Date.now() });
    setById('');
    setOpenId(result.data.id);
    setTab('mine');
  };

  const check = async () => {
    const pending = guard.pending;
    if (!pending) return;
    setChecking(true);
    const result = await api.algoGet(pending.id);
    setChecking(false);
    if (result.ok) {
      remember({ id: result.data.id, symbol: result.data.symbol, kind: result.data.kind, at: Date.now() });
      setVerdict(
        pending.operation
          ? t('That bot is now {state}.', { state: t((BOT_WORD[result.data.status] ?? 'Unknown state') as 'Running') })
          : t('The bot was created. It is in My bots.'),
      );
      rows.reload();
      guard.clear();
    } else if (result.code === 'trade.algo_not_found') {
      setVerdict(t('No bot exists with that request, so it did not go through. You can set it up again.'));
      guard.clear();
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
      return { tone: 'warn', word: 'Paper only', reason: 'A strategy can’t trade live yet. It runs on paper.', ready: true };
    return {
      tone: 'neutral',
      word: 'Not built',
      reason:
        row.id === 'grid'
          ? 'No grid service exists yet. Nothing is simulated.'
          : 'No recurring-order service exists yet. Use Convert for a single trade.',
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

  const mineColumns: TableColumn<BotRow>[] = [
    { id: 'id', header: t('Bot'), value: (r) => `${(r.algo?.kind ?? r.ref.kind).toUpperCase()} ${r.ref.symbol}`, pin: 'start', width: 200 },
    { id: 'side', header: t('Side'), value: (r) => (r.algo ? (r.algo.side === 'buy' ? t('Buy') : t('Sell')) : null) },
    {
      id: 'status',
      header: t('State'),
      cell: (r) =>
        r.algo ? (
          <Badge tone={BOT_TONE[r.algo.status] ?? 'neutral'}>{t((BOT_WORD[r.algo.status] ?? 'Unknown state') as 'Running')}</Badge>
        ) : (
          <Badge tone="warn">{t('Can’t load')}</Badge>
        ),
    },
    {
      id: 'progress',
      header: t('Filled'),
      value: (r) => (r.algo && r.progress ? (percentFilled(r.progress.filledQty, r.algo.totalQty)?.replace('%', '') ?? null) : null),
      numeric: true,
      cell: (r) => (r.algo && r.progress ? (percentFilled(r.progress.filledQty, r.algo.totalQty) ?? '—') : '—'),
    },
    {
      id: 'slices',
      header: t('Slices placed'),
      value: (r) => (r.algo ? `${r.progress?.childrenEmitted ?? r.algo.childrenEmitted} / ${r.algo.slicesPlanned}` : null),
    },
    {
      id: 'total',
      header: t('Total'),
      value: (r) => r.algo?.totalQty ?? null,
      numeric: true,
      cell: (r) => (r.algo ? displayAmount(r.algo.totalQty) : '—'),
    },
    {
      id: 'ends',
      header: t('Expected to finish'),
      value: (r) => (r.algo ? new Date(r.algo.projectedEndsAt).toLocaleString() : null),
      width: 200,
    },
    {
      id: 'open',
      header: t('Manage'),
      headerLabel: t('Manage'),
      cell: (r) => (
        <Button variant="secondary" size={28} onClick={() => setOpenId(r.ref.id)}>
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

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList divider aria-label={t('Bot sections')}>
          <TabsTab value="catalogue">{t('Catalogue')}</TabsTab>
          <TabsTab value="mine">{t('My bots')}</TabsTab>
          <TabsTab value="paper">{t('Paper strategies')}</TabsTab>
        </TabsList>

        <TabsPanel value="catalogue">
          <PageSection title={t('Bot catalogue')} headingLevel={2}>
            <Table label={t('Bot catalogue')} columns={catalogueColumns} rows={CATALOGUE} getRowId={(r) => r.id} minWidth={1000} />
            <InfoNote>{t('Bots that are not built show their real status. Nothing here is simulated unless it says Paper.')}</InfoNote>
          </PageSection>
        </TabsPanel>

        <TabsPanel value="mine">
          <PageSection
            title={t('Your bots')}
            headingLevel={2}
            actions={
              <span className="cb-meta">
                <Freshness live={rows} staleAfterMs={45_000} />
                <Button variant="ghost" size={28} onClick={rows.reload}>
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
                action={{ label: t('Sign in'), href: '/login?redirect=%2Ftrade%2Fbots%3Ftab%3Dmine' }}
              />
            ) : (
              <>
                <Table
                  label={t('My bots')}
                  columns={mineColumns}
                  rows={rows.data ?? []}
                  getRowId={(r) => r.ref.id}
                  status={rows.status === 'loading' && refs.length > 0 ? 'loading' : 'ready'}
                  refreshing={rows.refreshing && rows.data !== null}
                  onRowActivate={(r) => setOpenId(r.ref.id)}
                  minWidth={940}
                  emptyState={
                    <EmptyState
                      size="inline"
                      title={t('No bots started on this device')}
                      reason={t(
                        'The service has no list of your bots yet, so this list is the bots you set up here. Open any bot by its ID below.',
                      )}
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
                  title={t('No paper strategies yet')}
                  reason={t('Write and save a strategy in Quant Studio and it appears here.')}
                  action={{ label: t('Open Quant Studio'), href: '/quant/studio', variant: 'secondary' }}
                />
              }
            />
            <KeyValue
              items={[
                { label: t('Running a strategy live'), value: t('Not built: a strategy cannot trade real money yet') },
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
        onOpenChange={(o) => setWizard((w) => ({ ...w, open: o }))}
        api={api}
        guard={guard}
        policy={policy.data}
        markets={spot}
        available={balanceOf}
        onCreated={(algo) => {
          remember({ id: algo.id, symbol: algo.symbol, kind: algo.kind, at: Date.now() });
          setTab('mine');
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
        onChanged={rows.reload}
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
