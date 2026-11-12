import { useMemo, useRef, useState } from 'react';
import { Button, DataTable, Tabs } from '../../../shared/ui';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  canonicalDecimal,
  draftId,
  keys,
  leverageBpsOf,
  leverageTimes,
  onStep,
  partOf,
  sumDecimals,
  type AsOf,
  type MaybeKnown,
  type OrderIntent,
  type VenueFill,
  type VenueMarginMode,
  type VenueMarket,
  type VenuePosition,
  type VenuePreview,
  type VenueSession,
  type VenueMarketEvent,
  type VenueSettlement,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  AsOfLine,
  BalancesPanel,
  FillsTable,
  Known,
  OrdersTable,
  OutcomeLine,
  ReadProblem,
  TestMark,
  VENUE_POLL_MS,
  VenueFrame,
  VenueHeader,
  WalletBar,
  heldKeys,
  outcomeText,
  keepsDraft,
  ReadBack,
  useOwner,
  useVenueAccount,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
  type RunAction,
  type VenueAccount,
} from '../../../features/trade/venue/VenueKit';
import { ReviewDialog } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { futuresVenueCopy } from './venue-copy';
import { RoutedReview, VenueRoutes } from './VenueRoutes';
import type { RoutePreview } from '../../../features/trade/venue-api';

/** Resting order types the futures desk names; any the venue does not list is shown with its refusal and sends nothing. */
const RESTING_TYPES = ['stop', 'take_profit', 'trailing_stop'] as const;
const MODES: readonly VenueMarginMode[] = ['isolated', 'cross'];
/** How far from the mark a close's worst price sits (its slippage limit), in percent. */
const CLOSE_SLIPPAGE_PERCENT = 5n;

/** The futures desk in venue mode: every perpetual the venue lists, on the customer's own venue account. */
export function VenueFuturesDesk({ mode, symbol }: { mode: Extract<VenueMode, { mode: 'on' }>; symbol: string | null }) {
  return (
    <VenueFrame mode={mode}>
      <Desk status={mode.status} requested={symbol} />
    </VenueFrame>
  );
}

function Desk({ status, requested }: { status: Extract<VenueMode, { mode: 'on' }>['status']; requested: string | null }) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const markets = usePolled((signal) => venue.markets(signal), 'venue-markets', 5_000);
  if (!status.available) {
    return (
      <div data-testid="if-futures" className="if-desk" data-venue="on">
        <p className="failure" role="alert" data-testid="venue-down">
          {v('Venue unavailable', { detail: status.refusal.detail })}
        </p>
      </div>
    );
  }
  const perps = (markets.data?.value ?? []).filter((m) => m.kind === 'perpetual');
  const down = markets.failure?.code === 'trade.venue.venue_down';
  return (
    <div data-testid="if-futures" className="if-desk" data-venue="on">
      <VenueHeader status={status} title={t('Futures on venue')} />
      {down || markets.failure ? <ReadProblem failure={markets.failure} venueName={status.venue.displayName} /> : null}
      <section className="dk-panel" aria-label={t('Contracts')} data-testid="venue-contracts">
        <h2 className="dk-tab-title">{t('Contracts')}</h2>
        {markets.data && perps.length === 0 ? (
          <div data-testid="venue-no-contract">
            <p>{t('No contract')}</p>
            <p className="muted">{t('No contract reason', { venue: status.venue.displayName })}</p>
          </div>
        ) : null}
      </section>
      {markets.data && perps.length > 0 ? <Contracts status={status} perps={perps} requested={requested} /> : null}
    </div>
  );
}

/** A venue that is down is named above; its controls still answer, each with the venue's typed refusal and nothing sent. */
function Contracts({ status, perps, requested }: { status: VenueUp; perps: VenueMarket[]; requested: string | null }) {
  const { t } = futuresVenueCopy.useCopy();
  const [chosen, setChosen] = useState<string>(perps.find((m) => m.symbol === requested)?.symbol ?? perps[0]!.symbol);
  const market = perps.find((m) => m.symbol === chosen) ?? perps[0]!;
  const owner = useOwner();
  const account = useVenueAccount(owner, { positions: true });
  const { run, resend } = useVenueActions(owner);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  return (
    <>
      <ul className="form-stack" aria-label={t('Contracts')} data-testid="venue-contract-list">
        {perps.map((m) => (
          <li key={m.symbol}>
            <Button
              variant={m.symbol === market.symbol ? 'primary' : 'secondary'}
              aria-pressed={m.symbol === market.symbol}
              onClick={() => setChosen(m.symbol)}
            >
              {t('Contract on venue', { symbol: m.symbol, venue: status.venue.displayName })}
            </Button>{' '}
            <TestMark test={status.test} />
          </li>
        ))}
      </ul>
      <ContractStrip market={market} positions={account.positions.data} test={status.test} />
      <MarketRules market={market} venueName={status.venue.displayName} test={status.test} />
      <WalletBar />
      <ReadProblem failure={account.balances.failure} venueName={status.venue.displayName} />
      {owner ? <BalancesPanel balances={account.balances.data} test={status.test} /> : null}
      {owner && market.marginAccount?.known ? (
        <MarketMarginStep key={`mm:${market.symbol}`} market={market} owner={owner} run={run} test={status.test} />
      ) : null}
      {owner ? <MarginStep key={market.symbol} market={market} owner={owner} run={run} test={status.test} disabled={false} /> : null}
      {owner ? (
        <Ticket
          key={`t:${market.symbol}`}
          status={status}
          market={market}
          owner={owner}
          account={account}
          run={run}
          resend={resend}
          side={side}
          setSide={setSide}
          disabled={false}
        />
      ) : null}
      {owner && status.routes ? <PrimaryLeverageRoutes symbol={market.symbol} owner={owner} side={side} run={run} /> : null}
      {owner ? <Blotter status={status} market={market} owner={owner} account={account} run={run} /> : null}
    </>
  );
}

