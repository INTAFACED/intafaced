import { useEffect, useMemo, useState } from 'react';
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
import { useTicker } from '../../../data';
import { useApi, useSession } from '../../../features/session/session';
import { createTradeApi } from '../../../features/trade/trade-api';
import { displayAmount } from '../../../shared/money';
import { createRoomApi, type GridBot } from './api';
import { roomCopy } from './copy';
import { useWriteGuard } from './guard';
import { parseGridCount, previewGridPrices } from './grid-plan';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, ModeNav, PendingBanner, RefusalNote, SelectField } from './parts';

/** A grid bot's state in words, the same in the room and in My bots. */
export const GRID_WORD: Record<GridBot['status'], string> = {
  initializing: 'Starting',
  running: 'Bot running',
  paused_range: 'Paused: the price is outside the range',
  initialization_failed: 'Could not start',
  stopped: 'Stopped',
};
export const GRID_TONE: Record<GridBot['status'], BadgeTone> = {
  initializing: 'neutral',
  running: 'lime',
  paused_range: 'warn',
  initialization_failed: 'warn',
  stopped: 'neutral',
};

// One key per intent: kept while a reply is lost (so a resend is the same request), renewed after any definite answer.
const newRequestKey = () => `grid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Level = GridBot['levels'][number];
type Order = GridBot['orders'][number];

/** The spot grid bot's own room: its wizard, or one bot's detail when the address names it (?bot=<id>). */
export function GridRoom({ path }: { path: string }) {
  const { t } = roomCopy.useCopy();
  const transport = useApi();
  const { session, userId } = useSession();
  const api = useMemo(() => createRoomApi(transport), [transport]);
  const tradeApi = useMemo(() => createTradeApi(transport), [transport]);
  const botId = new URL(path, 'http://x').searchParams.get('bot');
  const guard = useWriteGuard();
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  // The wizard's first read: the service refuses it below the owner's verification level, as it refuses a create.
  const setup = useLive(
    (signal) => (session ? api.gridSetup(signal) : Promise.resolve({ ok: true as const, data: null })),
    `grid-setup:${session ? (userId ?? 'in') : 'out'}`,
    60_000,
  );
  const markets = useLive((signal) => tradeApi.markets(signal), 'grid-markets', 300_000);
  const spot = (markets.data ?? []).filter((m) => m.spot && m.active && !m.paper && m.orderable);

  const check = async () => {
    const pending = guard.pending;
    if (!pending) return;
    if (pending.kind !== 'grid') {
      setVerdict(t('That request belongs to the spot desk or another room. Check it there; it stays locked until then.'));
      return;
    }
    setChecking(true);
    // A create is found by the request key it was sent with; a stop by the bot's own state.
    const listed = await api.gridList();
    setChecking(false);
    if (!listed.ok) {
      setVerdict(t('We could not check right now. Try again in a moment.'));
      return;
    }
    const found = pending.operation
      ? listed.data.find((b) => b.botId === pending.id)
      : listed.data.find((b) => b.clientRequestId === pending.id);
    if (pending.operation)
      setVerdict(
        found ? t('That bot is now {state}.', { state: t(GRID_WORD[found.status] as 'Stopped') }) : t('We couldn’t find that grid bot'),
      );
    else
      setVerdict(
        found
          ? t('The bot was created. It is in My bots.')
          : t('No bot exists with that request, so it did not go through. You can set it up again.'),
      );
    guard.settle(pending);
    if (found && !pending.operation) navigate(`/trade/bots/grid?bot=${encodeURIComponent(found.botId)}`, true);
  };

  return (
    <Page width="full" className="cb-page">
      <ModeNav active="bots" />
      <PageHeader
        title={t('Spot grid')}
        description={t('Buys at each level below the price and sells one level up, inside a range you set.')}
        meta={
          <span className="cb-meta">
            <AccountBadge paper={false} />
            <Freshness live={setup} staleAfterMs={180_000} />
          </span>
        }
      />
      <PendingBanner guard={guard} check={() => void check()} checking={checking} verdict={verdict} onDismiss={() => setVerdict(null)} />
      <div className="cb-action-row">
        <Button variant="ghost" size={28} onClick={() => navigate('/trade/bots')}>
          {t('Back to Bots')}
        </Button>
      </div>
      {!session ? (
        <EmptyState
          variant="refused"
          title={t('You are signed out')}
          reason={t('Sign in to set up a bot.')}
          action={{ label: t('Sign in'), href: '/login?redirect=%2Ftrade%2Fbots%2Fgrid' }}
        />
      ) : botId ? (
        <GridDetail botId={botId} api={api} guard={guard} />
      ) : setup.status === 'loading' ? (
        <InfoNote>{t('Checking')}</InfoNote>
      ) : setup.failure && !setup.data ? (
        // Refused (below the owner's level, or the level is blank): no form is offered and nothing can be written.
        <RefusalNote failure={setup.failure} retry={setup.reload} />
      ) : setup.data ? (
        <GridWizard
          api={api}
          guard={guard}
          range={setup.data.countRange}
          band={setup.data.boundsMaxDistanceBps}
          markets={spot}
          onCreated={(bot) => navigate(`/trade/bots/grid?bot=${encodeURIComponent(bot.botId)}`, true)}
        />
      ) : null}
    </Page>
  );
}

function GridWizard({
  api,
  guard,
  range,
  band,
  markets,
  onCreated,
}: {
  api: ReturnType<typeof createRoomApi>;
  guard: ReturnType<typeof useWriteGuard>;
  range: { min: number; max: number } | null;
  band: number | null;
  markets: Array<{ symbol: string; base: string; quote: string; precision: { price: string; amount: string } }>;
  onCreated: (bot: GridBot) => void;
}) {
  const { t } = roomCopy.useCopy();
  const [tab, setTab] = useState('setup');
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [investment, setInvestment] = useState('');
  const [grids, setGrids] = useState('');
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const presets = useLive((signal) => api.gridPresets(signal), 'grid-presets', 300_000);
  const market = markets.find((m) => m.symbol === symbol) ?? null;
  const ticker = useTicker(symbol, { intervalMs: 15_000 });
  const last = ticker.status === 'ready' ? ticker.data.last : null;
  const count = parseGridCount(grids);
  const preview = market ? previewGridPrices({ lower, upper, count, tick: market.precision.price, range }) : { kind: 'none' as const };

  const create = () => {
    if (guard.busy || guard.locked) return;
    void guard.run(
      { kind: 'grid', id: requestKey, symbol },
      // Blank and out-of-range fields go to the service as typed, so its refusal names the field.
      () => api.gridCreate({ clientRequestId: requestKey, symbol, lowerPrice: lower, upperPrice: upper, gridCount: count, investment }),
      onCreated,
    );
  };
  // A definite refusal ends this intent, so the next try is a new request; a lost reply keeps the key for the check.
  const failure = guard.failure;
  useEffect(() => {
    if (failure && failure.reason !== 'uncertain') setRequestKey(newRequestKey());
  }, [failure]);

  return (
    <form
      aria-label={t('Spot grid')}
      className="cb-form"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList divider aria-label={t('Grid sections')}>
          <TabsTab value="setup">{t('Set up')}</TabsTab>
          <TabsTab value="presets">{t('Presets')}</TabsTab>
        </TabsList>
        <TabsPanel value="setup">
          <PageSection title={t('Set up')} headingLevel={2}>
            <SelectField
              label={t('Market')}
              value={symbol}
              onChange={setSymbol}
              options={markets.map((m) => ({ value: m.symbol, label: m.symbol }))}
            />
            <p className="cb-note-body">
              {t('Last price')}{' '}
              <span data-testid="grid-last-price">{last ? `${displayAmount(last)} ${market?.quote ?? ''}` : t('Not available')}</span>
            </p>
            <KeyValue
              items={[
                {
                  label: t('Grids allowed'),
                  value: range ? t('{min} to {max}', { min: String(range.min), max: String(range.max) }) : t('Not set'),
                },
                {
                  label: t('Bounds allowed'),
                  value:
                    band === null
                      ? t('Not set')
                      : t('Within {percent}% of the market price', { percent: displayAmount(String(band / 100)) }),
                },
              ]}
            />
            <Field label={t('Investment')}>
              <Input kind="decimal" value={investment} onValueChange={setInvestment} precision={8} trailing={market?.quote ?? ''} />
            </Field>
            <Field label={t('Grids')}>
              <Input kind="decimal" value={grids} onValueChange={setGrids} precision={0} />
            </Field>
            <Field label={t('Lower price')}>
              <Input kind="decimal" value={lower} onValueChange={setLower} precision={8} trailing={market?.quote ?? ''} />
            </Field>
            <Field label={t('Upper price')}>
              <Input kind="decimal" value={upper} onValueChange={setUpper} precision={8} trailing={market?.quote ?? ''} />
            </Field>
            {preview.kind === 'levels' ? (
              <section aria-label={t('Planned levels')}>
                <p className="cb-note-body">
                  {t('{count} levels. The service plans the real ones when the bot starts.', { count: String(preview.prices.length) })}
                </p>
                <ol className="cb-levels" data-testid="grid-plan">
                  {preview.prices.map((price, i) => (
                    <li key={`${i}-${price}`}>{displayAmount(price)}</li>
                  ))}
                </ol>
              </section>
            ) : (
              <InfoNote>{t('Enter both prices and a grid count in the allowed range to see the levels.')}</InfoNote>
            )}
            {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
            <div className="cb-action-row">
              <Button type="submit" disabled={guard.busy || guard.locked}>
                {guard.busy ? t('Starting') : t('Create bot')}
              </Button>
            </div>
          </PageSection>
        </TabsPanel>
        <TabsPanel value="presets">
          <PageSection title={t('Presets')} headingLevel={2}>
            {presets.status === 'ready' && presets.data ? (
              <KeyValue items={[{ label: t('Backtested presets'), value: t('Not set') }]} />
            ) : presets.failure ? (
              <RefusalNote failure={presets.failure} retry={presets.reload} />
            ) : (
              <InfoNote>{t('Checking')}</InfoNote>
            )}
            <InfoNote>{t('No backtest source is connected, so no preset and no APR is shown.')}</InfoNote>
          </PageSection>
        </TabsPanel>
      </Tabs>
    </form>
  );
}

function GridDetail({
  botId,
  api,
  guard,
}: {
  botId: string;
  api: ReturnType<typeof createRoomApi>;
  guard: ReturnType<typeof useWriteGuard>;
}) {
  const { t } = roomCopy.useCopy();
  const [tab, setTab] = useState('levels');
  const bot = useLive((signal) => api.gridGet(botId, signal), `grid-bot:${botId}`, 10_000);
  const data = bot.data;
  if (!data) return bot.failure ? <RefusalNote failure={bot.failure} retry={bot.reload} /> : <InfoNote>{t('Checking')}</InfoNote>;

  const stop = () => {
    if (guard.busy || guard.locked) return;
    void guard.run({ kind: 'grid', id: data.botId, symbol: data.symbol, operation: 'stop' }, () => api.gridStop(data.botId), bot.reload);
  };

  const levelColumns: TableColumn<Level>[] = [
    { id: 'index', header: t('Level'), value: (l) => String(l.index + 1), numeric: true },
    { id: 'price', header: t('Price'), value: (l) => l.price, numeric: true, cell: (l) => displayAmount(l.price) },
    { id: 'qty', header: t('Amount'), value: (l) => l.qty, numeric: true, cell: (l) => displayAmount(l.qty) },
    {
      id: 'order',
      header: t('Open order'),
      value: (l) => (l.openOrder ? (l.openOrder.side === 'buy' ? t('Buy') : t('Sell')) : t('None')),
    },
  ];
  const orderColumns: TableColumn<Order>[] = [
    { id: 'level', header: t('Level'), value: (o) => String(o.levelIndex + 1), numeric: true },
    { id: 'side', header: t('Side'), value: (o) => (o.side === 'buy' ? t('Buy') : t('Sell')) },
    { id: 'price', header: t('Price'), value: (o) => o.price, numeric: true, cell: (o) => displayAmount(o.price) },
    { id: 'held', header: t('Held'), value: (o) => o.holdAmount, numeric: true, cell: (o) => displayAmount(o.holdAmount) },
    {
      id: 'status',
      header: t('State'),
      value: (o) => ({ open: t('Open'), filled: t('Filled'), partial: t('Part filled'), cancelled: t('Cancelled') })[o.status],
    },
  ];

  return (
    <PageSection
      title={t('Spot grid {symbol}', { symbol: data.symbol })}
      headingLevel={2}
      actions={<Freshness live={bot} staleAfterMs={45_000} />}
    >
      <p role="status" className="cb-statuscell">
        <Badge tone={GRID_TONE[data.status]}>
          <span data-testid="grid-status">{t(GRID_WORD[data.status] as 'Stopped')}</span>
        </Badge>
      </p>
      <KeyValue
        items={[
          { label: t('Range'), value: `${displayAmount(data.lowerPrice)} – ${displayAmount(data.upperPrice)} ${data.quoteAsset}` },
          { label: t('Grids'), value: String(data.gridCount) },
          { label: t('Investment'), value: `${displayAmount(data.investment)} ${data.quoteAsset}` },
          {
            label: t('Set aside'),
            value: data.reserve
              ? data.reserve.releasedAt
                ? t('Released')
                : `${displayAmount(data.reserve.amount)} ${data.reserve.asset}`
              : t('None'),
          },
          { label: t('Bot ID'), value: data.botId },
        ]}
      />
      {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
      {data.status === 'initializing' || data.status === 'running' || data.status === 'paused_range' ? (
        <div className="cb-action-row">
          <Button variant="secondary" onClick={stop} disabled={guard.busy || guard.locked}>
            {t('Stop bot')}
          </Button>
        </div>
      ) : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList divider aria-label={t('Bot sections')}>
          <TabsTab value="levels">{t('Levels')}</TabsTab>
          <TabsTab value="orders">{t('Orders')}</TabsTab>
          <TabsTab value="metrics">{t('Metrics')}</TabsTab>
        </TabsList>
        <TabsPanel value="levels">
          <Table label={t('Levels')} columns={levelColumns} rows={[...data.levels]} getRowId={(l) => String(l.index)} minWidth={600} />
        </TabsPanel>
        <TabsPanel value="orders">
          <Table label={t('Orders')} columns={orderColumns} rows={[...data.orders]} getRowId={(o) => o.clientOrderId} minWidth={700} />
        </TabsPanel>
        <TabsPanel value="metrics">
          <KeyValue
            items={[
              { label: t('Grid profit'), value: `${displayAmount(data.gridProfit)} ${data.quoteAsset}` },
              { label: t('Closed pairs'), value: String(data.closedPairs) },
              {
                label: t('Yearly return (APR)'),
                value:
                  data.gridApr.state === 'set' ? `${displayAmount(data.gridApr.percent)}%` : t('Not set: the bot has run less than a day'),
              },
            ]}
          />
        </TabsPanel>
      </Tabs>
    </PageSection>
  );
}
