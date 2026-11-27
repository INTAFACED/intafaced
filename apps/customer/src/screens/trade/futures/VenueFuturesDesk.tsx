import { venueBound } from '@intafaced/contracts/venue-price';
import { ActionLimitWarning } from '../../../features/trade';
import { useMemo, useRef, useState } from 'react';
import { DeskTemplate, KeyValue } from '@intafaced/ui/lit/templates';
import { VenueMarketPanel } from '../desk/VenueMarketData';
import '../desk/exchange-desk.css';
import { Button, Field, Segmented, Switch } from '@intafaced/ui/lit';
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
  type VenueBestPrices,
  type VenueGatedContract,
  type VenueMarginMode,
  type VenueMarket,
  type VenueOrder,
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
  heldTags,
  outcomeText,
  keepsDraft,
  ReadBack,
  useAsOfText,
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
import { VenueSessionPanel, useDeskSession } from '../../../features/trade/venue/VenueSession';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { futuresVenueCopy } from './venue-copy';
import { slippageLimit, venueSelfTrade } from '../desk/venue-desk';
import { useApi } from '../../../features/session';
import { readRateCosts } from '../../../features/developers';
import { useResource } from '../../../shared/resource';
import { useReveal } from '../../../shared/reveal';
import { VenueCancelMany, VenueEditOrder } from '../desk/VenueOrderChanges';
import { VenueDeadMan } from '../desk/VenueDeadMan';
import { spotVenueCopy } from '../desk/venue-copy';
import { RoutedReview, VenueRoutes } from './VenueRoutes';
import { ProtectDialog, ReverseDialog, refusalOf, useSignPrepared } from './VenueProtect';
import { venueProtectCopy } from './venue-protect-copy';
import { VenueCollateral, VenueTiers } from './VenueRisk';
import { VenueCalculator } from './VenueCalculator';
import { NotOfferedChips } from '../desk/VenueOrderOptions';
import { ticketSummary } from './ticket-summary';
import { RiskStrip } from './RiskStrip';
import { positionLines, sizeFromRisk, type PositionLine } from './risk-strip';
import type { ChartOrderLine } from '../chart/PriceChart';
import { VenueSplitReview, type SplitReviewData } from './VenueSplitReview';
import { VenueTierConfirm } from './VenueTierConfirm';
import { venueRiskCopy } from './venue-risk-copy';
import { VenueFunding } from './VenueFunding';
import { VenueAccount as VenueAccountPanel } from './VenueAccount';
import { intervalText } from './venue-funding-logic';
import { bpsToPercent, clampToBand, planSplitOrders, projectedVenueTier, roomLeft, takenAssets } from './venue-risk-logic';
import { canonical, protectionClientId } from './venue-protect-logic';
import type { RoutePreview } from '../../../features/trade/venue-api';

/** Resting order types the futures desk names; any the venue does not list is shown with its refusal and sends nothing. */
const RESTING_TYPES = ['stop', 'take_profit', 'trailing_stop'] as const;
const MODES: readonly VenueMarginMode[] = ['isolated', 'cross'];
/** A label the person puts on an order: the orders room's own rule (up to 36 letters, digits and . _ : -, no spaces). */
export const ORDER_LABEL = /^[A-Za-z0-9._:-]{1,36}$/;

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
      <div data-testid="if-futures" className="lt-stack" data-venue="on">
        <p className="lt-callout lt-callout-bad" role="alert" data-testid="venue-down">
          {v('Venue unavailable', { detail: status.refusal.detail })}
        </p>
      </div>
    );
  }
  const perps = (markets.data?.value ?? []).filter((m) => m.kind === 'perpetual');
  const down = markets.failure?.code === 'trade.venue.venue_down';
  const head = (
    <>
      <VenueHeader status={status} title={t('Futures on venue')} />
      <ActionLimitWarning venueName={status.venue.displayName} />
      {down || markets.failure ? <ReadProblem failure={markets.failure} venueName={status.venue.displayName} /> : null}
    </>
  );
  if (markets.data && perps.length > 0)
    return (
      <div data-testid="if-futures" className="xd" data-venue="on">
        <Contracts status={status} perps={perps} requested={requested} head={head} />
      </div>
    );
  return (
    <div data-testid="if-futures" className="lt-stack" data-venue="on">
      {head}
      {/* The contracts band: its titles and lists keep the desk's inner margin. */}
      <div className="lt-stack">
        {markets.data && perps.length === 0 ? (
          <section className="lt-panel" aria-label={t('Contracts')} data-testid="venue-contracts">
            <h2 className="lt-panel-title">{t('Contracts')}</h2>
            <div data-testid="venue-no-contract">
              <p>{t('No contract')}</p>
              <p className="lt-quiet">{t('No contract reason', { venue: status.venue.displayName })}</p>
            </div>
          </section>
        ) : null}
        <GatedList status={status} />
      </div>
    </div>
  );
}

/**
 * J-derivatives-01 #2: every contract marked open or blocked for this account, with each reason as svc-trade's gated list
 * names it (the region and level gate, our builder fee, our listing, the venue's own state). It reads on its own, so a
 * person the region or level gate blocks still sees why. Drawn as one compact strip so the order ticket stays above the fold.
 */
