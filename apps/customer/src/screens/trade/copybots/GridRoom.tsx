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
import { useVenueMode } from '../../../features/trade/use-venue-mode';
import { VenueFrame } from '../../../features/trade/venue/VenueKit';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { createRoomApi, type GridBot, type GridRequest } from './api';
import { roomCopy } from './copy';
import { useWriteGuard } from './guard';
import { GridExits, GridIdleYield, GridSettings, GridTopUp } from './GridManage';
import { GridWithdraw } from './GridWithdraw';
import { GridWallet, VenueGridFacts, VenueGridWithdraw, WALLET_CODES, useVenueGrid, venueFeeItems } from './GridVenue';
import { parseGridCount, previewGridPrices } from './grid-plan';
import { useLive } from './live';
import { AccountBadge, Freshness, InfoNote, PendingBanner, RefusalNote, SelectField } from './parts';
import { ModeNav } from './ModeNav';
import './copybots.css';

/** A grid bot's state in words, the same in the room and in My bots. */
export const GRID_WORD: Record<GridBot['status'], string> = {
  signing: 'Waiting for your wallet',
  initializing: 'Starting',
  running: 'Bot running',
  paused_range: 'Paused: the price is outside the range',
  initialization_failed: 'Could not start',
  stopped: 'Stopped',
};
export const GRID_TONE: Record<GridBot['status'], BadgeTone> = {
  signing: 'warn',
  initializing: 'neutral',
  running: 'lime',
  paused_range: 'warn',
  initialization_failed: 'warn',
  stopped: 'neutral',
};

/** Why a grid stopped, in words: its own exit, or the person. */
const STOP_WORD: Readonly<Record<string, string>> = { price_exit: 'Price exit', owner_stop: 'You stopped it' };

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
  // The user-venue door on: a new grid trades on the person's own venue account (J-copy-bots-otc-14).
  const venueMode = useVenueMode();
  const venueUp = venueMode.mode === 'on' && venueMode.status.available ? venueMode.status : null;

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

  const onCreated = (bot: GridBot) => navigate(`/trade/bots/grid?bot=${encodeURIComponent(bot.botId)}`, true);
  const body = !session ? (
    <EmptyState
      variant="refused"
      title={t('You are signed out')}
      reason={t('Sign in to set up a bot.')}
      action={{ label: t('Sign in'), href: '/login?redirect=%2Ftrade%2Fbots%2Fgrid' }}
    />
  ) : botId && venueUp ? (
    // A venue bot's own wallet signs its agent permission here, so the detail carries the wallet bar too.
    <>
      <GridWallet status={venueUp} />
      <GridDetail botId={botId} api={api} guard={guard} venue />
    </>
  ) : botId ? (
    <GridDetail botId={botId} api={api} guard={guard} venue={false} />
  ) : setup.status === 'loading' || venueMode.mode === 'checking' ? (
    <InfoNote>{t('Checking')}</InfoNote>
  ) : setup.failure && !setup.data ? (
    // Refused (below the owner's level, or the level is blank): no form is offered and nothing can be written.
    <RefusalNote failure={setup.failure} retry={setup.reload} />
  ) : setup.data && venueUp ? (
    <>
      <GridWallet status={venueUp} />
      <VenueGridWizard
        api={api}
        guard={guard}
        status={venueUp}
        range={setup.data.countRange}
        band={setup.data.boundsMaxDistanceBps}
        onCreated={onCreated}
      />
    </>
  ) : setup.data ? (
    <GridWizard
      api={api}
      guard={guard}
      range={setup.data.countRange}
      band={setup.data.boundsMaxDistanceBps}
      markets={spot}
      onCreated={onCreated}
    />
  ) : null;

  return (
    <Page width="full" className="cb-page" landmark={false}>
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
      {venueMode.mode === 'on' ? <VenueFrame mode={venueMode}>{body}</VenueFrame> : body}
    </Page>
  );
}

type WizardProps = {
  api: ReturnType<typeof createRoomApi>;
  guard: ReturnType<typeof useWriteGuard>;
  range: { min: number; max: number } | null;
  band: number | null;
  onCreated: (bot: GridBot) => void;
};

/** The wizard on the venue: its spot markets and mid, and a create that asks the wallet for what the bot needs. */
function VenueGridWizard({ status, ...props }: WizardProps & { status: Parameters<typeof useVenueGrid>[1] }) {
  const [symbol, setSymbol] = useState('BTC-USDC');
  const venue = useVenueGrid(props.api, status, symbol);
  return <GridWizard {...props} markets={venue.markets} venue={{ symbol, onSymbol: setSymbol, last: venue.last, create: venue.create }} />;
}

