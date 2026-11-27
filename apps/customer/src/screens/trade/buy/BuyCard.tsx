import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, ArrowDownUp } from 'lucide-react';
import { AssetIcon, Button, HIDDEN_MASK, Segmented, Select } from '@intafaced/ui/lit';
import { Skeleton, StatusChip, TextField } from '@intafaced/ui/lit/templates';
import { AssetPicker, type PickerItem } from './AssetPicker';
import { BuyReview, type ReviewState } from './BuyReview';
import { recheckCancel } from './cancel-recheck';
import { CostBlock } from './CostBlock';
import { costRows } from './cost';
import { buyCopy, coinName } from './copy';
import {
  classifyRefusal,
  defaultPoller,
  fmtAmount,
  fmtPrice,
  fmtUsd,
  refusalCopy,
  useMarketCatalogue,
  useMarkets,
  usePortfolio,
  useTicker,
  useTickers,
  venueSpotMarkets,
  type MarketRow,
} from '../../../data';
import { isHiddenPath } from '../../../app/feature-registry';
import { normalizePair } from '../../../app/navigation';
import { createTradeApi, type TradeApi } from '../../../features/trade/trade-api';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useRefreshPrivate } from '../desk/data';
import { KitState, LinkButton, typedDecimal } from '../kit-parts';
import {
  buildDraft,
  checkOrder,
  computeMax,
  fetchFills,
  newClientOrderId,
  placeOrder,
  previewOrder,
  useEstimate,
  usePendingNote,
  type OrderRequest,
} from './order-flow';
import {
  coinOptions,
  dollarsForBase,
  isPayAsset,
  marketFor,
  payOptions,
  planOrder,
  smallestOrder,
  type CoinOption,
  type PlanProblem,
  type Unit,
} from './order-plan';
import { useAvailable, useMarketLimits } from './quote-flow';
import { TradingHoldReason } from '../../../features/account/TradingHoldReason';
import { receiptFrom, type Receipt } from './receipt';
import { dec, fractionDigits } from './trade-math';

export interface BuyCardProps {
  /** The coin to start on ("BTC"), usually from `?asset=`. Falls back to the first coin that can be bought. */
  initialAsset?: string | null;
  /** Start on Sell. */
  initialSide?: 'buy' | 'sell';
  /** 288 px wide, no heading space, 48 px button: the coin page uses this. */
  compact?: boolean;
  /** Fixed coin (the coin page): the coin row is not a picker. */
  lockAsset?: boolean;
  /** Called when the customer picks another coin. */
  onAssetChange?: (base: string) => void;
  /** Called when the customer flips between Buy and Sell, so the page's headline can follow. */
  onSideChange?: (side: 'buy' | 'sell') => void;
}

/** A price older than this reads Stale (spec section 1). */
const PRICE_STALE_AFTER_MS = 30_000;

/** Where a finished order is listed. */
export const ACTIVITY_HREF = '/money/activity?tab=trades';
/** "Order history" opens the Orders tab; the receipt's "View in Activity" opens Trades. */
export const ORDERS_HREF = '/money/activity?tab=orders';

/**
 * Simple Buy and Sell card (UI-SPEC 5.9). Reusable: the page `/trade/buy` and the coin page both render it.
 * It needs the app's session and data providers, nothing else.
 */