/** The venues strip, with the leverage the person set on the primary venue for "set here" on the others (J-derivatives-28). */
function PrimaryLeverageRoutes({ symbol, owner, side, run }: { symbol: string; owner: string; side: 'buy' | 'sell'; run: RunAction }) {
  const venue = useVenueApi();
  const lev = usePolled((signal) => venue.leverage(owner, symbol, signal), `lev:${owner}:${symbol}`, VENUE_POLL_MS);
  return <VenueRoutes symbol={symbol} owner={owner} side={side} run={run} leverage={lev.data?.value ?? null} />;
}

function ContractStrip({ market, positions, test }: { market: VenueMarket; positions: AsOf<VenuePosition[]> | null; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const held = positions?.value.find((p) => p.symbol === market.symbol);
  return (
    <section className="dk-panel" aria-label={t('Contract strip')} data-testid="venue-contract-strip">
      <h2 className="dk-tab-title">
        {market.symbol} <TestMark test={test} />
      </h2>
      <dl className="protocol-facts">
        <div>
          <dt>{t('Family')}</dt>
          <dd>{t('family_perpetual')}</dd>
        </div>
        <div>
          <dt>{t('Settle asset')}</dt>
          <dd>{market.quoteAsset}</dd>
        </div>
        <div>
          <dt>{t('Lot size')}</dt>
          <dd className="numeric">{t('Lot size value', { lot: market.lotSize, base: market.baseAsset })}</dd>
        </div>
        <div>
          <dt>{t('Tick size')}</dt>
          <dd className="numeric">{market.tickSize}</dd>
        </div>
        <div>
          <dt>{t('Max leverage')}</dt>
          <dd className="numeric" data-testid="venue-max-leverage">
            {market.maxLeverageBps === null ? <Known value={{ known: false }} /> : `${leverageTimes(market.maxLeverageBps)}x`}
          </dd>
        </div>
        <div>
          <dt>{t('Mark price')}</dt>
          <dd className="numeric">
            <Known value={held ? { known: true, value: held.markPrice } : { known: false }} />
          </dd>
        </div>
        <div>
          <dt>{t('Funding')}</dt>
          <dd>
            <Known value={{ known: false }} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The market's own published rules, read from the venue (J-derivatives-21 #1, #4): who lists it, the oracle and mark
 * rules it is priced by, its trading hours, and its price feed's state with the venue's rule while it is stale. Each is
 * the venue's text as published, or "not published by this venue"; nothing here is ours, and nothing claims a
 * protection the venue does not give.
 */
function MarketRules({ market, venueName, test }: { market: VenueMarket; venueName: string; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const text = (value: MaybeKnown<string>) => (value.known ? value.value : t('Not published'));
  const feed = market.feed.known ? market.feed.value : null;
  return (
    <section className="dk-panel" aria-label={t('Market rules', { symbol: market.symbol })} data-testid="venue-market-rules">
      <h2 className="dk-tab-title">
        {t('Market rules', { symbol: market.symbol })} <TestMark test={test} />
      </h2>
      {feed?.state === 'stale' ? (
        <p role="status" data-testid="venue-feed-stale">
          {t('Feed stale notice', {
            venue: venueName,
            symbol: market.symbol,
            rule: feed.staleRule.known ? feed.staleRule.value : t('Not published'),
          })}
        </p>
      ) : null}
      <dl className="protocol-facts">
        <div>
          <dt>{t('Listed by')}</dt>
          <dd data-testid="venue-listing" data-listing={market.listedBy.known ? market.listedBy.value.kind : 'unknown'}>
            {market.listedBy.known ? t(`listing_${market.listedBy.value.kind}`, { name: market.listedBy.value.name }) : t('Not published')}
          </dd>
        </div>
        <div>
          <dt>{t('Oracle rule')}</dt>
          <dd data-testid="venue-oracle-rule">{text(market.oracleRule)}</dd>
        </div>
        <div>
          <dt>{t('Mark rule')}</dt>
          <dd data-testid="venue-mark-rule">{text(market.markRule)}</dd>
        </div>
        <div>
          <dt>{t('Trading hours')}</dt>
          <dd data-testid="venue-trading-hours">{text(market.tradingHours)}</dd>
        </div>
        <div>
          <dt>{t('Price feed')}</dt>
          <dd data-testid="venue-feed-state" data-state={feed?.state ?? 'unknown'}>
            {feed ? (
              <>
                {t(feed.state === 'stale' ? 'feed_stale' : 'feed_live')}{' '}
                <time dateTime={feed.lastOracleUpdateAt} data-testid="venue-feed-updated">
                  {feed.lastOracleUpdateAt}
                </time>
              </>
            ) : (
              t('Not published')
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Stale rule')}</dt>
          <dd data-testid="venue-stale-rule">{feed ? text(feed.staleRule) : t('Not published')}</dd>
        </div>
        {market.openInterest?.known ? (
          <>
            <div>
              <dt>{t('Open interest')}</dt>
              <dd className="numeric" data-testid="venue-open-interest">
                {t('Open interest value', { size: market.openInterest.value.size, base: market.baseAsset })}
              </dd>
            </div>
            <div>
              <dt>{t('Open interest cap')}</dt>
              <dd className="numeric" data-testid="venue-open-interest-cap">
                {market.openInterest.value.capSize === null
                  ? t('Open interest no cap')
                  : t('Open interest cap value', { cap: market.openInterest.value.capSize, base: market.baseAsset })}
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {market.session.known ? <SessionRules session={market.session.value} symbol={market.symbol} venueName={venueName} /> : null}
      {market.lastEvent?.known ? <MarketEvent event={market.lastEvent.value} symbol={market.symbol} venueName={venueName} /> : null}
    </section>
  );
}

/**
 * The latest deployer's halt or split the venue reports on the market (J-derivatives-27 #9 #10): when, the price it
 * settled every position at, that it cancelled every order, and whether and when it reopened. The venue's report; the
 * app adds no protection of its own.
 */
function MarketEvent({ event, symbol, venueName }: { event: VenueMarketEvent; symbol: string; venueName: string }) {
  const { t } = futuresVenueCopy.useCopy();
  return (
    <div
      role="status"
      data-testid="venue-market-event"
      data-kind={event.kind}
      data-at={event.eventAt}
      data-price={event.settlementPrice}
      data-reopened={event.reopenedAt ?? ''}
    >
      {event.kind === 'deployer_halt' ? (
        <>
          <p data-testid="venue-market-event-words">
            {t('event_deployer_halt', { venue: venueName, symbol, at: event.eventAt, price: event.settlementPrice })}
          </p>
          <p data-testid="venue-market-event-state">
            {event.reopenedAt === null
              ? t('event_halt_open', { symbol })
              : t('event_halt_reopened', { symbol, reopened: event.reopenedAt })}
          </p>
        </>
      ) : (
        <p data-testid="venue-market-event-words">
          {t('event_split', {
            venue: venueName,
            symbol,
            ratio: event.splitRatio ?? '',
            at: event.eventAt,
            price: event.settlementPrice,
            reopened: event.reopenedAt ?? '',
          })}
        </p>
      )}
    </div>
  );
}

/**
 * A stock perpetual's home market, read from the venue (J-derivatives-27 #4): whether it is open now, and the venue's own
 * off-hours mode, band, leverage, reopen time and refusal rule, each in its words or "not published by this venue".
 */
function SessionRules({ session, symbol, venueName }: { session: VenueSession; symbol: string; venueName: string }) {
  const { t } = futuresVenueCopy.useCopy();
  const text = (value: MaybeKnown<string>) => (value.known ? value.value : t('Not published'));
  const closed = session.state === 'off_hours';
  return (
    <div data-testid="venue-session" data-state={session.state}>
      {closed ? (
        <p role="status" data-testid="venue-off-hours">
          {t('Off-hours notice', { venue: venueName, home: session.homeMarket, symbol, rule: text(session.offHoursRule) })}
        </p>
      ) : null}
      <dl className="protocol-facts">
        <div>
          <dt>{t('Home market')}</dt>
          <dd data-testid="venue-home-market">{t(closed ? 'session_off_hours' : 'session_open', { home: session.homeMarket })}</dd>
        </div>
        <div>
          <dt>{t('Off-hours mode')}</dt>
          <dd data-testid="venue-off-hours-mode">{text(session.offHoursMode)}</dd>
        </div>
        <div>
          <dt>{t('Off-hours band')}</dt>
          <dd data-testid="venue-off-hours-band">{text(session.offHoursBand)}</dd>
        </div>
        <div>
          <dt>{t('Off-hours leverage')}</dt>
          <dd className="numeric" data-testid="venue-off-hours-leverage">
            {session.offHoursMaxLeverageBps === null
              ? t('Not published')
              : t('Off-hours leverage times', { times: String(leverageTimes(session.offHoursMaxLeverageBps)) })}
          </dd>
        </div>
        <div>
          <dt>{t('Reopens')}</dt>
          <dd data-testid="venue-reopens">
            {!closed ? (
              t('Reopens while open')
            ) : session.reopensAt === null ? (
              t('Not published')
            ) : (
              <time dateTime={session.reopensAt}>{session.reopensAt}</time>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Off-hours rule')}</dt>
          <dd data-testid="venue-off-hours-rule">{text(session.offHoursRule)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The margin account a market's deployer keeps for it, apart from the main account (J-derivatives-27 #7): its name,
 * collateral asset and margin mode as the deployer set them, the person's balance in it as the venue reports it, and a
 * move in or out that the person's own wallet signs on the main account. Nothing moves without that signature.
 */
function MarketMarginStep({ market, owner, run, test }: { market: VenueMarket; owner: string; run: RunAction; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const venue = useVenueApi();
  const read = usePolled((signal) => venue.marketMargin(owner, market.symbol, signal), `mm:${owner}:${market.symbol}`, VENUE_POLL_MS);
  const rule = market.marginAccount?.known ? market.marginAccount.value : null;
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const draft = useRef(draftId());
  if (!rule) return null;

  async function move(direction: 'into_market' | 'out_of_market') {
    setProblem(null);
    let value: string;
    try {
      value = canonicalDecimal(amount);
      if (parseAmount(value) <= 0n) throw new Error('not above zero');
    } catch {
      return setProblem(t('Market margin amount invalid'));
    }
    const answer = await run({
      kind: 'market_margin_transfer',
      symbol: market.symbol,
      direction,
      asset: rule!.collateralAsset,
      amount: value,
      moveKey: keys.marketMargin(owner, market.symbol, direction, draft.current),
    });
    setResult(answer);
    if (!keepsDraft(answer)) draft.current = draftId();
    read.reload();
  }

  const held = read.data?.value ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Market margin')} data-testid="venue-market-margin">
      <h2 className="dk-tab-title">
        {t('Market margin')} <TestMark test={test} />
      </h2>
      <p data-testid="venue-market-margin-note">{t('Market margin note', { name: rule.name, symbol: market.symbol })}</p>
      <ReadProblem failure={read.failure} venueName={rule.name} />
      <dl className="protocol-facts">
        <div>
          <dt>{t('Market margin name')}</dt>
          <dd data-testid="venue-market-margin-name">{rule.name}</dd>
        </div>
        <div>
          <dt>{t('Market margin collateral')}</dt>
          <dd data-testid="venue-market-margin-collateral">{rule.collateralAsset}</dd>
        </div>
        <div>
          <dt>{t('Market margin mode')}</dt>
          <dd data-testid="venue-market-margin-mode" data-mode={rule.marginMode}>
            {t(`mode_${rule.marginMode}`)}
          </dd>
        </div>
        <div>
          <dt>{t('Market margin free')}</dt>
          <dd className="numeric" data-testid="venue-market-margin-free">
            {held ? held.free : ''}
          </dd>
        </div>
        <div>
          <dt>{t('Market margin used')}</dt>
          <dd className="numeric" data-testid="venue-market-margin-used">
            {held ? held.locked : ''}
          </dd>
        </div>
        <div>
          <dt>{t('Market margin total')}</dt>
          <dd className="numeric" data-testid="venue-market-margin-total">
            {held ? held.total : ''}
          </dd>
        </div>
      </dl>
      {read.data ? <AsOfLine asOf={read.data.asOf} /> : null}
      <label className="field">
        <span>{t('Market margin amount', { asset: rule.collateralAsset })}</span>
        <input
          inputMode="decimal"
          aria-label={t('Market margin amount', { asset: rule.collateralAsset })}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <Button onClick={() => void move('into_market')}>{t('Market margin in')}</Button>
      <Button variant="secondary" onClick={() => void move('out_of_market')}>
        {t('Market margin out')}
      </Button>
      {problem ? (
        <p className="failure" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} />
    </section>
  );
}

/** The margin step: the modes the venue offers for this contract, the others listed as not offered, and a signed leverage setting. */
function MarginStep({
  market,
  owner,
  run,
  test,
  disabled,
}: {
  market: VenueMarket;
  owner: string;
  run: RunAction;
  test: boolean;
  disabled: boolean;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const current = usePolled((signal) => venue.leverage(owner, market.symbol, signal), `lev:${owner}:${market.symbol}`, VENUE_POLL_MS);
  const [mode, setMode] = useState<VenueMarginMode>(market.marginModes[0] ?? 'isolated');
  const [times, setTimes] = useState('10');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const draft = useRef(draftId());

  async function sign() {
    setProblem(null);
    const n = Number(times);
    // Only the shape is checked here. The cap is the venue's: a leverage above it is sent to the venue's prepare, which
    // refuses it on its face, naming its cap, before the wallet is asked (nothing is signed or changed).
    if (!Number.isInteger(n) || n < 1) return setProblem(t('Leverage whole'));
    const bps = leverageBpsOf(n);
    const answer = await run(
      { kind: 'update_leverage', symbol: market.symbol, leverageBps: bps, marginMode: mode },
      { actionKey: keys.leverage(owner, market.symbol, mode, bps, draft.current) },
    );
    setResult(answer);
    if (!keepsDraft(answer)) draft.current = draftId();
    current.reload();
  }

  const set = current.data?.value ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Margin step')} data-testid="venue-margin">
      <h2 className="dk-tab-title">
        {t('Margin step')} <TestMark test={test} />
      </h2>
      <div role="radiogroup" aria-label={t('Margin mode')}>
        {MODES.map((m) => {
          const offered = market.marginModes.includes(m);
          return (
            <label key={m} className="field" data-mode={m} data-offered={offered ? 'true' : 'false'}>
              <input
                type="radio"
                name={`mode-${market.symbol}`}
                value={m}
                checked={mode === m}
                disabled={!offered}
                onChange={() => setMode(m)}
              />
              <span>
                {t(`mode_${m}`)}
                {offered ? '' : ` · ${v('Not offered')}`}
              </span>
            </label>
          );
        })}
      </div>
      <p data-testid="venue-leverage-current">
        {set
          ? t('Leverage set', { times: String(leverageTimes(set.leverageBps)), mode: t(`mode_${set.marginMode}`) })
          : current.data
            ? t('Leverage not set')
            : ''}
      </p>
      <label className="field">
        <span>{t('Leverage x')}</span>
        <input inputMode="numeric" aria-label={t('Leverage x')} value={times} onChange={(e) => setTimes(e.target.value)} />
      </label>
      <Button disabled={disabled} onClick={() => void sign()}>
        {t('Sign leverage')}
      </Button>
      {problem ? (
        <p className="failure" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} />
    </section>
  );
}

function Ticket({
  status,
  market,
  owner,
  account,
  run,
  resend,
  side,
  setSide,
  disabled,
}: {
  status: VenueUp;
  market: VenueMarket;
  owner: string;
  account: VenueAccount;
  run: RunAction;
  resend: (intent: OrderIntent, opts: { venueId?: string }) => Promise<ActionResult>;
  side: 'buy' | 'sell';
  setSide: (s: 'buy' | 'sell') => void;
  disabled: boolean;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const [routed, setRouted] = useState<{ intent: OrderIntent; route: RoutePreview } | null>(null);
  const [type, setType] = useState<'limit' | 'market'>(market.orderTypes.includes('market') ? 'market' : 'limit');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [marginAsset, setMarginAsset] = useState(market.quoteAsset);
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<{ intent: OrderIntent; preview: AsOf<VenuePreview> } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [last, setLast] = useState<ActionResult | null>(null);
  const counter = useRef(0);
  const sending = useRef(false);
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const assets = [...new Set([market.quoteAsset, ...(account.balances.data?.value.map((b) => b.asset) ?? [])])];
  const offered = market.orderTypes.filter((x): x is 'limit' | 'market' => x === 'limit' || x === 'market');

  async function openReview() {
    setProblem(null);
    setResult(null);
    if (marginAsset !== market.quoteAsset)
      return setProblem(t('Margin mismatch', { symbol: market.symbol, settle: market.quoteAsset, asset: marginAsset }));
    if (!size.trim()) return setProblem(v('Enter amount'));
    if (!price.trim()) return setProblem(v('Enter price'));
    if (!onStep(size, market.lotSize)) return setProblem(v('Not a step', { field: v('Amount'), step: market.lotSize }));
    if (!onStep(price, market.tickSize)) return setProblem(v('Not a step', { field: v('Price'), step: market.tickSize }));
    const intent: OrderIntent = {
      kind: 'place_order',
      symbol: market.symbol,
      side,
      type,
      amount: canonicalDecimal(size),
      price: canonicalDecimal(price),
      timeInForce: type === 'market' ? 'IOC' : (market.timeInForce[0] ?? 'GTC'),
      reduceOnly: false,
      clientOrderKey: keys.order(owner, market.symbol, draftId(Date.now(), counter.current++)),
      builderFee: null,
    };
    if (status.routes) {
      // J-derivatives-28: several venues, so the router chooses one for this order and says why.
      const route = await venue.routePreview(owner, intent);
      if (!route.ok) return setProblem(v('Outcome refused', { detail: route.message }));
      setRouted({ intent, route: route.data });
      return;
    }
    const preview = await venue.preview(owner, intent);
    if (!preview.ok) return setProblem(v('Outcome refused', { detail: preview.message }));
    setReview({ intent, preview: preview.data });
  }

  async function confirm() {
    if (!review || sending.current) return;
    sending.current = true;
    const answer = await run(review.intent);
    sending.current = false;
    if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId)
      keysHeld.set(answer.clientOrderId, review.intent.clientOrderKey);
    setResult(answer);
    setLast(answer);
    account.reload();
  }

  const perp = review?.preview.value.perpetual ?? null;
  const total = review ? totalToCommit(review.preview.value) : null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Ticket')} data-testid="venue-ticket">
      <h2 className="dk-tab-title">{t('Ticket')}</h2>
      <Tabs
        items={['buy', 'sell']}
        value={side}
        onChange={(s) => setSide(s as 'buy' | 'sell')}
        label={t('Ticket')}
        labels={{ buy: t('Long'), sell: t('Short') }}
      />
      <div role="group" aria-label={t('Order types')} data-testid="venue-order-types">
        {offered.map((x) => (
          <Button key={x} variant={type === x ? 'primary' : 'secondary'} aria-pressed={type === x} onClick={() => setType(x)}>
            {word(v, 'type', x)}
          </Button>
        ))}
        {RESTING_TYPES.filter((x) => !market.orderTypes.includes(x)).map((x) => (
          <Button key={x} variant="secondary" disabled aria-disabled="true" data-not-offered={x}>
            {word(v, 'type', x)}: {v('Not offered')}
          </Button>
        ))}
      </div>
      <label className="field">
        <span>{t('Size', { asset: market.baseAsset })}</span>
        <input
          inputMode="decimal"
          aria-label={t('Size', { asset: market.baseAsset })}
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{type === 'market' ? t('Worst price') : t('Price')}</span>
        <input
          inputMode="decimal"
          aria-label={type === 'market' ? t('Worst price') : t('Price')}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>
      <label className="field">
        <span>{t('Margin asset')}</span>
        <select aria-label={t('Margin asset')} value={marginAsset} onChange={(e) => setMarginAsset(e.target.value)}>
          {assets.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <Button disabled={disabled} onClick={() => void openReview()}>
        {side === 'buy' ? t('Review long') : t('Review short')}
      </Button>
      {problem ? (
        <p className="failure" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={review || routed ? null : last} owner={owner} />
      {routed ? (
        <RoutedReview
          title={t('Review open', { side: side === 'buy' ? t('Long').toLowerCase() : t('Short').toLowerCase() })}
          route={routed.route}
          intent={routed.intent}
          status={status}
          owner={owner}
          run={run}
          resend={resend}
          confirmLabel={side === 'buy' ? t('Open long') : t('Open short')}
          onSent={(answer) => {
            if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId)
              keysHeld.set(answer.clientOrderId, routed.intent.clientOrderKey);
            setLast(answer);
            account.reload();
          }}
          onClose={() => setRouted(null)}
        />
      ) : null}
      {review ? (
        <ReviewDialog
          title={t('Review open', { side: side === 'buy' ? t('Long').toLowerCase() : t('Short').toLowerCase() })}
          preview={review.preview}
          intent={review.intent}
          status={status}
          account={account}
          owner={owner}
          run={run}
          confirmLabel={side === 'buy' ? t('Open long') : t('Open short')}
          result={result}
          onConfirm={() => void confirm()}
          onClose={() => {
            setReview(null);
            setResult(null);
          }}
          extra={
            perp ? (
              <>
                <div>
                  <dt>{t('Initial margin')}</dt>
                  <dd className="numeric" data-line="initial-margin">
                    <Known value={perp.initialMargin} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Liquidation price')}</dt>
                  <dd className="numeric" data-line="liquidation">
                    <Known value={perp.liquidationPrice} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Leverage and mode')}</dt>
                  <dd data-line="leverage">
                    {t('Leverage value', { times: String(leverageTimes(perp.leverageBps)), mode: t(`mode_${perp.marginMode}`) })}
                  </dd>
                </div>
                <div>
                  <dt>{t('Total to commit')}</dt>
                  <dd className="numeric" data-line="total">
                    <Known value={total === null ? { known: false } : { known: true, value: total }} /> {market.quoteAsset}
                  </dd>
                </div>
              </>
            ) : null
          }
        />
      ) : null}
    </section>
  );
}

/** Initial margin plus the venue's fee plus our builder fee, all the venue's figures in the settle asset; null when any is not known. */
export function totalToCommit(p: VenuePreview): string | null {
  const perp = p.perpetual;
  if (!perp || !perp.initialMargin.known || !p.venueFee.known || !p.builderFee.known) return null;
  if (p.venueFee.value.asset !== p.lock.asset || p.builderFee.value.asset !== p.lock.asset) return null;
  return sumDecimals([perp.initialMargin.value, p.venueFee.value.amount, p.builderFee.value.amount]);
}

/** A close's worst price: CLOSE_SLIPPAGE_PERCENT from the mark, on the tick, against the position. */
export function closeWorstPrice(position: VenuePosition, tick: string): string {
  const mark = parseAmount(position.markPrice);
  const step = parseAmount(tick);
  const raw = position.side === 'long' ? (mark * (100n - CLOSE_SLIPPAGE_PERCENT)) / 100n : (mark * (100n + CLOSE_SLIPPAGE_PERCENT)) / 100n;
  const onTick = step > 0n ? (position.side === 'long' ? (raw / step) * step : ((raw + step - 1n) / step) * step) : raw;
  return formatAmount(onTick);
}

function Blotter({
  status,
  market,
  owner,
  account,
  run,
}: {
  status: VenueUp;
  market: VenueMarket;
  owner: string;
  account: VenueAccount;
  run: RunAction;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions');
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const [cancelResult, setCancelResult] = useState<ActionResult | null>(null);
  const positions = account.positions.data;
  return (
    <section className="dk-panel" data-testid="venue-blotter">
      <Tabs
        items={['positions', 'orders', 'history']}
        value={tab}
        onChange={(x) => setTab(x as typeof tab)}
        label={t('Positions')}
        labels={{ positions: t('Positions'), orders: t('Orders'), history: t('History') }}
      />
      {tab === 'positions' ? (
        <PositionsTable positions={positions} market={market} owner={owner} run={run} test={status.test} onDone={account.reload} />
      ) : tab === 'orders' ? (
        <>
          <OrdersTable
            orders={account.openOrders.data}
            test={status.test}
            cancelled={[]}
            onCancel={(o) => {
              const key = o.venueClientOrderId ? keysHeld.get(o.venueClientOrderId) : undefined;
              if (key)
                void run({ kind: 'cancel_order', symbol: o.symbol, clientOrderKey: key }).then(
                  (r) => (setCancelResult(r), account.reload()),
                );
            }}
          />
          <OutcomeLine result={cancelResult} owner={owner} />
        </>
      ) : (
        <>
          <Settlements owner={owner} test={status.test} />
          <History fills={account.fills.data} test={status.test} />
        </>
      )}
    </section>
  );
}

function PositionsTable({
  positions,
  market,
  owner,
  run,
  test,
  onDone,
}: {
  positions: AsOf<VenuePosition[]> | null;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  test: boolean;
  onDone: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const rows = positions?.value ?? [];
  return (
    <div data-testid="venue-positions">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="muted">{t('No positions')}</p>
      ) : (
        <DataTable
          label={t('Positions')}
          headers={[
            v('Market'),
            v('Side'),
            t('Size', { asset: market.baseAsset }),
            t('Entry'),
            t('Mark'),
            t('Unrealised'),
            t('Margin'),
            t('Leverage'),
            t('Liquidation price'),
            '',
          ]}
        >
          {rows.map((p) => (
            <tr key={p.symbol} data-symbol={p.symbol}>
              <td>{p.symbol}</td>
              <td>{word(v, 'side', p.side)}</td>
              <td className="numeric" data-cell="size">
                {p.size}
              </td>
              <td className="numeric" data-cell="entry">
                {p.entryPrice}
              </td>
              <td className="numeric" data-cell="mark">
                {p.markPrice}
              </td>
              <td className="numeric" data-cell="unrealised">
                {p.unrealisedPnl}
              </td>
              <td className="numeric" data-cell="margin">
                {p.margin}
              </td>
              <td className="numeric" data-cell="leverage">
                {`${leverageTimes(p.leverageBps)}x ${t(`mode_${p.marginMode}`)}`}
              </td>
              <td className="numeric" data-cell="liquidation">
                <Known value={p.liquidationPrice} render={(x) => x} />
              </td>
              <td>
                <CloseControl position={p} market={market} owner={owner} run={run} onDone={onDone} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <AsOfLine asOf={positions?.asOf ?? null} />
    </div>
  );
}

/**
 * Close part of a position: one reduce-only order at the market with its own close id. The id is held until the venue
 * answers definitely, so a double press or a lost answer is the same close, sent once: an answer that is not definite is
 * read back by its client id and Close waits for it. After a definite answer (filled, or a refused or cancelled IOC) the
 * next press is a new close with a new id.
 */
function CloseControl({
  position,
  market,
  owner,
  run,
  onDone,
}: {
  position: VenuePosition;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  onDone: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const [percent, setPercent] = useState('40');
  const [result, setResult] = useState<{ amount: string; result: ActionResult } | null>(null);
  const draft = useRef<{ percent: string; size: string; id: string } | null>(null);
  // The client id of a not-definite close the venue's own record has since settled.
  const [settledId, setSettledId] = useState<string | null>(null);
  const read = result?.result.kind === 'unknown' ? result.result : null;
  const unknown = read && read.clientOrderId !== settledId ? read : null;

  async function close() {
    if (unknown) return;
    const p = Number(percent);
    if (!Number.isInteger(p) || p < 1 || p > 100) return;
    // One close id per (percent, size) until a definite answer: a second press is the same close.
    if (!draft.current || draft.current.percent !== percent || draft.current.size !== position.size)
      draft.current = { percent, size: position.size, id: draftId() };
    const amount = p === 100 ? position.size : partOf(position.size, p, market.lotSize);
    const answer = await run({
      kind: 'place_order',
      symbol: position.symbol,
      side: position.side === 'long' ? 'sell' : 'buy',
      type: market.orderTypes.includes('market') ? 'market' : 'limit',
      amount,
      price: closeWorstPrice(position, market.tickSize),
      timeInForce: 'IOC',
      reduceOnly: true,
      clientOrderKey: keys.close(owner, position.symbol, draft.current.id),
      builderFee: null,
    });
    if (!keepsDraft(answer)) draft.current = null;
    setResult({ amount, result: answer });
    onDone();
  }

  return (
    <div className="form-stack" data-testid="venue-close">
      <label className="field">
        <span>{t('Close percent', { symbol: position.symbol })}</span>
        <input
          inputMode="numeric"
          aria-label={t('Close percent', { symbol: position.symbol })}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </label>
      <Button disabled={unknown !== null} onClick={() => void close()}>
        {t('Close button', { percent })}
      </Button>
      {result ? (
        <p role="status" data-testid="venue-close-outcome">
          {t('Close sent', { amount: displayAmount(result.amount), asset: market.baseAsset, outcome: outcomeText(v, result.result) })}
        </p>
      ) : null}
      {read?.clientOrderId ? (
        <ReadBack
          owner={owner}
          clientOrderId={read.clientOrderId}
          onSettled={() => {
            if (settledId === read.clientOrderId) return;
            // The venue's own record settled the close: the next press is a new close.
            draft.current = null;
            setSettledId(read.clientOrderId);
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}

/** History: the closed positions' realised result and fees, summed from the venue's fills, then every fill. */
function History({ fills, test }: { fills: AsOf<VenueFill[]> | null; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const closing = (fills?.value ?? []).filter((f) => f.realisedPnl !== null);
  const bySymbol = new Map<string, VenueFill[]>();
  for (const f of fills?.value ?? [])
    if (closing.some((c) => c.symbol === f.symbol)) bySymbol.set(f.symbol, [...(bySymbol.get(f.symbol) ?? []), f]);
  return (
    <div data-testid="venue-history">
      {bySymbol.size > 0 ? (
        <DataTable label={t('Closed positions')} headers={[v('Market'), v('Realised result'), v('Venue fee'), v('Our builder fee')]}>
          {[...bySymbol.entries()].map(([symbol, list]) => (
            <tr key={symbol} data-closed={symbol}>
              <td>{symbol}</td>
              <td className="numeric" data-cell="realised">
                {sumSigned(list.filter((f) => f.realisedPnl !== null).map((f) => f.realisedPnl!))}
              </td>
              <td className="numeric" data-cell="venue-fees">
                {sumSigned(list.map((f) => f.venueFee))}
              </td>
              <td className="numeric" data-cell="builder-fees">
                {sumDecimals(list.map((f) => f.builderFee))}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : null}
      <FillsTable fills={fills} test={test} />
    </div>
  );
}

/** How far back the history reads the venue's settlements. */
const SETTLEMENTS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The person's positions the venue settled, and orders it cancelled, when a market's deployer halted it or it split
 * (J-derivatives-27 #9 #10): each as the venue records it, with its time and realised result.
 */
function Settlements({ owner, test }: { owner: string; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const venue = useVenueApi();
  const since = useMemo(() => new Date(Date.now() - SETTLEMENTS_WINDOW_MS).toISOString(), []);
  const read = usePolled((signal) => venue.settlements(owner, since, signal), `settlements:${owner}`, VENUE_POLL_MS);
  const rows: VenueSettlement[] = read.data?.value ?? [];
  if (rows.length === 0) return null;
  return (
    <div data-testid="venue-settlements">
      <DataTable
        label={t('Settlements')}
        headers={[
          t('Settlement market'),
          t('Settlement why'),
          t('Settlement position'),
          t('Settlement price'),
          t('Settlement result'),
          t('Settlement cancelled'),
          t('Settlement time'),
        ]}
      >
        {rows.map((s) => (
          <tr key={`${s.symbol}:${s.settledAt}`} data-settled={s.symbol} data-kind={s.kind} data-at={s.settledAt}>
            <td>
              {s.symbol} <TestMark test={test} />
            </td>
            <td data-cell="why">{t(`settlement_${s.kind}`)}</td>
            <td className="numeric" data-cell="position">
              {s.side === null ? t('Settlement no position') : t('Settlement position value', { side: t(`side_${s.side}`), size: s.size })}
            </td>
            <td className="numeric" data-cell="price">
              {s.price}
            </td>
            <td className="numeric" data-cell="realised">
              {s.realisedPnl}
            </td>
            <td className="numeric" data-cell="cancelled">
              {String(s.cancelledOrders.length)}
            </td>
            <td data-cell="time">
              <time dateTime={s.settledAt}>{s.settledAt}</time>
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const sumSigned = (values: string[]) => formatAmount(values.reduce((total, x) => total + parseAmount(x), 0n));
