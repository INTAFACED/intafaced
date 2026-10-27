import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ArrowDownUp } from 'lucide-react';
import './buy.css';
import { AssetPicker, type PickerItem } from './AssetPicker';
import { BuyReview, type ReviewState } from './BuyReview';
import { recheckCancel } from './cancel-recheck';
import { CostBlock } from './CostBlock';
import { costRows } from './cost';
import { buyCopy, coinName } from './copy';
import {
  AmountInput,
  Button,
  CoinIcon,
  createTradeApi,
  defaultPoller,
  fmtAmount,
  fmtPrice,
  fmtUsd,
  refusalCopy,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusChip,
  StateBlock,
  useMarkets,
  usePortfolio,
  useSession,
  useTicker,
  useTickers,
  type MarketRow,
  type TradeApi,
  useHideBalances,
  HIDDEN_MASK,
  useRefreshPrivate,
} from './deps';
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
  // Keeps the balance subscribed while the success card replaces the form, so "refresh the balance now" has someone listening.
  usePortfolio();
  const [base, setBase] = useState<string | null>(initialAsset ?? null);
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const coins = useMemo(() => (markets.status === 'ready' ? coinOptions(markets.data) : []), [markets]);
  const coin = coins.find((option) => option.base === base) ?? coins[0] ?? null;

  const frame = (children: React.ReactNode) => (
    <section data-testid="buy-card" className="buy-card" data-compact={compact || undefined} aria-label={t('Buy or sell')}>
      {children}
    </section>
  );

  if (markets.status === 'loading')
    return frame(
      <div data-testid="buy-card__skeleton" className="buy-card__skeleton" aria-busy="true">
        <Skeleton height={40} width={200} circle />
        <Skeleton height={56} className="buy-card__field" />
        <Skeleton height={112} className="buy-card__field" />
        <Skeleton height={compact ? 48 : 56} circle />
      </div>,
    );
  if (markets.status === 'error')
    return frame(<StateBlock kind="error" title={t('Couldn’t load coins')} onRetry={markets.retry} retryLabel={t('Retry')} />);
  if (markets.status === 'refused') {
    const copy = refusalCopy(markets.code);
    return frame(<StateBlock kind="refused" title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />);
  }
  if (!coin)
    return frame(
      <StateBlock
        kind="empty"
        title={t('No coins title')}
        body={t('No coins body')}
        action={{ label: t('Go to Markets'), href: '/trade' }}
      />,
    );

  if (receipt) return frame(<ReceiptView receipt={receipt} coin={coin} compact={compact} onDone={() => setReceipt(null)} />);

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
      compact={compact}
      onPickCoin={(next) => {
        setBase(next);
        onAssetChange?.(next);
      }}
      onReceipt={setReceipt}
    />,
  );
}