export function BuyCard({
  initialAsset,
  initialSide = 'buy',
  compact = false,
  lockAsset = false,
  onAssetChange,
  onSideChange,
}: BuyCardProps) {
  const { t } = buyCopy.useCopy();
  const markets = useMarkets();
  // With the venue door on, the venue's spot markets are traded on the spot desk, never through our own book.
  const venueSpot = venueSpotMarkets(useMarketCatalogue());
  // Keeps the balance subscribed while the success card replaces the form, so "refresh the balance now" has someone listening.
  usePortfolio();
  const [base, setBase] = useState<string | null>(initialAsset ?? null);
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const coins = useMemo(() => (markets.status === 'ready' ? coinOptions(markets.data) : []), [markets]);
  const coin = coins.find((option) => option.base === base) ?? coins[0] ?? null;

  const frame = (children: React.ReactNode) => (
    <section data-testid="buy-card" className="lt-region lt-stack" data-compact={compact || undefined} aria-label={t('Buy or sell')}>
      {children}
    </section>
  );

  if (markets.status === 'loading')
    return frame(
      <div data-testid="buy-card__skeleton" aria-busy="true">
        <Skeleton shape="form" count={4} />
      </div>,
    );
  if (markets.status === 'error')
    return frame(<KitState kind="error" title={t('Couldn’t load coins')} onRetry={markets.retry} retryLabel={t('Retry')} />);
  if (markets.status === 'refused') {
    const copy = refusalCopy(markets.code);
    return frame(<KitState kind="refused" title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />);
  }
  if (!coin && venueSpot.length > 0) return frame(<VenueSpotDesks markets={venueSpot} />);
  if (!coin)
    return frame(
      <KitState
        kind="empty"
        title={t('No coins title')}
        body={t('No coins body')}
        action={{ label: t('Go to Markets'), href: '/trade' }}
      />,
    );

  if (receipt) return frame(<ReceiptView receipt={receipt} coin={coin} onDone={() => setReceipt(null)} />);

  return frame(
    <BuyForm
      key={`${coin.base}:${side}`}
      coin={coin}
      coins={coins}
      side={side}
      onSide={(next) => {
        setSide(next);
        onSideChange?.(next);
      }}
      lockAsset={lockAsset}
      onPickCoin={(next) => {
        setBase(next);
        onAssetChange?.(next);
      }}
      onReceipt={setReceipt}
    />,
  );
}

/**
 * Where our own book lists no coin and the venue door is on: each of the venue's open spot markets, linked to its spot
 * desk, so Buy and sell offers what Markets offers. A desk the build hides is named with no link.
 */