function GatedList({ status }: { status: VenueUp }) {
  const { t } = futuresVenueCopy.useCopy();
  const venue = useVenueApi();
  const asOfText = useAsOfText();
  const gated = usePolled((signal) => venue.gatedList(signal), 'venue-gated-list', 5_000);
  const rows: VenueGatedContract[] = gated.data?.value ?? [];
  return (
    <section className="lt-panel" aria-label={t('Gated list')} data-testid="venue-gated-list">
      <div className="lt-row lt-row-between">
        <h2 className="lt-panel-title">
          {t('Gated list')} <TestMark test={status.test} />
        </h2>
        {gated.data ? (
          <p className="lt-quiet" data-testid="venue-gated-as-of">
            {asOfText(gated.data.asOf)}
          </p>
        ) : null}
      </div>
      <ReadProblem failure={gated.failure} venueName={status.venue.displayName} />
      <ul className="lt-toolbar">
        {rows.map((c) => (
          <li key={c.symbol} data-testid="venue-gate" data-symbol={c.symbol} data-open={c.open ? 'true' : 'false'}>
            <strong>{c.symbol}</strong> <span data-testid="venue-gate-state">{c.open ? t('Gated open') : t('Gated blocked')}</span>
            {c.blockers.length > 0 ? (
              <ul className="lt-stack-tight">
                {c.blockers.map((b) => (
                  <li key={b.code} data-code={b.code}>
                    {b.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The perps desk (desk A, the owner's pick): the contract and its figures across the
 * top, the venue's chart beside its book and tape, the ticket down the right in its own scroll, the positions and orders
 * under the chart. A venue that is down is named above; its controls still answer, each with the venue's typed refusal
 * and nothing sent.
 */
function Contracts({
  status,
  perps,
  requested,
  head,
}: {
  status: VenueUp;
  perps: VenueMarket[];
  requested: string | null;
  head: React.ReactNode;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const [chosen, setChosen] = useState<string>(perps.find((m) => m.symbol === requested)?.symbol ?? perps[0]!.symbol);
  const market = perps.find((m) => m.symbol === chosen) ?? perps[0]!;
  const owner = useOwner();
  const account = useVenueAccount(owner, { positions: true });
  // A venue whose orders a trading session's key signs (status `tradesSignedBy`): the desk signs with this tab's live key.
  const session = useDeskSession(owner, status);
  const { run, resend } = useVenueActions(owner, session.signing);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const ticketRef = useRef<HTMLDivElement>(null);
  // A phone: the ticket is far below the chart, so Long and Short wait at the bottom and bring it into view.
  const toTicket = (s: 'buy' | 'sell') => {
    setSide(s);
    ticketRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  return (
    <>
      <DeskTemplate
        title={t('Futures on venue')}
        mode="pro"
        state={{ kind: 'ready' }}
        instrument={
          <div className="lt-stack-tight">
            {head}
            <div className="xd-top">
              <ul className="xd-contracts" aria-label={t('Contracts')} data-testid="venue-contract-list">
                {perps.map((m) => (
                  <li key={m.symbol}>
                    <Button
                      tone="secondary"
                      aria-pressed={m.symbol === market.symbol}
                      aria-label={t('Contract on venue', { symbol: m.symbol, venue: status.venue.displayName })}
                      onClick={() => setChosen(m.symbol)}
                    >
                      <span className="xd-tile-symbol">{m.symbol}</span>
                      <span className="lt-num xd-tile-price">{m.mark.known ? displayAmount(m.mark.value) : '—'}</span>
                    </Button>
                  </li>
                ))}
                {/* One TEST mark for the whole list, not one per contract. */}
                <li>
                  <TestMark test={status.test} />
                </li>
              </ul>
              <div className="xd-risk-row">
                <RiskStrip
                  positions={account.positions.data?.value ?? []}
                  orders={account.openOrders.data?.value ?? []}
                  quote={market.quoteAsset}
                />
                {owner ? (
                  <FlattenHold
                    positions={account.positions.data?.value ?? []}
                    markets={perps}
                    owner={owner}
                    run={run}
                    closeSlippageBps={status.closeSlippageBps ?? null}
                  />
                ) : null}
              </div>
            </div>
          </div>
        }
        chart={
          <VenueMarketPanel
            key={`m:${market.symbol}`}
            market={market}
            test={status.test}
            venueName={status.venue.displayName}
            chartLines={positionLines(
              account.positions.data?.value.find((p) => p.symbol === market.symbol),
              account.openOrders.data?.value ?? [],
            ).map((line) =>
              chartLineOf(
                line,
                t,
                account.positions.data?.value.find((p) => p.symbol === market.symbol),
              ),
            )}
          />
        }
        ticket={
          <div className="lt-stack" ref={ticketRef}>
            {/* No wallet yet: connecting it comes first. Connected: the ticket comes first, the wallet under it. */}
            {owner ? null : <WalletBar />}
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
            {owner ? <WalletBar /> : null}
            {owner ? <VenueSessionPanel session={session} owner={owner} status={status} /> : null}
            {owner && market.marginAccount?.known ? (
              <MarketMarginStep key={`mm:${market.symbol}`} market={market} owner={owner} run={run} test={status.test} />
            ) : null}
            {owner ? <MarginStep key={market.symbol} market={market} owner={owner} run={run} test={status.test} disabled={false} /> : null}
            <ReadProblem failure={account.balances.failure} venueName={status.venue.displayName} />
            {owner ? <BalancesPanel balances={account.balances.data} test={status.test} /> : null}
            {owner ? (
              <VenueCollateral market={market} venueName={status.venue.displayName} balances={account.balances.data} test={status.test} />
            ) : null}
          </div>
        }
        orders={
          <div className="xd-under">
            <div className="lt-stack">
              {owner ? <Blotter status={status} market={market} owner={owner} account={account} run={run} /> : null}
              {owner && status.routes ? <PrimaryLeverageRoutes symbol={market.symbol} owner={owner} side={side} run={run} /> : null}
              {owner ? <VenueAccountPanel status={status} owner={owner} /> : null}
            </div>
            <div className="lt-stack">
              {/* The contract's fixed specs sit under the positions: the top of the desk is for prices and risk. */}
              <ContractStrip market={market} test={status.test} />
              <GatedList status={status} />
              <MarketRules market={market} venueName={status.venue.displayName} test={status.test} />
              <VenueTiers market={market} venueName={status.venue.displayName} test={status.test} />
            </div>
          </div>
        }
      />
      <div className="xd-phone-bar" role="group" aria-label={t('Ticket')} data-testid="venue-phone-bar">
        <Button tone="up" onClick={() => toTicket('buy')}>
          {t('Long')}
        </Button>
        <Button tone="down" onClick={() => toTicket('sell')}>
          {t('Short')}
        </Button>
      </div>
    </>
  );
}

/** The venues strip, with the leverage the person set on the primary venue for "set here" on the others (J-derivatives-28). */
function PrimaryLeverageRoutes({ symbol, owner, side, run }: { symbol: string; owner: string; side: 'buy' | 'sell'; run: RunAction }) {
  const venue = useVenueApi();
  const lev = usePolled((signal) => venue.leverage(owner, symbol, signal), `lev:${owner}:${symbol}`, VENUE_POLL_MS);
  return <VenueRoutes symbol={symbol} owner={owner} side={side} run={run} leverage={lev.data?.value ?? null} />;
}

function ContractStrip({ market, test }: { market: VenueMarket; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const funding = market.funding.known ? market.funding.value : null;
  return (
    <section className="lt-panel" aria-label={t('Contract strip')} data-testid="venue-contract-strip">
      <h2 className="lt-panel-title">
        {market.symbol} <TestMark test={test} />
      </h2>
      <dl className="lt-kv">
        <div>
          <dt>{t('Family')}</dt>
          <dd data-testid="venue-family">{t('family_perpetual')}</dd>
        </div>
        <div>
          <dt>{t('Settle asset')}</dt>
          <dd data-testid="venue-settle-asset">{market.quoteAsset}</dd>
        </div>
        <div>
          <dt>{t('Contract size')}</dt>
          <dd className="lt-num" data-testid="venue-contract-size">
            {market.contractSize.known
              ? t('Contract size value', { size: market.contractSize.value, base: market.baseAsset })
              : t('Not published')}
          </dd>
        </div>
        <div>
          <dt>{t('Lot size')}</dt>
          <dd className="lt-num">{t('Lot size value', { lot: market.lotSize, base: market.baseAsset })}</dd>
        </div>
        <div>
          <dt>{t('Tick size')}</dt>
          <dd className="lt-num">{market.tickSize}</dd>
        </div>
        <div>
          <dt>{t('Max leverage')}</dt>
          <dd className="lt-num" data-testid="venue-max-leverage">
            {market.maxLeverageBps === null ? <Known value={{ known: false }} /> : `${leverageTimes(market.maxLeverageBps)}x`}
          </dd>
        </div>
        <div>
          <dt>{t('Mark price')}</dt>
          <dd className="lt-num" data-testid="venue-mark" data-value={market.mark.known ? market.mark.value : undefined}>
            {market.mark.known ? displayAmount(market.mark.value) : t('Not published')}
          </dd>
        </div>
        <div>
          <dt>{t('Funding')}</dt>
          <dd data-testid="venue-funding" data-rate={funding?.rate}>
            {funding ? (
              <>
                <span className="lt-num" data-testid="venue-funding-rate">
                  {t('Funding rate value', { percent: percentOf(funding.rate), every: intervalText(funding.intervalSeconds) })}
                </span>{' '}
                {t('Funding next')}{' '}
                <time dateTime={funding.nextFundingAt} data-testid="venue-funding-next">
                  {new Date(funding.nextFundingAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
                </time>
              </>
            ) : (
              t('Not published')
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** A signed scaled fraction as a percent, digit for digit (`0.0000125` is `0.00125`): the decimal point moved two places. */
export function percentOf(fraction: string): string {
  const negative = fraction.startsWith('-');
  const [whole = '0', part = ''] = (negative ? fraction.slice(1) : fraction).split('.');
  const padded = part.padEnd(2, '0');
  const int = `${whole}${padded.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = padded.slice(2).replace(/0+$/, '');
  const out = rest ? `${int}.${rest}` : int;
  return negative && /[1-9]/.test(out) ? `-${out}` : out;
}

/**
 * The order rate that applies on a venue market (J-derivatives-04 #7). The venue publishes none to this desk, so the
 * limit in force is the INTAFACED edge's own per-address limit, read from the edge as it enforces it, and the row says
 * so; an edge with its limiter off says that no limit of ours applies. Never "unlimited", never a typed figure.
 */
function OrderRate() {
  const { t } = futuresVenueCopy.useCopy();
  const api = useApi();
  const read = useResource((signal) => readRateCosts(api, signal), 'edge-rate-costs').resource;
  if (read.status === 'loading')
    return (
      <dd data-testid="venue-order-rate" data-state="loading">
        {t('rate_loading')}
      </dd>
    );
  const limit = read.status === 'ready' ? read.data.edgeLimit : undefined;
  if (limit === undefined)
    return (
      <dd data-testid="venue-order-rate" data-state="unknown">
        {t('rate_edge_unknown')}
      </dd>
    );
  if (limit === null)
    return (
      <dd data-testid="venue-order-rate" data-state="edge-off">
        {t('rate_edge_off')}
      </dd>
    );
  const window =
    limit.windowMs % 1000 === 0 ? t('window_seconds', { n: String(limit.windowMs / 1000) }) : t('window_ms', { n: String(limit.windowMs) });
  return (
    <dd data-testid="venue-order-rate" data-state="edge" data-max={limit.max} data-window-ms={limit.windowMs}>
      {t('rate_edge', { max: String(limit.max), window })}
    </dd>
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
  const v = venueCopy.useCopy().t;
  const text = (value: MaybeKnown<string>) => (value.known ? value.value : t('Not published'));
  const feed = market.feed.known ? market.feed.value : null;
  const selfTrade = venueSelfTrade(market);
  return (
    <section className="lt-panel" aria-label={t('Market rules', { symbol: market.symbol })} data-testid="venue-market-rules">
      <h2 className="lt-panel-title">
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
      <dl className="lt-kv">
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
        <div>
          <dt>{t('Self trade rule')}</dt>
          <dd data-testid="venue-self-trade-rule" data-mode={selfTrade ?? 'unknown'}>
            {selfTrade ? word(v, 'stp', selfTrade) : t('Not published')}
          </dd>
        </div>
        <div>
          <dt>{t('Order rate')}</dt>
          <OrderRate />
        </div>
        {market.openInterest?.known ? (
          <>
            <div>
              <dt>{t('Open interest')}</dt>
              <dd className="lt-num" data-testid="venue-open-interest">
                {t('Open interest value', { size: market.openInterest.value.size, base: market.baseAsset })}
              </dd>
            </div>
            <div>
              <dt>{t('Open interest cap')}</dt>
              <dd className="lt-num" data-testid="venue-open-interest-cap">
                {market.openInterest.value.capSize === null
                  ? t('Open interest no cap')
                  : market.listedBy.known && market.listedBy.value.kind === 'venue'
                    ? t('Open interest venue cap value', { cap: market.openInterest.value.capSize, base: market.baseAsset })
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
      <dl className="lt-kv">
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
          <dd className="lt-num" data-testid="venue-off-hours-leverage">
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
    <section className="lt-panel" aria-label={t('Market margin')} data-testid="venue-market-margin">
      <h2 className="lt-panel-title">
        {t('Market margin')} <TestMark test={test} />
      </h2>
      <p data-testid="venue-market-margin-note">{t('Market margin note', { name: rule.name, symbol: market.symbol })}</p>
      <ReadProblem failure={read.failure} venueName={rule.name} />
      <dl className="lt-kv">
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
          <dd className="lt-num" data-testid="venue-market-margin-free">
            {held ? held.free : ''}
          </dd>
        </div>
        <div>
          <dt>{t('Market margin used')}</dt>
          <dd className="lt-num" data-testid="venue-market-margin-used">
            {held ? held.locked : ''}
          </dd>
        </div>
        <div>
          <dt>{t('Market margin total')}</dt>
          <dd className="lt-num" data-testid="venue-market-margin-total">
            {held ? held.total : ''}
          </dd>
        </div>
      </dl>
      {read.data ? <AsOfLine asOf={read.data.asOf} /> : null}
      <label className="lt-field">
        <span>{t('Market margin amount', { asset: rule.collateralAsset })}</span>
        <input
          inputMode="decimal"
          aria-label={t('Market margin amount', { asset: rule.collateralAsset })}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <Button tone="secondary" onClick={() => void move('into_market')}>
        {t('Market margin in')}
      </Button>
      <Button tone="secondary" onClick={() => void move('out_of_market')}>
        {t('Market margin out')}
      </Button>
      {problem ? (
        <p className="lt-callout lt-callout-bad" role="alert">
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
    <section className="lt-panel" aria-label={t('Margin step')} data-testid="venue-margin">
      <h2 className="lt-panel-title">
        {t('Margin step')} <TestMark test={test} />
      </h2>
      <div role="radiogroup" aria-label={t('Margin mode')}>
        {MODES.map((m) => {
          const offered = market.marginModes.includes(m);
          return (
            <label key={m} className="lt-field" data-mode={m} data-offered={offered ? 'true' : 'false'}>
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
      <label className="lt-field">
        <span>{t('Leverage x')}</span>
        <input inputMode="numeric" aria-label={t('Leverage x')} value={times} onChange={(e) => setTimes(e.target.value)} />
      </label>
      <Button tone="secondary" disabled={disabled} onClick={() => void sign()}>
        {t('Sign leverage')}
      </Button>
      {problem ? (
        <p className="lt-callout lt-callout-bad" role="alert">
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
  const [typedSize, setSize] = useState('');
  const [fromRisk, setFromRisk] = useState(false);
  const [risk, setRisk] = useState('');
  const [price, setPrice] = useState('');
  const [adjustPrice, setAdjustPrice] = useState(false);
  const [marginAsset, setMarginAsset] = useState(market.quoteAsset);
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [label, setLabel] = useState('');
  const [attached, setAttached] = useState<Attached | null>(null);
  const p = venueProtectCopy.useCopy().t;
  const r = venueRiskCopy.useCopy().t;
  const signPrepared = useSignPrepared(owner);
  const best = usePolled((signal) => venue.bestPrices(market.symbol, signal), `best:${market.symbol}`, VENUE_POLL_MS);
  const [problem, setProblem] = useState<string | null>(null);
  const [problemCode, setProblemCode] = useState<string | null>(null);
  const [bandRefusal, setBandRefusal] = useState<string | null>(null);
  const [priceCorrected, setPriceCorrected] = useState<{ asked: string; applied: string } | null>(null);
  const [splitOffer, setSplitOffer] = useState<{
    parts: string[];
    capLabel: string;
    price: string;
    priceCorrected: { asked: string; applied: string } | null;
  } | null>(null);
  const [splitReview, setSplitReview] = useState<SplitReviewData | null>(null);
  const [splitResult, setSplitResult] = useState<ActionResult | null>(null);
  const [splitPlaced, setSplitPlaced] = useState<{
    count: number;
    legs: Array<{ size: string; price: string; status: string }>;
  } | null>(null);
  const [tierAccepted, setTierAccepted] = useState(false);
  const [review, setReview] = useState<{
    intent: OrderIntent;
    preview: AsOf<VenuePreview>;
    priceCorrected: { asked: string; applied: string } | null;
  } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [last, setLast] = useState<ActionResult | null>(null);
  const counter = useRef(0);
  const sending = useRef(false);
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const tags = useMemo(() => heldTags(owner), [owner]);
  /** The order's key held for a Cancel after a reload, and its label kept beside it (the venue stores no label). */
  const hold = (answer: ActionResult, intent: OrderIntent) => {
    if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId) {
      keysHeld.set(answer.clientOrderId, intent.clientOrderKey);
      if (label.trim() !== '') tags.set(answer.clientOrderId, label.trim());
    }
  };
  const assets = [...new Set([market.quoteAsset, ...(account.balances.data?.value.map((b) => b.asset) ?? [])])];
  const offered = market.orderTypes.filter((x): x is 'limit' | 'market' => x === 'limit' || x === 'market');
  const band = market.priceBand?.known ? market.priceBand.value : null;
  const slippageCap = best.data?.slippageCapBps ?? null;
  // A market order's worst price: the best price on the side it meets plus the owner's slippage cap, the bound svc-trade
  // itself puts on every market order; null with the cap blank or no best price on that side.
  const marketBound = (on: 'buy' | 'sell') =>
    best.data && best.data.slippageCapBps.known
      ? slippageLimit(on, best.data.value, best.data.slippageCapBps.value, market.tickSize)
      : null;
  // Size from my risk (desk A, from desk B): a limit enters at its price, a market order at the best price it meets.
  const entry = type === 'limit' ? price.trim() || null : ((side === 'buy' ? best.data?.value.ask : best.data?.value.bid) ?? null);
  const sized = fromRisk ? sizeFromRisk({ risk, entry, stop: stopLoss, lot: market.lotSize, side }) : null;
  const size = sized ? (sized.ok ? sized.size : '') : typedSize;
  // Desk A's ticket summary: what this order would be, before the venue's own review; an unknown figure waits for it.
  const summary = ticketSummary({
    market,
    side,
    size,
    entry,
    position: account.positions.data?.value.find((x) => x.symbol === market.symbol),
    builderFeeBps: status.builder?.feeBps ?? null,
  });
  const quoted = (value: string | null) => (value === null ? t('At review') : `${displayAmount(value)} ${market.quoteAsset}`);

  function clearChecks() {
    setProblem(null);
    setProblemCode(null);
    setBandRefusal(null);
    setPriceCorrected(null);
    setSplitOffer(null);
    setSplitPlaced(null);
    setTierAccepted(false);
  }

  async function openReview() {
    clearChecks();
    setResult(null);
    setAttached(null);
    // What the venue publishes it takes as margin decides, naming the venue (J-derivatives-02 #4); with no list published,
    // a perpetual's margin is its settle asset.
    const taken = takenAssets(market);
    if (taken && !taken.includes(marginAsset))
      return setProblem(
        r('Margin not taken', { venue: status.venue.displayName, asset: marginAsset, symbol: market.symbol, taken: taken.join(', ') }),
      );
    if (!taken && marginAsset !== market.quoteAsset)
      return setProblem(t('Margin mismatch', { symbol: market.symbol, settle: market.quoteAsset, asset: marginAsset }));
    if (label.trim() !== '' && !ORDER_LABEL.test(label.trim())) return setProblem(t('Label bad'));
    if (!size.trim()) return setProblem(v('Enter amount'));
    // A market order with its worst price left blank goes at the bound; the review names it either way.
    const typed = type === 'market' && !price.trim() ? (marketBound(side) ?? '') : price;
    if (typed !== price) setPrice(typed);
    if (!typed.trim()) return setProblem(v('Enter price'));
    if (!onStep(size, market.lotSize)) return setProblem(v('Not a step', { field: v('Amount'), step: market.lotSize }));
    if (!onStep(typed, market.tickSize)) return setProblem(v('Not a step', { field: v('Price'), step: market.tickSize }));

    const askedSize = canonicalDecimal(size);
    const askedPrice = canonicalDecimal(typed);
    // A market order's worst price on the wrong side of the best price it meets cannot fill: refused before it is sent.
    // The best price is read fresh here, not from the last poll; with no read, the review still names the worst price.
    const now = type === 'market' ? await venue.bestPrices(market.symbol) : null;
    const meets = now?.ok ? (side === 'buy' ? now.data.value.ask : now.data.value.bid) : null;
    if (meets && (side === 'buy' ? parseAmount(askedPrice) < parseAmount(meets) : parseAmount(askedPrice) > parseAmount(meets))) {
      setProblemCode('trade.venue.worst_price_wrong_side');
      return setProblem(
        t(side === 'buy' ? 'Worst price wrong side buy' : 'Worst price wrong side sell', {
          price: displayAmount(askedPrice),
          best: displayAmount(meets),
          quote: market.quoteAsset,
        }),
      );
    }
    let effectivePrice = askedPrice;
    let corrected: { asked: string; applied: string } | null = null;
    let outsideBand: string | null = null;

    if (type === 'limit' && band) {
      const check = clampToBand(askedPrice, band, market.tickSize);
      if (check.outside) {
        if (adjustPrice) {
          effectivePrice = check.adjusted;
          corrected = { asked: askedPrice, applied: effectivePrice };
          setPriceCorrected(corrected);
        } else {
          outsideBand = r('Price outside band', {
            price: askedPrice,
            quote: market.quoteAsset,
            venue: status.venue.displayName,
            low: displayAmount(band.bandLow),
            high: displayAmount(band.bandHigh),
            width: bpsToPercent(band.widthBps),
          });
          setBandRefusal(outsideBand);
        }
      }
    }

    const split = planSplitOrders(askedSize, effectivePrice, market);
    if (split) {
      if (!split.splitable) {
        setProblemCode('trade.venue.order_above_venue_max');
        setProblem(r('Order above cap unsplit', { venue: status.venue.displayName, cap: split.capLabel }));
      } else {
        setProblemCode('trade.venue.order_above_venue_max');
        setProblem(r('Order above cap', { venue: status.venue.displayName, cap: split.capLabel, parts: String(split.parts.length) }));
        setSplitOffer({ parts: split.parts, capLabel: split.capLabel, price: effectivePrice, priceCorrected: corrected });
      }
      return;
    }
    if (outsideBand) return;

    const trimmedLabel = label.trim();
    const intent: OrderIntent = {
      kind: 'place_order',
      symbol: market.symbol,
      side,
      type,
      amount: askedSize,
      price: effectivePrice,
      timeInForce: type === 'market' ? 'IOC' : (market.timeInForce[0] ?? 'GTC'),
      reduceOnly,
      clientOrderKey: keys.order(owner, market.symbol, draftId(Date.now(), counter.current++)),
      builderFee: null,
      ...(trimmedLabel !== '' ? { label: trimmedLabel } : {}),
    };
    if (status.routes) {
      // J-derivatives-28: several venues, so the router chooses one for this order and says why.
      const route = await venue.routePreview(owner, intent);
      if (!route.ok) {
        setProblemCode(route.code ?? null);
        return setProblem(v('Outcome refused', { detail: route.message }));
      }
      setRouted({ intent, route: route.data });
      return;
    }
    const preview = await venue.preview(owner, intent);
    if (!preview.ok) {
      // Past the open-interest cap: the venue's reason, and the room left where the venue reports both figures (J-derivatives-02 #7).
      // The figures are read fresh from the venue, so the room is the venue's now, not the desk's last poll.
      const fresh = preview.code === 'trade.venue.open_interest_above_cap' ? await venue.markets() : null;
      const now = fresh?.ok ? fresh.data.value.find((m) => m.symbol === market.symbol) : undefined;
      const room = now ? roomLeft(now) : null;
      const refused = v('Outcome refused', { detail: preview.message });
      setProblemCode(preview.code ?? null);
      return setProblem(room === null ? refused : `${refused}. ${r('Room left', { room: displayAmount(room), base: market.baseAsset })}`);
    }
    setTierAccepted(false);
    setReview({ intent, preview: preview.data, priceCorrected: corrected });
  }

  async function openSplitReview() {
    if (!splitOffer || bandRefusal) return;
    const most = status.ordersPerAction ?? 1;
    if (splitOffer.parts.length > most) {
      setProblemCode('trade.venue.not_offered');
      return setProblem(
        r('Split too many', { parts: String(splitOffer.parts.length), venue: status.venue.displayName, max: String(most) }),
      );
    }
    const actionKey = keys.split(owner, market.symbol, draftId(Date.now(), counter.current++));
    const trimmedLabel = label.trim();
    const orders: OrderIntent[] = splitOffer.parts.map((part, i) => ({
      kind: 'place_order',
      symbol: market.symbol,
      side,
      type,
      amount: part,
      price: splitOffer.price,
      timeInForce: type === 'market' ? 'IOC' : (market.timeInForce[0] ?? 'GTC'),
      reduceOnly,
      clientOrderKey: `${actionKey}:${i + 1}`,
      builderFee: null,
      ...(trimmedLabel !== '' ? { label: trimmedLabel } : {}),
    }));
    const previews: AsOf<VenuePreview>[] = [];
    for (const order of orders) {
      const answered = await venue.preview(owner, order);
      if (!answered.ok) {
        setProblemCode(answered.code ?? null);
        return setProblem(v('Outcome refused', { detail: answered.message }));
      }
      previews.push(answered.data);
    }
    const tier = projectedVenueTier(
      market,
      account.positions.data?.value ?? [],
      side,
      canonicalDecimal(size),
      splitOffer.price,
      reduceOnly,
    );
    setSplitResult(null);
    setSplitReview({ actionKey, orders, previews, priceCorrected: splitOffer.priceCorrected, tier });
  }

  async function confirmSplit() {
    if (!splitReview || sending.current) return;
    sending.current = true;
    const answer = await run(
      { kind: 'place_orders', actionKey: splitReview.actionKey, orders: splitReview.orders },
      { actionKey: splitReview.actionKey },
    );
    sending.current = false;
    setSplitResult(answer);
    setLast(answer);
    account.reload();
    if (answer.kind === 'outcome' && answer.outcome.accepted) {
      const legs = (answer.outcome.legs ?? []).map((leg, i) => {
        const ord = splitReview.orders[i]!;
        if (leg.accepted && leg.order?.venueClientOrderId) {
          keysHeld.set(leg.order.venueClientOrderId, ord.clientOrderKey);
          if (ord.label) tags.set(leg.order.venueClientOrderId, ord.label);
        }
        return {
          size: ord.amount,
          price: ord.price,
          status: leg.accepted ? word(v, 'status', leg.order?.status ?? 'open') : leg.refusal.detail,
        };
      });
      setSplitReview(null);
      setSplitOffer(null);
      setProblem(null);
      setProblemCode(null);
      setSplitPlaced({ count: splitReview.orders.length, legs });
    }
  }

  async function confirm() {
    if (!review || sending.current) return;
    sending.current = true;
    const answer = await run(review.intent);
    sending.current = false;
    hold(answer, review.intent);
    setResult(answer);
    setLast(answer);
    account.reload();
    if (answer.kind === 'outcome' && answer.outcome.accepted) await attach(review.intent, answer.outcome.order?.filled ?? '0');
  }

  /**
   * The ticket's take profit and stop loss, attached to the entry once it filled (J-derivatives-03 #4): each on the size it
   * filled, on the other side, and each a trigger order the person signs in their wallet.
   */
  async function attach(entry: OrderIntent, filledRaw: string) {
    const legs = (
      [
        ['take_profit', takeProfit.trim()],
        ['stop_loss', stopLoss.trim()],
      ] as const
    ).filter(([, price]) => price !== '');
    if (entry.reduceOnly || legs.length === 0) return;
    const filled = canonical(filledRaw);
    if (parseAmount(filled) <= 0n) return setAttached({ state: 'nothing' });
    setAttached({ state: 'working' });
    const set: Array<'take_profit' | 'stop_loss'> = [];
    for (const [kind, price] of legs) {
      const created = await venue.createProtection({
        owner,
        symbol: entry.symbol,
        kind,
        side: entry.side === 'buy' ? 'sell' : 'buy',
        quantity: filled,
        triggerPrice: canonical(price),
        triggerSource: (market.triggerSources ?? []).includes('mark') ? 'mark' : (market.triggerSources?.[0] ?? 'mark'),
        clientOrderId: protectionClientId(Date.now(), counter.current++),
        attachTo: entry.clientOrderKey,
      });
      const refused = !created.ok
        ? { message: created.message, code: created.code ?? null }
        : created.data.restsOn === 'venue'
          ? refusalOf(await signPrepared(created.data), (r) => outcomeText(v, r))
          : null;
      if (refused) return setAttached({ state: 'failed', kind, filled, set, refusal: refused });
      set.push(kind);
    }
    setAttached({ state: 'done', filled, set });
  }

  const perp = review?.preview.value.perpetual ?? null;
  const total = review ? totalToCommit(review.preview.value) : null;
  const reviewTier =
    perp?.riskTier ??
    (review
      ? projectedVenueTier(
          market,
          account.positions.data?.value ?? [],
          review.intent.side,
          review.intent.amount,
          review.intent.price,
          review.intent.reduceOnly,
        )
      : null);
  const needsTierConfirm = reviewTier?.confirmRequired === true;
  return (
    <section className="lt-panel" aria-label={t('Ticket')} data-testid="venue-ticket">
      <h2 className="lt-panel-title">{t('Ticket')}</h2>
      <Segmented
        options={[
          { value: 'buy', label: t('Long') },
          { value: 'sell', label: t('Short') },
        ]}
        value={side}
        onChange={(s) => {
          setSide(s as 'buy' | 'sell');
          if (type === 'market') setPrice(marketBound(s as 'buy' | 'sell') ?? '');
          clearChecks();
        }}
        label={t('Ticket')}
      />
      <div role="group" aria-label={t('Order types')} data-testid="venue-order-types">
        {offered.map((x) => (
          <Button
            key={x}
            tone={type === x ? 'secondary' : 'quiet'}
            aria-pressed={type === x}
            onClick={() => {
              // A price typed for one order type is never carried into the other: a market order's worst price starts
              // at the bound svc-trade puts on it (best price plus the slippage cap), a limit's price starts blank.
              if (x !== type) setPrice(x === 'market' ? (marketBound(side) ?? '') : '');
              setType(x);
              clearChecks();
            }}
          >
            {word(v, 'type', x)}
          </Button>
        ))}
        <NotOfferedChips types={RESTING_TYPES.filter((x) => !market.orderTypes.includes(x))} />
      </div>
      <div className="xd-switch-row">
        <span aria-hidden="true">{t('Size from my risk')}</span>
        <Switch
          label={t('Size from my risk')}
          checked={fromRisk}
          onChange={(on) => {
            setFromRisk(on);
            clearChecks();
          }}
        />
      </div>
      {fromRisk ? (
        <Field
          label={t('Risk amount', { asset: market.quoteAsset })}
          inputMode="decimal"
          value={risk}
          onChange={(e) => {
            setRisk(e.target.value);
            clearChecks();
          }}
        />
      ) : null}
      <label className="lt-field">
        <span>{t('Size', { asset: market.baseAsset })}</span>
        <input
          inputMode="decimal"
          aria-label={t('Size', { asset: market.baseAsset })}
          value={size}
          readOnly={fromRisk}
          onChange={(e) => {
            setSize(e.target.value);
            clearChecks();
          }}
        />
      </label>
      {sized ? (
        <p className="lt-note" data-testid="venue-risk-size">
          {sized.ok ? t('Sized from risk', { risk, asset: market.quoteAsset }) : t(`risk_size_${sized.reason}`)}
        </p>
      ) : null}
      <label className="lt-field">
        <span>{type === 'market' ? t('Worst price') : t('Price')}</span>
        <input
          inputMode="decimal"
          aria-label={type === 'market' ? t('Worst price') : t('Price')}
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
            clearChecks();
          }}
        />
      </label>
      {type === 'limit' ? (
        <div className="lt-stack-tight" data-testid="venue-price-band">
          <p className="lt-note">
            <strong>{r('Price band')}:</strong>{' '}
            {band
              ? r('Price band range', {
                  low: displayAmount(band.bandLow),
                  high: displayAmount(band.bandHigh),
                  quote: market.quoteAsset,
                  width: bpsToPercent(band.widthBps),
                })
              : r('Price band not published', { venue: status.venue.displayName })}
          </p>
          {band?.widened ? (
            <p className="lt-note" role="status" data-testid="venue-price-band-widened">
              {r('Price band widened', {
                width: bpsToPercent(band.widthBps),
                usual: bpsToPercent(band.usualWidthBps),
                reason: band.reason ?? '',
              })}
            </p>
          ) : null}
          {band ? (
            <div className="lt-stack-tight">
              <div className="lt-row lt-row-between">
                <span className="lt-quiet">{r('Price correction')}</span>
                <Switch
                  label={r('Price correction')}
                  checked={adjustPrice}
                  onChange={(on) => {
                    setAdjustPrice(on);
                    clearChecks();
                  }}
                />
              </div>
              <p className="lt-note">{adjustPrice ? r('Price correction on') : r('Price correction off')}</p>
            </div>
          ) : null}
        </div>
      ) : !reduceOnly && slippageCap !== null ? (
        <p className="lt-note" data-testid="venue-slippage-cap" data-code={slippageCap.known ? undefined : 'trade.slippage_cap_unset'}>
          <strong>{r('Slippage cap')}:</strong>{' '}
          {slippageCap.known ? r('Slippage cap bps', { bps: slippageCap.value }) : r('Slippage cap unset')}
        </p>
      ) : null}
      <label className="lt-field">
        <span>{p('Take profit optional')}</span>
        <input
          inputMode="decimal"
          aria-label={p('Take profit optional')}
          value={takeProfit}
          onChange={(e) => setTakeProfit(e.target.value)}
        />
      </label>
      <label className="lt-field">
        <span>{p('Stop loss optional')}</span>
        <input inputMode="decimal" aria-label={p('Stop loss optional')} value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
      </label>
      <label className="lt-field">
        <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
        <span>{p('Reduce-only')}</span>
      </label>
      <label className="lt-field">
        <span>{t('Label optional')}</span>
        <input aria-label={t('Label optional')} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="lt-field">
        <span>{t('Margin asset')}</span>
        <select aria-label={t('Margin asset')} value={marginAsset} onChange={(e) => setMarginAsset(e.target.value)}>
          {assets.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      {/* The summary and the one primary button stay pinned at the ticket column's foot, so a long ticket never hides them. */}
      <div className="xd-ticket-go">
        {summary ? (
          <div data-testid="venue-ticket-summary">
            <KeyValue
              rows={[
                { label: t('Order value'), value: quoted(summary.value) },
                {
                  label: summary.leverage ? t('Margin at', { times: summary.leverage }) : t('Margin'),
                  value: quoted(summary.margin),
                },
                { label: t('Opening fee'), value: summary.fee === null ? t('Not published') : quoted(summary.fee) },
                { label: t('Line liquidation'), value: quoted(summary.liquidation) },
              ]}
            />
          </div>
        ) : null}
        <Button tone="primary" disabled={disabled} onClick={() => void openReview()}>
          {side === 'buy' ? t('Review long') : t('Review short')}
        </Button>
      </div>
      {priceCorrected ? (
        <p className="lt-note" role="status" data-testid="venue-price-moved">
          {r('Price moved')}:{' '}
          {r('Price moved value', { asked: priceCorrected.asked, applied: priceCorrected.applied, quote: market.quoteAsset })}
        </p>
      ) : null}
      {bandRefusal ? (
        <p className="lt-callout lt-callout-bad" role="alert" data-code="trade.venue.price_outside_venue_band">
          {bandRefusal}
        </p>
      ) : null}
      {problem ? (
        <p className="lt-callout lt-callout-bad" role="alert" data-code={problemCode ?? undefined}>
          {problem}
        </p>
      ) : null}
      {splitOffer ? (
        <section aria-label={r('Split title')} data-testid="venue-split-offer" className="lt-callout lt-stack-tight">
          <h3 className="lt-strong">{r('Split title')}</h3>
          <p>
            {r('Split body', {
              cap: splitOffer.capLabel,
              parts: String(splitOffer.parts.length),
              sizes: splitOffer.parts.map((x) => `${x} ${market.baseAsset}`).join(', '),
              price: splitOffer.price,
              quote: market.quoteAsset,
            })}
          </p>
          <Button tone="primary" disabled={bandRefusal !== null} onClick={() => void openSplitReview()}>
            {r('Split button', { parts: String(splitOffer.parts.length) })}
          </Button>
        </section>
      ) : null}
      {splitPlaced ? (
        <div role="status" data-testid="venue-split-placed" className="lt-callout lt-stack-tight">
          <h3 className="lt-strong">{r('Split placed heading', { parts: String(splitPlaced.count) })}</h3>
          <ul>
            {splitPlaced.legs.map((leg, i) => (
              <li key={`${i}:${leg.size}:${leg.price}`}>
                {r('Split child line', {
                  index: String(i + 1),
                  size: leg.size,
                  base: market.baseAsset,
                  price: leg.price,
                  quote: market.quoteAsset,
                  status: leg.status,
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <OutcomeLine result={review || routed || splitReview ? null : last} owner={owner} />
      {splitReview ? (
        <VenueSplitReview
          data={splitReview}
          side={side}
          market={market}
          status={status}
          account={account}
          owner={owner}
          run={run}
          result={splitResult}
          onConfirm={() => void confirmSplit()}
          onClose={() => {
            setSplitReview(null);
            setSplitResult(null);
          }}
        />
      ) : null}
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
            hold(answer, routed.intent);
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
          confirmDisabled={needsTierConfirm && !tierAccepted}
          beforeConfirm={
            needsTierConfirm && reviewTier && perp ? (
              <VenueTierConfirm
                symbol={market.symbol}
                tier={reviewTier}
                leverageTimes={leverageTimes(perp.leverageBps)}
                accepted={tierAccepted}
                onAccept={setTierAccepted}
              />
            ) : null
          }
          result={result}
          onConfirm={() => void confirm()}
          onClose={() => {
            setReview(null);
            setResult(null);
            setAttached(null);
            setTierAccepted(false);
          }}
          after={attached ? <AttachedLine attached={attached} /> : null}
          extra={
            perp ? (
              <>
                {reviewTier ? (
                  <div>
                    <dt>{r('Margin tier')}</dt>
                    <dd data-line="margin-tier">
                      {r('Margin tier value', {
                        tier: String(reviewTier.projected),
                        rate: percentOf(reviewTier.maintenanceRate),
                        maxLeverage: String(reviewTier.maxLeverageBps / 10_000),
                      })}
                    </dd>
                  </div>
                ) : null}
                {band ? (
                  <div>
                    <dt>{r('Price band')}</dt>
                    <dd className="lt-num" data-line="price-band">
                      {r('Price band range', {
                        low: displayAmount(band.bandLow),
                        high: displayAmount(band.bandHigh),
                        quote: market.quoteAsset,
                        width: bpsToPercent(band.widthBps),
                      })}
                      {band.widened
                        ? ` · ${r('Price band widened', {
                            width: bpsToPercent(band.widthBps),
                            usual: bpsToPercent(band.usualWidthBps),
                            reason: band.reason ?? '',
                          })}`
                        : ''}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t('Initial margin')}</dt>
                  <dd className="lt-num" data-line="initial-margin">
                    <Known value={perp.initialMargin} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Liquidation price')}</dt>
                  <dd className="lt-num" data-line="liquidation">
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
                  <dd className="lt-num" data-line="total">
                    <Known value={total === null ? { known: false } : { known: true, value: total }} /> {market.quoteAsset}
                  </dd>
                </div>
                {review.priceCorrected ? (
                  <div>
                    <dt>{r('Price moved')}</dt>
                    <dd className="lt-num" data-line="price-moved">
                      {r('Price moved value', {
                        asked: review.priceCorrected.asked,
                        applied: review.priceCorrected.applied,
                        quote: market.quoteAsset,
                      })}
                    </dd>
                  </div>
                ) : null}
                {review.intent.type === 'market' ? (
                  <div>
                    <dt>{t('Worst price')}</dt>
                    <dd className="lt-num" data-line="worst-price">
                      {t('Worst price value', { price: displayAmount(review.intent.price), quote: market.quoteAsset })}
                    </dd>
                  </div>
                ) : null}
                {review.intent.type === 'market' && !review.intent.reduceOnly && slippageCap?.known ? (
                  <div>
                    <dt>{r('Slippage cap')}</dt>
                    <dd className="lt-num" data-line="slippage-cap">
                      {r('Slippage cap bps', { bps: slippageCap.value })}
                    </dd>
                  </div>
                ) : null}
              </>
            ) : null
          }
        />
      ) : null}
    </section>
  );
}

type Attached =
  | { state: 'working' }
  | { state: 'nothing' }
  | { state: 'done'; filled: string; set: Array<'take_profit' | 'stop_loss'> }
  | {
      state: 'failed';
      kind: 'take_profit' | 'stop_loss';
      filled: string;
      set: Array<'take_profit' | 'stop_loss'>;
      refusal: { message: string; code: string | null };
    };

/** What became of the take profit and stop loss attached to an entry order. */
function AttachedLine({ attached }: { attached: Attached }) {
  const { t } = venueProtectCopy.useCopy();
  // What became of them is the last line of a tall review sheet: brought into view as each state arrives.
  const reveal = useReveal<HTMLElement>(attached.state, { onMount: true });
  const setWords = (set: Array<'take_profit' | 'stop_loss'>, filled: string) =>
    set.length === 2
      ? t('Attached both', { filled })
      : set[0] === 'take_profit'
        ? t('Attached take profit', { filled })
        : set[0] === 'stop_loss'
          ? t('Attached stop loss', { filled })
          : '';
  if (attached.state === 'failed') {
    return (
      <div ref={reveal} role="alert" className="lt-callout lt-callout-bad" data-testid="venue-attached-failed">
        {attached.set.length > 0 ? <p>{setWords(attached.set, attached.filled)}</p> : null}
        <p>{t('Attach failed', { kind: t(`kind_${attached.kind}`).toLowerCase(), detail: attached.refusal.message })}</p>
        {attached.refusal.code ? <p className="lt-quiet">{t('Code', { code: attached.refusal.code })}</p> : null}
      </div>
    );
  }
  return (
    <p ref={reveal} role="status" data-testid="venue-attached">
      {attached.state === 'working'
        ? t('Attaching')
        : attached.state === 'nothing'
          ? t('Attach nothing filled')
          : setWords(attached.set, attached.filled)}
    </p>
  );
}

/** Initial margin plus the venue's fee plus our builder fee, all the venue's figures in the settle asset; null when any is not known. */
export function totalToCommit(p: VenuePreview): string | null {
  const perp = p.perpetual;
  if (!perp || !perp.initialMargin.known || !p.venueFee.known || !p.builderFee.known) return null;
  if (p.venueFee.value.asset !== p.lock.asset || p.builderFee.value.asset !== p.lock.asset) return null;
  return sumDecimals([perp.initialMargin.value, p.venueFee.value.amount, p.builderFee.value.amount]);
}

/**
 * A market close's worst price: the owner's close tolerance (`/venue/status` `closeSlippageBps`, svc-trade's
 * TRADE_CLOSE_SLIPPAGE_BPS) from the venue's best price on the side the close meets, else from the mark. With the
 * tolerance blank svc-trade refuses the close by name (`trade.close_slippage_unset`); never a tolerance of our own.
 */
export function closeMarketPrice(
  position: VenuePosition,
  tick: string,
  read: { value: VenueBestPrices } | null,
  closeSlippageBps: number | null,
): string {
  const side = position.side === 'long' ? 'sell' : 'buy';
  const bound = read && closeSlippageBps !== null ? slippageLimit(side, read.value, String(closeSlippageBps), tick) : null;
  return bound ?? closeWorstPrice(position, tick, closeSlippageBps);
}

/**
 * A close's worst price: the owner's close tolerance from the mark, against the position, on the venue's price rule
 * rounded toward the mark (a long's sell up, a short's buy down; `venueBound`). Blank sends the mark itself, which
 * svc-trade refuses by name (`trade.close_slippage_unset`) before anything is signed.
 */
export function closeWorstPrice(position: VenuePosition, tick: string, closeSlippageBps: number | null): string {
  const mark = parseAmount(position.markPrice);
  const bps = BigInt(closeSlippageBps ?? 0);
  const raw = position.side === 'long' ? (mark * (10_000n - bps)) / 10_000n : (mark * (10_000n + bps)) / 10_000n;
  return venueBound(position.side === 'long' ? 'sell' : 'buy', { moved: formatAmount(raw), reference: formatAmount(mark), tick });
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
  const s = spotVenueCopy.useCopy().t;
  const [tab, setTab] = useState<'positions' | 'orders' | 'history' | 'funding' | 'calculator'>('positions');
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const tags = useMemo(() => heldTags(owner), [owner]);
  const open = account.openOrders.data?.value ?? [];
  const tagOf = (clientOrderId: string) => open.find((o) => o.venueClientOrderId === clientOrderId)?.label ?? tags.get(clientOrderId);
  const [cancelResult, setCancelResult] = useState<ActionResult | null>(null);
  // J-derivatives-04 #3, #4: a resting order changed (amended in place, or a reviewed cancel-and-replace) and orders
  // cancelled by id, by contract and by label, singly and in one signed batch.
  const [editing, setEditing] = useState<VenueOrder | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const positions = account.positions.data;
  return (
    <section className="lt-panel" data-testid="venue-blotter">
      <Segmented
        options={[
          { value: 'positions', label: t('Positions') },
          { value: 'orders', label: t('Orders') },
          { value: 'history', label: t('History') },
          { value: 'funding', label: t('Funding') },
          { value: 'calculator', label: t('Calculator') },
        ]}
        value={tab}
        onChange={(x) => setTab(x as typeof tab)}
        label={t('Positions')}
      />
      {tab === 'funding' ? <VenueFunding market={market} owner={owner} venueName={status.venue.displayName} test={status.test} /> : null}
      {tab === 'calculator' ? (
        <VenueCalculator
          key={market.symbol}
          market={market}
          venueName={status.venue.displayName}
          builderFeeBps={status.builder?.feeBps ?? null}
          test={status.test}
        />
      ) : null}
      {tab === 'positions' ? (
        <PositionsTable
          positions={positions}
          market={market}
          owner={owner}
          run={run}
          test={status.test}
          venueName={status.venue.displayName}
          ordersPerAction={status.ordersPerAction ?? 1}
          closeSlippageBps={status.closeSlippageBps ?? null}
          onDone={account.reload}
        />
      ) : tab === 'orders' ? (
        <>
          <OrdersTable
            orders={account.openOrders.data}
            test={status.test}
            cancelled={[]}
            tagOf={tagOf}
            onEdit={setEditing}
            select={{
              selected,
              header: s('Select'),
              label: (id) => s('Select order', { id }),
              onToggle: (id) =>
                setSelected((now) => {
                  const next = new Set(now);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                }),
            }}
            onCancel={(o) => {
              const id = o.venueClientOrderId;
              if (!id) return;
              const key = keysHeld.get(id);
              const done = (r: ActionResult) => (setCancelResult(r), account.reload());
              if (key) void run({ kind: 'cancel_order', symbol: o.symbol, clientOrderKey: key }).then(done);
              // An order this page didn't place (a replacement, or one placed elsewhere) is cancelled by its venue id,
              // under one key per order, so a second press is the same cancel.
              else if ((status.cancelsPerAction ?? 0) >= 1)
                void run(
                  { kind: 'cancel_orders', orders: [{ symbol: o.symbol, venueClientOrderId: id }] },
                  { actionKey: keys.cancelBatch(owner, `one-${id.slice(2)}`) },
                ).then(done);
            }}
          />
          <OutcomeLine result={cancelResult} owner={owner} />
          <VenueDeadMan status={status} owner={owner} run={run} />
          <VenueCancelMany
            orders={open}
            market={market}
            markets={[market]}
            status={status}
            owner={owner}
            run={run}
            spotOnly={false}
            labelOf={tagOf}
            selected={open.filter((o) => o.venueClientOrderId && selected.has(o.venueClientOrderId))}
            onDone={() => {
              setSelected(new Set());
              account.reload();
            }}
          />
          {editing ? (
            <VenueEditOrder
              key={editing.venueClientOrderId ?? ''}
              order={editing}
              market={editing.symbol === market.symbol ? market : null}
              status={status}
              owner={owner}
              run={run}
              onDone={account.reload}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </>
      ) : tab === 'funding' || tab === 'calculator' ? null : (
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
  venueName,
  ordersPerAction,
  closeSlippageBps,
  onDone,
}: {
  positions: AsOf<VenuePosition[]> | null;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  test: boolean;
  venueName: string;
  /** The most orders the venue takes in one signed action (status `ordersPerAction`). */
  ordersPerAction: number;
  /** The owner's close tolerance (status `closeSlippageBps`): null is blank, and svc-trade refuses every close. */
  closeSlippageBps: number | null;
  onDone: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const p = venueProtectCopy.useCopy().t;
  const rows = positions?.value ?? [];
  // The open dialog, with the position as it was when it was opened: it stays open when the position closes.
  const [open, setOpen] = useState<{ kind: 'protect' | 'reverse'; position: VenuePosition } | null>(null);
  const liveOf = (symbol: string) => rows.find((r) => r.symbol === symbol && parseAmount(r.size) > 0n) ?? null;
  const dialogMarket = open && open.position.symbol === market.symbol ? market : null;
  return (
    <div data-testid="venue-positions">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="lt-quiet">{t('No positions')}</p>
      ) : (
        <div className="lt-table-scroll" tabIndex={0} role="region" aria-label={t('Positions')}>
          <table className="lt-table lt-table-dense">
            <thead>
              <tr>
                <th scope="col">{v('Market')}</th>
                <th scope="col">{v('Side')}</th>
                <th scope="col">{t('Size', { asset: market.baseAsset })}</th>
                <th scope="col">{t('Entry')}</th>
                <th scope="col">{t('Mark')}</th>
                <th scope="col">{t('Unrealised')}</th>
                <th scope="col">{t('Margin')}</th>
                <th scope="col">{t('Leverage')}</th>
                <th scope="col">{t('Liquidation price')}</th>
                <th scope="col">{''}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol} data-symbol={row.symbol}>
                  <td>{row.symbol}</td>
                  <td>{word(v, 'side', row.side)}</td>
                  <td className="lt-num" data-cell="size">
                    {row.size}
                  </td>
                  <td className="lt-num" data-cell="entry">
                    {row.entryPrice}
                  </td>
                  <td className="lt-num" data-cell="mark">
                    {row.markPrice}
                  </td>
                  <td className="lt-num" data-cell="unrealised">
                    {row.unrealisedPnl}
                  </td>
                  <td className="lt-num" data-cell="margin">
                    {row.margin}
                  </td>
                  <td className="lt-num" data-cell="leverage">
                    {`${leverageTimes(row.leverageBps)}x ${t(`mode_${row.marginMode}`)}`}
                  </td>
                  <td className="lt-num" data-cell="liquidation">
                    <Known value={row.liquidationPrice} render={(x) => x} />
                  </td>
                  <td>
                    <CloseControl
                      position={row}
                      market={market}
                      owner={owner}
                      run={run}
                      closeSlippageBps={closeSlippageBps}
                      onDone={onDone}
                    />
                    {row.symbol === market.symbol ? (
                      <>
                        <Button tone="secondary" onClick={() => setOpen({ kind: 'protect', position: row })}>
                          {p('Protect button', { symbol: row.symbol })}
                        </Button>{' '}
                        <Button tone="secondary" onClick={() => setOpen({ kind: 'reverse', position: row })}>
                          {p('Reverse button', { symbol: row.symbol })}
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AsOfLine asOf={positions?.asOf ?? null} />
      {open && dialogMarket && open.kind === 'protect' ? (
        <ProtectDialog
          market={dialogMarket}
          position={liveOf(open.position.symbol)}
          side={open.position.side}
          owner={owner}
          venueName={venueName}
          run={run}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open && dialogMarket && open.kind === 'reverse' ? (
        <ReverseDialog
          snapshot={open.position}
          live={liveOf(open.position.symbol)}
          market={dialogMarket}
          owner={owner}
          run={run}
          together={ordersPerAction >= 2}
          worstPrice={(position) => closeWorstPrice(position, dialogMarket.tickSize, closeSlippageBps)}
          onDone={onDone}
          onClose={() => setOpen(null)}
        />
      ) : null}
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
  closeSlippageBps,
  onDone,
}: {
  position: VenuePosition;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  closeSlippageBps: number | null;
  onDone: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const [percent, setPercent] = useState('40');
  const [result, setResult] = useState<{ amount: string; result: ActionResult } | null>(null);
  // The worst price is read once per close id, so a double press sends the same close at the same price.
  const draft = useRef<{ percent: string; size: string; id: string; price: Promise<string> } | null>(null);
  // The client id of a not-definite close the venue's own record has since settled.
  const [settledId, setSettledId] = useState<string | null>(null);
  const read = result?.result.kind === 'unknown' ? result.result : null;
  const unknown = read && read.clientOrderId !== settledId ? read : null;

  async function close() {
    if (unknown) return;
    const p = Number(percent);
    if (!Number.isInteger(p) || p < 1 || p > 100) return;
    // One close id per (percent, size) until a definite answer: a second press is the same close.
    const type = market.orderTypes.includes('market') ? 'market' : 'limit';
    if (!draft.current || draft.current.percent !== percent || draft.current.size !== position.size)
      draft.current = {
        percent,
        size: position.size,
        id: draftId(),
        price:
          type === 'market'
            ? venue.bestPrices(position.symbol).then(
                (best) => closeMarketPrice(position, market.tickSize, best.ok ? best.data : null, closeSlippageBps),
                () => closeMarketPrice(position, market.tickSize, null, closeSlippageBps),
              )
            : Promise.resolve(closeWorstPrice(position, market.tickSize, closeSlippageBps)),
      };
    const { id, price } = draft.current;
    const amount = p === 100 ? position.size : partOf(position.size, p, market.lotSize);
    const answer = await run({
      kind: 'place_order',
      symbol: position.symbol,
      side: position.side === 'long' ? 'sell' : 'buy',
      type,
      amount,
      price: await price,
      timeInForce: 'IOC',
      reduceOnly: true,
      clientOrderKey: keys.close(owner, position.symbol, id),
      builderFee: null,
    });
    if (!keepsDraft(answer)) draft.current = null;
    setResult({ amount, result: answer });
    onDone();
  }

  return (
    <div className="lt-stack" data-testid="venue-close">
      <label className="lt-field">
        <span>{t('Close percent', { symbol: position.symbol })}</span>
        <input
          inputMode="numeric"
          aria-label={t('Close percent', { symbol: position.symbol })}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </label>
      <Button tone="secondary" disabled={unknown !== null} onClick={() => void close()}>
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
        <div className="lt-table-scroll" tabIndex={0} role="region" aria-label={t('Closed positions')}>
          <table className="lt-table lt-table-dense">
            <thead>
              <tr>
                <th scope="col">{v('Market')}</th>
                <th scope="col">{v('Realised result')}</th>
                <th scope="col">{v('Venue fee')}</th>
                <th scope="col">{v('Our builder fee')}</th>
              </tr>
            </thead>
            <tbody>
              {[...bySymbol.entries()].map(([symbol, list]) => (
                <tr key={symbol} data-closed={symbol}>
                  <td>{symbol}</td>
                  <td className="lt-num" data-cell="realised">
                    {sumSigned(list.filter((f) => f.realisedPnl !== null).map((f) => f.realisedPnl!))}
                  </td>
                  <td className="lt-num" data-cell="venue-fees">
                    {sumSigned(list.map((f) => f.venueFee))}
                  </td>
                  <td className="lt-num" data-cell="builder-fees">
                    {sumDecimals(list.map((f) => f.builderFee))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <div className="lt-table-scroll" tabIndex={0} role="region" aria-label={t('Settlements')}>
        <table className="lt-table lt-table-dense">
          <thead>
            <tr>
              <th scope="col">{t('Settlement market')}</th>
              <th scope="col">{t('Settlement why')}</th>
              <th scope="col">{t('Settlement position')}</th>
              <th scope="col">{t('Settlement price')}</th>
              <th scope="col">{t('Settlement result')}</th>
              <th scope="col">{t('Settlement cancelled')}</th>
              <th scope="col">{t('Settlement time')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={`${s.symbol}:${s.settledAt}`} data-settled={s.symbol} data-kind={s.kind} data-at={s.settledAt}>
                <td>
                  {s.symbol} <TestMark test={test} />
                </td>
                <td data-cell="why">{t(`settlement_${s.kind}`)}</td>
                <td className="lt-num" data-cell="position">
                  {s.side === null
                    ? t('Settlement no position')
                    : t('Settlement position value', { side: t(`side_${s.side}`), size: s.size })}
                </td>
                <td className="lt-num" data-cell="price">
                  {s.price}
                </td>
                <td className="lt-num" data-cell="realised">
                  {s.realisedPnl}
                </td>
                <td className="lt-num" data-cell="cancelled">
                  {String(s.cancelledOrders.length)}
                </td>
                <td data-cell="time">
                  <time dateTime={s.settledAt}>{s.settledAt}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const sumSigned = (values: string[]) => formatAmount(values.reduce((total, x) => total + parseAmount(x), 0n));

/** How long Flatten is held before it sends: desk A's hold, long enough that a stray click never closes anything. */
const FLATTEN_HOLD_MS = 650;

/**
 * Flatten (desk A): hold the button 0.65 s and every open position on this venue closes whole, each by one reduce-only
 * IOC order at the market bounded by the owner's slippage cap, exactly as Close at 100% sends it. Letting go earlier
 * sends nothing. One close id per position per flatten, held until the venue answers definitely, so a second hold after
 * a lost answer re-sends the same closes, never new ones. The person's wallet still signs each close.
 */
export function FlattenHold({
  positions,
  markets,
  owner,
  run,
  closeSlippageBps,
}: {
  positions: readonly VenuePosition[];
  markets: readonly VenueMarket[];
  owner: string;
  run: RunAction;
  /** The owner's close tolerance (status `closeSlippageBps`): null is blank, and svc-trade refuses every close. */
  closeSlippageBps: number | null;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ids = useRef(new Map<string, string>());
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<{ symbol: string; text: string }[]>([]);
  const open = positions.filter((p) => markets.some((m) => m.symbol === p.symbol));
  if (open.length === 0 && outcomes.length === 0) return null;

  async function flatten() {
    setBusy(true);
    const done: { symbol: string; text: string }[] = [];
    for (const position of open) {
      const market = markets.find((m) => m.symbol === position.symbol)!;
      const type = market.orderTypes.includes('market') ? 'market' : 'limit';
      const key = `${position.symbol}:${position.size}`;
      const id = ids.current.get(key) ?? draftId();
      ids.current.set(key, id);
      const price =
        type === 'market'
          ? await venue.bestPrices(position.symbol).then(
              (best) => closeMarketPrice(position, market.tickSize, best.ok ? best.data : null, closeSlippageBps),
              () => closeMarketPrice(position, market.tickSize, null, closeSlippageBps),
            )
          : closeWorstPrice(position, market.tickSize, closeSlippageBps);
      const answer = await run({
        kind: 'place_order',
        symbol: position.symbol,
        side: position.side === 'long' ? 'sell' : 'buy',
        type,
        amount: position.size,
        price,
        timeInForce: 'IOC',
        reduceOnly: true,
        clientOrderKey: keys.close(owner, position.symbol, id),
        builderFee: null,
      });
      if (!keepsDraft(answer)) ids.current.delete(key);
      done.push({ symbol: position.symbol, text: outcomeText(v, answer) });
    }
    setOutcomes(done);
    setBusy(false);
  }
  const start = () => {
    if (busy || open.length === 0 || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      void flatten();
    }, FLATTEN_HOLD_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return (
    <div className="xd-flatten" data-testid="venue-flatten">
      <Button
        tone="secondary"
        className="xd-hold"
        data-holding={holding || undefined}
        disabled={busy || open.length === 0}
        aria-describedby="venue-flatten-how"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={stop}
      >
        {busy ? t('Flattening') : t('Flatten', { count: String(open.length) })}
      </Button>
      <span id="venue-flatten-how" className="xd-risk-note">
        {t('Flatten how')}
      </span>
      {outcomes.length > 0 ? (
        <ul role="status" className="xd-risk-note" data-testid="venue-flatten-outcome">
          {outcomes.map((o) => (
            <li key={o.symbol}>{t('Flatten outcome', { symbol: o.symbol, outcome: o.text })}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A position line in the chart's words: "Long 0.25 · +285.00", "Stop −260.00", "Target +890.00", "Liquidation, est.". */
function chartLineOf(
  line: PositionLine,
  t: ReturnType<typeof futuresVenueCopy.useCopy>['t'],
  position: VenuePosition | undefined,
): ChartOrderLine {
  const signed = (v: string | null) => (v === null ? '' : `${v.startsWith('-') ? '' : '+'}${displayAmount(v, 2)}`);
  const side = position?.side === 'short' ? 'sell' : 'buy';
  if (line.kind === 'entry')
    return {
      price: line.price,
      side,
      tone: 'neutral',
      dashed: false,
      title: t('Line entry', {
        side: t(position?.side === 'short' ? 'side_short' : 'side_long'),
        size: position?.size ?? '',
        result: signed(line.result),
      }),
    };
  if (line.kind === 'liquidation') return { price: line.price, side, tone: 'neutral', title: t('Line liquidation') };
  return {
    price: line.price,
    side,
    tone: line.kind === 'stop' ? 'down' : 'up',
    dashed: false,
    title: t(line.kind === 'stop' ? 'Line stop' : 'Line target', { result: signed(line.result) }),
  };
}