function ReceiptView({ receipt, coin, compact, onDone }: { receipt: Receipt; coin: CoinOption; compact: boolean; onDone: () => void }) {
  const { t } = buyCopy.useCopy();
  const selling = receipt.side === 'sell';
  const paid = receipt.cost === null ? '—' : fmtUsd(receipt.cost);
  const filled = fmtAmount(receipt.filled, { places: 8 });
  const partial = receipt.status === 'partial';
  const none = receipt.status === 'none';
  const open = receipt.status === 'open';
  return (
    <div className="buy-receipt" role="status" data-testid="receipt" data-status={receipt.status}>
      <span className="buy-receipt__badge" aria-hidden="true" data-tone={none || open ? 'neutral' : 'ok'}>
        {none || open ? '·' : '✓'}
      </span>
      {none ? (
        <>
          <h2 data-testid="buy-receipt__title" className="buy-receipt__title">
            {t('Not filled title')}
          </h2>
          <p className="buy-receipt__body">{t('Not filled body')}</p>
        </>
      ) : open ? (
        <>
          <h2 data-testid="buy-receipt__title" className="buy-receipt__title">
            {t('Still working title')}
          </h2>
          <p className="buy-receipt__body">{t('Still working body')}</p>
        </>
      ) : (
        <>
          <h2 data-testid="buy-receipt__title" className="buy-receipt__title">
            {selling
              ? t('You sold {amount} {coin}', { amount: filled, coin: coin.base })
              : t('You bought {amount} {coin}', { amount: filled, coin: coin.base })}
          </h2>
          {partial ? (
            <p className="buy-receipt__body">
              {t('Partly filled', { done: filled, total: fmtAmount(receipt.amount, { places: 8 }), coin: coin.base })}
            </p>
          ) : null}
          <dl className="buy-receipt__rows">
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
                <dd>
                  {fmtAmount(receipt.fee.cost, { places: 8 })} {receipt.fee.currency}
                </dd>
              </div>
            ) : null}
          </dl>
        </>
      )}
      <div className="buy-receipt__actions">
        <Button variant="primary" size={compact ? 48 : 56} fullWidth nativeButton={false} render={<a href={ACTIVITY_HREF} />}>
          {t('View in Activity')}
        </Button>
        <Button variant="secondary" size={compact ? 48 : 56} fullWidth onClick={onDone}>
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
  compact,
  onPickCoin,
  onReceipt,
}: {
  coin: CoinOption;
  coins: CoinOption[];
  side: 'buy' | 'sell';
  onSide: (side: 'buy' | 'sell') => void;
  lockAsset: boolean;
  compact: boolean;
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
  const [problem, setProblem] = useState<{ title: string; body?: string; action?: { label: string; href: string } } | null>(null);
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
  const hideBalances = useHideBalances();
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
      setReview({ draft, preview: outcome.preview, price, changed: false });
    } else if (outcome.kind === 'refused') setProblem({ title: outcome.copy.title, body: outcome.copy.body, action: outcome.copy.action });
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
        setReview({ ...review, preview: outcome.preview, price, changed: true });
        return;
      case 'refused':
        setReview(null);
        setProblem({ title: outcome.copy.title, body: outcome.copy.body, action: outcome.copy.action });
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
  const buttonSize = compact ? 48 : 56;
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

  return (
    <div className="buy-form">
      <div data-testid="buy-form__top" className="buy-form__top">
        <SegmentedControl
          size={40}
          fullWidth={compact}
          className={compact ? undefined : 'w-50'}
          aria-label={t('Buy or sell')}
          value={side}
          onValueChange={(next) => {
            if (next === 'buy' || next === 'sell') onSide(next);
          }}
          items={[
            { value: 'buy', label: t('Buy'), tone: 'up' },
            { value: 'sell', label: t('Sell'), tone: 'down' },
          ]}
        />
      </div>

      <div className="buy-form__amount">
        <AmountInput
          size="hero"
          aria-label={t('Amount in {unit}', { unit: unit === 'quote' ? 'USD' : market.base })}
          value={amount}
          onValueChange={(next) => {
            reset();
            setAmount(next);
          }}
          precision={precision}
          unit={unit === 'quote' ? 'USD' : market.base}
          placeholder="0"
          error={inlineError ?? undefined}
          onMax={available.state === 'ready' && !signedOut ? onMax : undefined}
          maxLabel={t('Max')}
          disabled={busy === 'max'}
        />
        <div className="buy-form__approx">
          <span data-testid="approx" data-tone={plan.ok && buying ? 'up' : undefined}>
            {approx}
          </span>
          <button
            type="button"
            className="buy-form__swap"
            onClick={() => {
              setAmount('');
              setUnit(unit === 'quote' ? 'base' : 'quote');
              reset();
            }}
          >
            <ArrowDownUp size={14} aria-hidden="true" />
            {t('Enter in {unit}', { unit: unit === 'quote' ? market.base : 'USD' })}
          </button>
        </div>
      </div>

      <div className="buy-form__rows">
        {lockAsset ? (
          <div data-testid="buy-row" className="buy-row" data-static="true">
            <CoinIcon asset={coin.base} size={32} />
            <span data-testid="buy-row__text" className="buy-row__text">
              <span className="buy-row__label">{buying ? t('Coin row buy') : t('Coin row sell')}</span>
              <span className="buy-row__value">{coin.base}</span>
            </span>
          </div>
        ) : (
          <button type="button" data-testid="buy-row" className="buy-row" onClick={() => setPickerOpen(true)} aria-label={t('Change coin')}>
            <CoinIcon asset={coin.base} size={32} />
            <span data-testid="buy-row__text" className="buy-row__text">
              <span className="buy-row__label">{buying ? t('Coin row buy') : t('Coin row sell')}</span>
              <span className="buy-row__value" data-testid="coin-row">
                {coin.base}
                {coinLabel ? <span className="buy-row__name"> · {coinLabel}</span> : null}
              </span>
            </span>
            <ChevronRight size={20} aria-hidden="true" className="buy-row__chev" />
          </button>
        )}
        <div data-testid="buy-row" className="buy-row" data-static="true">
          <span data-testid="buy-row__text" className="buy-row__text">
            <span className="buy-row__label">{buying ? t('Pay with') : t('Receive in')}</span>
            {payChoices.length > 1 ? (
              <Select
                items={Object.fromEntries(payChoices.map((asset) => [asset, t('{asset} balance', { asset })]))}
                value={quote}
                onValueChange={(next) => {
                  if (typeof next === 'string') {
                    setPayer(next);
                    setAmount('');
                    reset();
                  }
                }}
              >
                <SelectTrigger
                  size={32}
                  className="buy-row__select h-6 bg-transparent px-0 text-sm text-fg-2 hover:bg-transparent hover:text-fg data-popup-open:bg-transparent"
                  aria-label={buying ? t('Pay with') : t('Receive in')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {payChoices.map((asset) => (
                    <SelectItem key={asset} value={asset}>
                      {t('{asset} balance', { asset })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="buy-row__value">{t('{asset} balance', { asset: quote })}</span>
            )}
          </span>
          <span className="buy-row__aside" data-testid="available">
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
          <dl className="buy-form__summary">
            <div>
              <dt>{t('Estimated price')}</dt>
              <dd data-testid="price">
                <span>{priceLine}</span>
                <StatusChip
                  density="dense"
                  data-testid="price-freshness"
                  asOf={ticker.status === 'ready' ? ticker.asOf : null}
                  staleAfterMs={PRICE_STALE_AFTER_MS}
                  refused={ticker.status === 'refused'}
                  reason={
                    ticker.status === 'refused' ? t('Price refused') : ticker.status === 'ready' ? undefined : t('Price not available')
                  }
                />
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
        <StateBlock
          kind="refused"
          className="buy-state"
          title={estimate.copy.title}
          body={estimate.copy.body}
          code={estimate.copy.reference}
          action={estimate.copy.action}
        />
      ) : null}
      {problem ? (
        <StateBlock kind="refused" className="buy-state" title={problem.title} body={problem.body ?? ''} action={problem.action} />
      ) : null}
      {note.state === 'pending' ? (
        <div className="buy-pending" role="alert" data-testid="pending">
          <p className="buy-pending__title">{uncertainId === note.pending.id ? t('Not confirmed title') : t('Earlier order title')}</p>
          <p className="buy-pending__body">
            {uncertainId === note.pending.id
              ? t('Not confirmed body')
              : note.pending.kind === 'convert'
                ? t('Earlier convert body')
                : t('Earlier order body')}
          </p>
          {checked ? <p className="buy-pending__body">{checked}</p> : null}
          <div className="buy-pending__actions">
            {note.pending.kind === 'cancel' ? (
              <Button variant="secondary" size={40} loading={busy === 'check'} onClick={onCheckCancel}>
                {busy === 'check' ? t('Checking order') : t('Check again')}
              </Button>
            ) : null}
            {note.pending.kind === 'place' ? (
              <Button variant="secondary" size={40} loading={busy === 'check'} onClick={onCheck}>
                {busy === 'check' ? t('Checking order') : t('Check order')}
              </Button>
            ) : null}
            <Button variant="ghost" size={40} nativeButton={false} render={<a href={ACTIVITY_HREF} />}>
              {t('View in Activity')}
            </Button>
          </div>
        </div>
      ) : null}
      {note.state === 'unreadable' ? (
        <p className="buy-pending__body" role="alert">
          {t('No safe storage')}
        </p>
      ) : null}

      {signedOut ? (
        <Button variant="primary" size={buttonSize} fullWidth nativeButton={false} render={<a href={loginHref} />}>
          {buying ? t('Log in to buy') : t('Log in to sell')}
        </Button>
      ) : (
        <Button
          variant={buying ? 'buy' : 'sell'}
          size={buttonSize}
          fullWidth
          disabled={!ready}
          loading={busy === 'review'}
          onClick={onReview}
        >
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
        <p className="buy-pending__body" data-testid="stale-hint">
          {t('Price stale hint')}
        </p>
      ) : null}

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
      {lockAsset ? null : (
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
  return <span className="if-num">{last ? `$${fmtPrice(last, tick)}` : '—'}</span>;
}