function VenueSpotDesks({ markets }: { markets: MarketRow[] }) {
  const { t } = buyCopy.useCopy();
  return (
    <div className="lt-stack" data-testid="buy-venue-desks">
      <KitState kind="empty" title={t('Venue spot title')} body={t('Venue spot body')} />
      <ul className="lt-row">
        {markets.map((market) => {
          const desk = `/trade/spot/${normalizePair(market.symbol)}`;
          const words = t('Buy {coin} on the spot desk', { coin: market.base });
          return (
            <li key={market.symbol} data-testid="buy-venue-desk" data-symbol={market.symbol}>
              {isHiddenPath(desk) ? words : <LinkButton href={desk}>{words}</LinkButton>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ReceiptView({ receipt, coin, onDone }: { receipt: Receipt; coin: CoinOption; onDone: () => void }) {
  const { t } = buyCopy.useCopy();
  const selling = receipt.side === 'sell';
  const paid = receipt.cost === null ? '—' : fmtUsd(receipt.cost);
  const filled = fmtAmount(receipt.filled, { places: 8 });
  const partial = receipt.status === 'partial';
  const none = receipt.status === 'none';
  const open = receipt.status === 'open';
  return (
    <div className="lt-receipt" role="status" data-testid="receipt" data-status={receipt.status}>
      <p className="lt-receipt-status" aria-hidden="true" data-tone={none || open ? 'neutral' : 'ok'}>
        {none || open ? '·' : '✓'}
      </p>
      {none ? (
        <>
          <h2 data-testid="buy-receipt__title" className="lt-title">
            {t('Not filled title')}
          </h2>
          <p className="lt-receipt-where">{t('Not filled body')}</p>
        </>
      ) : open ? (
        <>
          <h2 data-testid="buy-receipt__title" className="lt-title">
            {t('Still working title')}
          </h2>
          <p className="lt-receipt-where">{t('Still working body')}</p>
        </>
      ) : (
        <>
          <h2 data-testid="buy-receipt__title" className="lt-title">
            {selling
              ? t('You sold {amount} {coin}', { amount: filled, coin: coin.base })
              : t('You bought {amount} {coin}', { amount: filled, coin: coin.base })}
          </h2>
          {partial ? (
            <p className="lt-receipt-where">
              {t('Partly filled', { done: filled, total: fmtAmount(receipt.amount, { places: 8 }), coin: coin.base })}
            </p>
          ) : null}
          <dl className="lt-kv">
            <div>
              <dt>{selling ? t('Received') : t('Paid')}</dt>
              <dd data-testid="receipt-cost">{paid}</dd>
            </div>
            {receipt.average !== null ? (
              <div>
                <dt>{t('Average price')}</dt>
                <dd>${fmtPrice(receipt.average, null)}</dd>
              </div>
            ) : null}
            {receipt.fee ? (
              <div>
                <dt>{t('Fee')}</dt>
                <dd data-testid="receipt-fee">
                  {fmtAmount(receipt.fee.cost, { places: 8 })} {receipt.fee.currency}
                  {receipt.fee.usd !== null ? ` ${t('Fee in dollars', { value: fmtUsd(receipt.fee.usd) })}` : null}
                </dd>
              </div>
            ) : null}
          </dl>
        </>
      )}
      <div className="lt-actions">
        <LinkButton tone="primary" href={ACTIVITY_HREF}>
          {t('View in Activity')}
        </LinkButton>
        <Button tone="secondary" onClick={onDone}>
          {none ? t('Try again') : t('Done')}
        </Button>
      </div>
    </div>
  );
}

function BuyForm({
  coin,
  coins,
  side,
  onSide,
  lockAsset,
  onPickCoin,
  onReceipt,
}: {
  coin: CoinOption;
  coins: CoinOption[];
  side: 'buy' | 'sell';
  onSide: (side: 'buy' | 'sell') => void;
  lockAsset: boolean;
  onPickCoin: (base: string) => void;
  onReceipt: (receipt: Receipt) => void;
}) {
  const copy = buyCopy.useCopy();
  const { t } = copy;
  const { session, api, userId } = useSession();
  const tradeApi: TradeApi = useMemo(() => createTradeApi(api), [api]);
  const [payer, setPayer] = useState<string | null>(null);
  const market = marketFor(coin, payer) as MarketRow;
  const payChoices = payOptions(coin);
  const quote = market.quote;
  const buying = side === 'buy';

  const [unit, setUnit] = useState<Unit>('quote');
  const [amount, setAmount] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'review' | 'place' | 'max' | 'check' | null>(null);
  const [problem, setProblem] = useState<{
    title: string;
    body?: string;
    action?: { label: string; href: string };
    code?: string | null;
  } | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ticker = useTicker(market.symbol);
  const limits = useMarketLimits();
  const spendAsset = buying ? quote : market.base;
  const available = useAvailable(spendAsset);
  const { hideBalances } = usePreferences();
  const amountId = useId();
  const note = usePendingNote(userId);
  const refreshPrivate = useRefreshPrivate();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const price = useMemo(() => {
    if (ticker.status !== 'ready') return null;
    return (buying ? ticker.data.ask : ticker.data.bid) ?? ticker.data.last;
  }, [ticker, buying]);
  const lastPrice = ticker.status === 'ready' ? ticker.data.last : null;
  const bid = ticker.status === 'ready' ? ticker.data.bid : null;
  const ask = ticker.status === 'ready' ? ticker.data.ask : null;
  const limitRow = limits.status === 'ready' ? limits.data[market.symbol] : undefined;
  const lotPlaces = fractionDigits(market.lotSize) ?? 8;
  const precision = unit === 'quote' ? 2 : lotPlaces;

  const plan = useMemo(
    () =>
      planOrder({
        unit,
        amount,
        price,
        lot: market.lotSize,
        minAmount: limitRow?.minAmount ?? market.minAmount,
        minCost: limitRow?.minCost ?? null,
        baseAsset: market.base,
        quoteAsset: quote,
      }),
    [unit, amount, price, market, limitRow, quote],
  );

  // The one cheap check before asking the service: more than the whole balance can never work.
  const insufficient = useMemo(() => {
    if (available.state !== 'ready' || !plan.ok) return false;
    const have = dec(available.value);
    if (have === null) return false;
    const needs = buying ? dec(plan.notional) : plan.baseScaled;
    return needs !== null && needs > have;
  }, [available, plan, buying]);
  const insufficientText = useMemo(() => {
    if (!insufficient) return null;
    const words = refusalCopy('ledger.insufficient_funds', {
      asset: spendAsset,
      available: fmtAmount(available.value, { places: 8, round: 'down' }),
    });
    return `${words.title}. ${words.body}`;
  }, [insufficient, spendAsset, available.value]);

  const request: OrderRequest | null =
    plan.ok && !insufficient && session && note.state === 'none' ? { symbol: market.symbol, side, base: plan.base } : null;
  const estimate = useEstimate(tradeApi, request, {
    asset: spendAsset,
    available: available.value === null ? undefined : fmtAmount(available.value, { places: 8, round: 'down' }),
  });

  const reset = () => {
    setProblem(null);
    setChecked(null);
  };

  const planText = (issue: PlanProblem): string | null => {
    switch (issue.kind) {
      case 'tooSmall':
        // Dollars are rounded up to a whole lot of the coin, so the real minimum is a little above the published one.
        return isPayAsset(issue.asset)
          ? t('Minimum is about {min}.', { min: fmtUsd(issue.min) })
          : t('Minimum is {min} {asset}.', { min: issue.min, asset: issue.asset });
      case 'notOnLot':
        return t('Use steps of {step} {asset}.', { step: issue.step, asset: market.base });
      default:
        return null;
    }
  };
  const planError = !plan.ok ? planText(plan.problem) : null;
  const inlineError = insufficientText ?? planError;

  async function onMax() {
    if (busy) return;
    reset();
    setBusy('max');
    const result = await computeMax(tradeApi, {
      symbol: market.symbol,
      side,
      available: available.value,
      price,
      lot: market.lotSize,
      spendAsset,
      smallest: smallestOrder({
        lot: market.lotSize,
        minAmount: limitRow?.minAmount ?? market.minAmount,
        minCost: limitRow?.minCost ?? null,
        price,
      }),
    });
    if (!mounted.current) return;
    setBusy(null);
    if (result.kind === 'ok') {
      if (unit === 'base') setAmount(result.base);
      else {
        // In dollars: the cents that plan back to exactly that many coins at the price it was sized from.
        setAmount(dollarsForBase(result.base, price, market.lotSize) ?? '');
      }
    } else if (result.kind === 'refused') setProblem({ title: result.copy.title, body: result.copy.body, action: result.copy.action });
    else setProblem({ title: t('Couldn’t work out Max') });
  }

  async function onReview() {
    if (!plan.ok || busy || !session) return;
    reset();
    setBusy('review');
    const draft = buildDraft({ symbol: market.symbol, side, base: plan.base }, newClientOrderId());
    const outcome = await previewOrder(tradeApi, draft, {
      asset: spendAsset,
      available: available.value === null ? undefined : fmtAmount(available.value, { places: 8, round: 'down' }),
    });
    if (!mounted.current) return;
    setBusy(null);
    if (outcome.kind === 'ok') {
      setReviewMessage(null);
      setReview({ draft, preview: outcome.preview, price, bid, ask, changed: false });
    } else if (outcome.kind === 'refused')
      setProblem({ title: outcome.copy.title, body: outcome.copy.body, action: outcome.copy.action, code: outcome.code });
    else setProblem({ title: t('Couldn’t check this order') });
  }

  async function onConfirm() {
    // A second click before the screen has redrawn must not start a second order: the ref answers at once, state does not.
    if (!review || busy === 'place' || sending.current) return;
    sending.current = true;
    try {
      await confirmReviewed(review);
    } finally {
      sending.current = false;
    }
  }

  async function confirmReviewed(review: ReviewState) {
    setBusy('place');
    setReviewMessage(null);
    const outcome = await placeOrder(tradeApi, userId, review.draft, review.preview, { asset: spendAsset }, () => mounted.current);
    if (!mounted.current && outcome.kind !== 'placed') return;
    if (outcome.kind !== 'placed') setBusy(null);
    switch (outcome.kind) {
      case 'placed': {
        // What was really paid is in the fills, read before the receipt shows; the dialog stays up until then.
        const fills = await fetchFills(tradeApi, outcome.order);
        setBusy(null);
        setReview(null);
        // Balances are read again now, not in half a minute, so the new balance is what the customer sees next.
        if (userId) defaultPoller().refresh(`balance:${userId}`);
        refreshPrivate();
        onReceipt(receiptFrom(outcome.order, fills));
        return;
      }
      case 'changed':
        setReview({ ...review, preview: outcome.preview, price, bid, ask, changed: true });
        return;
      case 'refused':
        setReview(null);
        setProblem({ title: outcome.copy.title, body: outcome.copy.body, action: outcome.copy.action, code: outcome.code });
        return;
      case 'uncertain':
        setReview(null);
        setUncertainId(outcome.clientOrderId);
        return;
      case 'blocked':
        setReviewMessage(blockedText(outcome.reason));
        return;
    }
  }

  const blockedText = (reason: string) =>
    reason === 'otherTab'
      ? t('Other tab')
      : reason === 'signedOut'
        ? t('Sign in again')
        : reason === 'pending'
          ? t('Earlier order body')
          : t('No safe storage');

  async function onCheckCancel() {
    if (note.state !== 'pending' || busy) return;
    setBusy('check');
    setChecked(null);
    // A read of the order, never a second cancel.
    const outcome = await recheckCancel(tradeApi, userId, note.pending);
    if (!mounted.current) return;
    setBusy(null);
    if (outcome.kind === 'unknown') setChecked(t('Cancel not confirmed'));
    else if (outcome.kind === 'checking') setChecked(t('Still being checked'));
    else {
      refreshPrivate();
      setChecked(outcome.kind === 'open' ? t('Still open') : t('Order cancelled'));
    }
  }

  async function onCheck() {
    if (note.state !== 'pending' || busy) return;
    setBusy('check');
    setChecked(null);
    const outcome = await checkOrder(tradeApi, userId, note.pending);
    if (!mounted.current) return;
    setBusy(null);
    if (outcome.kind === 'found') {
      if (outcome.order.recoveryRequired) setChecked(t('Order found', { status: outcome.order.status }));
      else {
        const fills = await fetchFills(tradeApi, outcome.order);
        if (userId) defaultPoller().refresh(`balance:${userId}`);
        onReceipt(receiptFrom(outcome.order, fills));
      }
    } else setChecked(outcome.kind === 'notFound' ? t('Order not found') : t('Couldn’t check the order'));
  }

  const coinLabel = coinName(coin.base, copy);
  const pickerItems: PickerItem[] = coins.map((option) => {
    const optionMarket = marketFor(option);
    return {
      asset: option.base,
      name: coinName(option.base, copy),
      detail: optionMarket ? <PickerPrice symbol={optionMarket.symbol} tick={optionMarket.tickSize} /> : null,
    };
  });

  const signedOut = !session;
  const waitingForPrice = plan.ok === false && plan.problem.kind === 'noPrice';
  const priceStale = ticker.status === 'ready' && clock - ticker.asOf > PRICE_STALE_AFTER_MS;
  const ready =
    plan.ok &&
    !priceStale &&
    !insufficient &&
    !signedOut &&
    note.state === 'none' &&
    available.state === 'ready' &&
    limits.status !== 'loading' &&
    estimate.state !== 'refused' &&
    busy === null;
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  // Nothing typed (or not a valid size) is "—", never a made-up zero (spec 1.1-4).
  const approx = !plan.ok
    ? '—'
    : unit === 'quote'
      ? t('About {value}', { value: `${fmtAmount(plan.base, { places: lotPlaces })} ${market.base}` })
      : plan.notional !== null
        ? t('About {value}', { value: fmtUsd(plan.notional) })
        : '—';
  const priceLine = price === null ? '—' : `$${fmtPrice(price, market.tickSize)}`;

  const freshness = ticker.status === 'refused' ? 'refused' : ticker.status !== 'ready' ? 'unknown' : priceStale ? 'stale' : 'live';
  const freshnessReason =
    ticker.status === 'refused' ? t('Price refused') : ticker.status === 'ready' ? undefined : t('Price not available');

  return (
    <div className="lt-stack">
      <div data-testid="buy-form__top">
        <Segmented
          label={t('Buy or sell')}
          value={side}
          onChange={(next) => {
            if (next === 'buy' || next === 'sell') onSide(next);
          }}
          options={[
            { value: 'buy', label: t('Buy') },
            { value: 'sell', label: t('Sell') },
          ]}
        />
      </div>

      <div className="lt-stack">
        <TextField
          id={amountId}
          label={t('Amount in {unit}', { unit: unit === 'quote' ? 'USD' : market.base })}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder="0"
          value={amount}
          onChange={(raw) => {
            const next = typedDecimal(raw, precision);
            if (next === null || next === amount) return;
            reset();
            setAmount(next);
          }}
          onBlur={() => {
            if (amount.endsWith('.')) setAmount(amount.slice(0, -1));
          }}
          aria-invalid={inlineError ? true : undefined}
          hint={inlineError ?? undefined}
          disabled={busy === 'max'}
        />
        <div className="lt-actions">
          {available.state === 'ready' && !signedOut ? (
            <Button tone="quiet" onClick={() => void onMax()} disabled={busy === 'max'}>
              {t('Max')}
            </Button>
          ) : null}
          <Button
            tone="quiet"
            onClick={() => {
              setAmount('');
              setUnit(unit === 'quote' ? 'base' : 'quote');
              reset();
            }}
          >
            <ArrowDownUp size={14} aria-hidden="true" />
            {t('Enter in {unit}', { unit: unit === 'quote' ? market.base : 'USD' })}
          </Button>
        </div>
        <p className="lt-hint">
          <span data-testid="approx" data-tone={plan.ok && buying ? 'up' : undefined}>
            {approx}
          </span>
        </p>
      </div>

      <div className="lt-stack">
        {lockAsset ? (
          <div data-testid="buy-row" className="lt-actions" data-static="true">
            <AssetIcon asset={coin.base} size="md" />
            <span data-testid="buy-row__text" className="lt-stack">
              <span className="lt-hint">{buying ? t('Coin row buy') : t('Coin row sell')}</span>
              <span>{coin.base}</span>
            </span>
          </div>
        ) : (
          <Button data-testid="buy-row" onClick={() => setPickerOpen(true)} aria-label={t('Change coin')}>
            <AssetIcon asset={coin.base} size="md" />
            <span data-testid="buy-row__text" className="lt-stack">
              <span className="lt-hint">{buying ? t('Coin row buy') : t('Coin row sell')}</span>
              <span data-testid="coin-row">
                {coin.base}
                {coinLabel ? <span> · {coinLabel}</span> : null}
              </span>
            </span>
            <ChevronRight size={20} aria-hidden="true" />
          </Button>
        )}
        <div data-testid="buy-row" className="lt-stack" data-static="true">
          <span data-testid="buy-row__text" className="lt-stack">
            {payChoices.length > 1 ? (
              <Select
                label={buying ? t('Pay with') : t('Receive in')}
                value={quote}
                options={payChoices.map((asset) => ({ value: asset, label: t('{asset} balance', { asset }) }))}
                onChange={(next) => {
                  setPayer(next);
                  setAmount('');
                  reset();
                }}
              />
            ) : (
              <>
                <span className="lt-hint">{buying ? t('Pay with') : t('Receive in')}</span>
                <span>{t('{asset} balance', { asset: quote })}</span>
              </>
            )}
          </span>
          <span className="lt-hint" data-testid="available">
            {available.state === 'ready'
              ? t('Available {value}', {
                  value: hideBalances ? HIDDEN_MASK : `${fmtAmount(available.value, { places: 8, round: 'down' })} ${spendAsset}`,
                })
              : t('Available loading')}
          </span>
        </div>
      </div>

      {plan.ok ? (
        <>
          <dl className="lt-kv">
            <div>
              <dt>{t('Estimated price')}</dt>
              <dd data-testid="price">
                <span>{priceLine}</span>{' '}
                <span data-testid="price-freshness" role="status" data-freshness={freshness} title={freshnessReason}>
                  <StatusChip
                    status={
                      freshness === 'live' ? 'done' : freshness === 'stale' ? 'pending' : freshness === 'refused' ? 'failed' : 'unknown'
                    }
                    label={t(
                      freshness === 'live'
                        ? 'Price live'
                        : freshness === 'stale'
                          ? 'Price stale'
                          : freshness === 'refused'
                            ? 'Price refused word'
                            : 'Price unknown',
                    )}
                  />
                  {freshnessReason ? <span className="lt-sr">{freshnessReason}</span> : null}
                </span>
              </dd>
            </div>
          </dl>
          <CostBlock
            rows={costRows({
              side,
              base: plan.base,
              price,
              baseAsset: market.base,
              quoteAsset: quote,
              preview: estimate.state === 'ready' ? estimate.preview : null,
            })}
            side={side}
            baseAsset={market.base}
            places={lotPlaces}
          />
        </>
      ) : null}

      {estimate.state === 'refused' ? (
        <KitState
          kind="refused"
          title={estimate.copy.title}
          body={estimate.copy.body}
          code={estimate.copy.reference}
          action={estimate.copy.action}
        />
      ) : null}
      {estimate.state === 'refused' && classifyRefusal(estimate.code) === 'tradingOnHold' ? <TradingHoldReason /> : null}
      {problem ? <KitState kind="refused" title={problem.title} body={problem.body ?? ''} action={problem.action} /> : null}
      {/* J-identity-14 #2: a trading hold gives the restriction's stored reason here too, in the status page's words. */}
      {problem && classifyRefusal(problem.code) === 'tradingOnHold' ? <TradingHoldReason /> : null}
      {note.state === 'pending' ? (
        <div className="lt-refusal" data-refusal="refused" role="alert" data-testid="pending">
          <p className="lt-refusal-title">{uncertainId === note.pending.id ? t('Not confirmed title') : t('Earlier order title')}</p>
          <p className="lt-refusal-body">
            {uncertainId === note.pending.id
              ? t('Not confirmed body')
              : note.pending.kind === 'convert'
                ? t('Earlier convert body')
                : t('Earlier order body')}
          </p>
          {checked ? <p className="lt-refusal-body">{checked}</p> : null}
          <div className="lt-actions">
            {note.pending.kind === 'cancel' ? (
              <Button tone="secondary" disabled={busy === 'check'} aria-busy={busy === 'check' || undefined} onClick={onCheckCancel}>
                {busy === 'check' ? t('Checking order') : t('Check again')}
              </Button>
            ) : null}
            {note.pending.kind === 'place' ? (
              <Button tone="secondary" disabled={busy === 'check'} aria-busy={busy === 'check' || undefined} onClick={onCheck}>
                {busy === 'check' ? t('Checking order') : t('Check order')}
              </Button>
            ) : null}
            <LinkButton href={ACTIVITY_HREF}>{t('View in Activity')}</LinkButton>
          </div>
        </div>
      ) : null}
      {note.state === 'unreadable' ? (
        <p className="lt-hint" role="alert">
          {t('No safe storage')}
        </p>
      ) : null}

      {signedOut ? (
        <LinkButton tone="primary" href={loginHref}>
          {buying ? t('Log in to buy') : t('Log in to sell')}
        </LinkButton>
      ) : (
        <Button tone="primary" size="lg" block disabled={!ready} aria-busy={busy === 'review' || undefined} onClick={onReview}>
          {busy === 'review'
            ? t('Checking')
            : !plan.ok && plan.problem.kind === 'empty'
              ? t('Enter an amount')
              : waitingForPrice
                ? t('Waiting for a price')
                : buying
                  ? t('Review buy')
                  : t('Review sell')}
        </Button>
      )}
      {priceStale && !signedOut ? (
        <p className="lt-hint" data-testid="stale-hint">
          {t('Price stale hint')}
        </p>
      ) : null}

      {review ? (
        <BuyReview
          review={review}
          market={market}
          busy={busy === 'place'}
          message={reviewMessage}
          onCancel={() => {
            setReview(null);
            setReviewMessage(null);
          }}
          onConfirm={onConfirm}
        />
      ) : null}
      {lockAsset || !pickerOpen ? null : (
        <AssetPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          title={t('Choose a coin')}
          searchLabel={t('Search coins')}
          noMatch={(query) => t('No coin matches', { query })}
          items={pickerItems}
          selected={coin.base}
          onPick={onPickCoin}
        />
      )}
    </div>
  );
}

function PickerPrice({ symbol, tick }: { symbol: string; tick: string }) {
  const tickers = useTickers();
  const last = tickers.status === 'ready' ? tickers.data[symbol]?.last : null;
  return <span>{last ? `$${fmtPrice(last, tick)}` : '—'}</span>;
}