function GridWizard({
  api,
  guard,
  range,
  band,
  markets,
  onCreated,
  venue,
}: WizardProps & {
  markets: Array<{ symbol: string; base: string; quote: string; precision: { price: string; amount: string } }>;
  /** Set on the venue: the market is chosen there, its price is the venue's, and the create goes through the wallet. */
  venue?: {
    symbol: string;
    onSymbol: (symbol: string) => void;
    last: string | null;
    create: (input: GridRequest) => Promise<ApiResult<GridBot>>;
  };
}) {
  const { t } = roomCopy.useCopy();
  const [tab, setTab] = useState('setup');
  const [ownSymbol, setOwnSymbol] = useState('BTC/USDT');
  const symbol = venue?.symbol ?? ownSymbol;
  const setSymbol = venue?.onSymbol ?? setOwnSymbol;
  const [investment, setInvestment] = useState('');
  const [grids, setGrids] = useState('');
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const presets = useLive((signal) => api.gridPresets(signal), 'grid-presets', 300_000);
  const market = markets.find((m) => m.symbol === symbol) ?? null;
  const ticker = useTicker(symbol, { intervalMs: 15_000 });
  const last = venue ? venue.last : ticker.status === 'ready' ? ticker.data.last : null;
  const count = parseGridCount(grids);
  const preview = market ? previewGridPrices({ lower, upper, count, tick: market.precision.price, range }) : { kind: 'none' as const };

  const create = () => {
    if (guard.busy || guard.locked) return;
    void guard.run(
      { kind: 'grid', id: requestKey, symbol },
      // Blank and out-of-range fields go to the service as typed, so its refusal names the field.
      () => {
        const input = { clientRequestId: requestKey, symbol, lowerPrice: lower, upperPrice: upper, gridCount: count, investment };
        return venue ? venue.create(input) : api.gridCreate(input);
      },
      onCreated,
    );
  };
  // A definite refusal ends this intent, so the next try is a new request; a lost reply keeps the key for the check, and
  // so does a signature the wallet did not give: the bot waits in signing, and the same key finds it again.
  const failure = guard.failure;
  useEffect(() => {
    if (failure && failure.reason !== 'uncertain' && !WALLET_CODES.has(failure.code ?? '')) setRequestKey(newRequestKey());
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
  venue,
}: {
  botId: string;
  api: ReturnType<typeof createRoomApi>;
  guard: ReturnType<typeof useWriteGuard>;
  /** The venue door is on, so the wallet is here to sign a venue bot's permission. */
  venue: boolean;
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
          { label: t('Levels planned again'), value: String(data.reinitCount) },
          {
            label: t('Set aside'),
            value: data.reserve
              ? data.reserve.releasedAt
                ? t('Released')
                : `${displayAmount(data.reserve.amount)} ${data.reserve.asset}`
              : t('None'),
          },
          // A grid on our own book shows its exits: each price, or Not set; the RSI exit is always Not set (no RSI source).
          ...(data.exits
            ? [
                {
                  label: t('Stop when the price falls to'),
                  value: data.exits.stopBelow ? `${displayAmount(data.exits.stopBelow)} ${data.quoteAsset}` : t('Not set'),
                },
                {
                  label: t('Stop when the price rises to'),
                  value: data.exits.stopAbove ? `${displayAmount(data.exits.stopAbove)} ${data.quoteAsset}` : t('Not set'),
                },
                { label: t('RSI exit'), value: t('Not set') },
              ]
            : []),
          ...(data.status === 'stopped' && data.statusReason && STOP_WORD[data.statusReason]
            ? [{ label: t('Stopped by'), value: t(STOP_WORD[data.statusReason] as 'Price exit') }]
            : []),
          { label: t('Bot ID'), value: data.botId },
        ]}
      />
      {data.venue && venue ? <VenueGridFacts bot={data} api={api} onDone={bot.reload} /> : null}
      {guard.failure ? <RefusalNote failure={guard.failure} /> : null}
      {data.status === 'signing' || data.status === 'initializing' || data.status === 'running' || data.status === 'paused_range' ? (
        <div className="cb-action-row">
          <Button variant="secondary" onClick={stop} disabled={guard.busy || guard.locked}>
            {t('Stop bot')}
          </Button>
          {!data.venue && (data.status === 'running' || data.status === 'paused_range') ? (
            <>
              <GridTopUp bot={data} api={api} onDone={bot.reload} />
              <GridSettings bot={data} api={api} />
              <GridExits bot={data} api={api} onDone={bot.reload} />
              <GridIdleYield bot={data} api={api} />
            </>
          ) : null}
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
              { label: t('Withdrawable profit'), value: `${displayAmount(data.withdrawableProfit)} ${data.quoteAsset}` },
              {
                label: t('Yearly return (APR)'),
                value:
                  data.gridApr.state === 'set' ? `${displayAmount(data.gridApr.percent)}%` : t('Not set: the bot has run less than a day'),
              },
              ...(data.venue ? venueFeeItems(data, t) : []),
            ]}
          />
          {data.venue ? <VenueGridWithdraw bot={data} api={api} /> : <GridWithdraw bot={data} api={api} onDone={bot.reload} />}
        </TabsPanel>
      </Tabs>
    </PageSection>
  );
}
