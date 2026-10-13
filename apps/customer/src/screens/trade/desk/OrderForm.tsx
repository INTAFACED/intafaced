import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderBook as WireBook } from '@intafaced/exchange-contract/schemas';
import { SCALE } from '@intafaced/ledger-client/money';
import type { BalanceEntry } from '../../../data/derive';
import { useDataEnv } from '../../../data/hooks';
import { formatAmount } from '../../../shared/money';
import { useSession } from '../../../features/session/session';
import { draftSchema, type Draft, type Preview, type TradeApi } from '../../../features/trade/trade-api';
import type { BookPick } from './OrderBook';
import { STALE_BOOK_MS } from './OrderBook';
import { deskCopy } from './copy';
import { useDeskApi, useRefreshPrivate } from './data';
import {
  Amount,
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
  buttonVariants,
  fmtAmount,
  fmtPct,
  fmtPrice,
  refusalCopy,
  Skeleton,
  StateBlock,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type Loadable,
} from './deps';
import { useLivePreview } from './live-preview';
import type { DeskMarket } from './market';
import {
  amountForValue,
  bboPrice,
  checkOrder,
  floorToLot,
  maxAmount,
  orderValue,
  padDecimals,
  portionOf,
  scaled,
  type OrderType,
  type Problem,
  type Reference,
  type Side,
} from './order-math';
import {
  isInFlight,
  markInFlight,
  onCheckRequested,
  release,
  requestCheck,
  reserve,
  unmarkInFlight,
  usePendingOrder,
  type Pending,
} from './pending';
import { failureOf, previewIsOrderable, previewRefusalCode, refusalFailure, type Failure } from './preview';
import { placesOf } from './text';

const PERCENTS = [25, 50, 75, 100] as const;

/** A basis-point count as the ratio string the percent formatter reads: 20 bps is "0.002". */
const bpsToRatio = (bps: number): string => formatAmount((BigInt(bps) * SCALE) / 10_000n);

function problemText(problem: Problem, market: DeskMarket, t: ReturnType<typeof deskCopy.useCopy>['t']): string {
  switch (problem.kind) {
    case 'amountEmpty':
      return t('Enter an amount');
    case 'priceEmpty':
      return t('Enter a price');
    case 'amountLot':
      return t('Amount must be a whole number of steps', {
        lot: fmtAmount(problem.lot, { places: placesOf(problem.lot) }),
        asset: market.base,
      });
    case 'amountMin':
      return t('Amount too small', { min: fmtAmount(problem.min, { places: placesOf(market.lotSize) }), asset: market.base });
    case 'priceTick':
      return t('Price must be a whole number of steps', { tick: fmtPrice(problem.tick, problem.tick), asset: market.quote });
    case 'valueMin':
      return t('Value too small', { min: fmtAmount(problem.min, { places: 8 }), asset: market.quote });
    case 'noPrice':
      return t('No prices to judge a market order');
  }
}

/** The reason a refusal gives, with its action link ("Verify now") when it has one. */
function RefusalNote({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  const { t } = deskCopy.useCopy();
  if (failure.kind === 'network')
    return (
      <div className="dk-note dk-note--bad" role="alert">
        <p>{t('Couldn’t check the order')}</p>
        {onRetry ? (
          <button type="button" className="dk-link" onClick={onRetry}>
            {t('Check again')}
          </button>
        ) : null}
      </div>
    );
  const { title, body, action, reference } = failure.copy;
  return (
    <div className="dk-note dk-note--bad" role="alert">
      <p className="dk-note-title">{title}</p>
      <p>{body}</p>
      {action ? (
        <a className="dk-link" href={action.href}>
          {action.label}
        </a>
      ) : null}
      {reference ? <p className="dk-note-ref">{reference}</p> : null}
    </div>
  );
}

interface SideProps {
  side: Side;
  type: OrderType;
  market: DeskMarket;
  reference: Reference | null;
  referenceFresh: boolean;
  /** Free balance of the asset this side spends (quote for a buy, base for a sell); null while unknown. */
  available: string | null;
  signedIn: boolean;
  userId: string | null;
  blocked: boolean;
  api: TradeApi;
  suggestion: BookPick | null;
  autoFocus: boolean;
  onPlaced: () => void;
}

function SideForm({
  side,
  type,
  market,
  reference,
  referenceFresh,
  available,
  signedIn,
  userId,
  blocked,
  api,
  suggestion,
  autoFocus,
  onPlaced,
}: SideProps) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [totalEdit, setTotalEdit] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [review, setReview] = useState<{ draft: Draft; preview: Preview; changed: boolean } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const spendAsset = side === 'buy' ? market.quote : market.base;
  const amountPlaces = placesOf(market.lotSize);
  const pricePlaces = placesOf(market.tickSize);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const context = useMemo(
    () => ({
      asset: spendAsset,
      available: available === null ? undefined : fmtAmount(available, { places: 8 }),
      pair: market.symbol.replace('/', '-'),
    }),
    [spendAsset, available, market.symbol],
  );

  const edit = (apply: () => void) => {
    if (busyRef.current) return;
    apply();
    setReview(null);
    setFailure(null);
    setStatus(null);
    setHint(null);
  };

  // A click in the book or the trades list fills the price (and the cumulative amount with Shift).
  useEffect(() => {
    if (!suggestion) return;
    edit(() => {
      setPrice(padDecimals(suggestion.price, pricePlaces));
      setTotalEdit(null);
      if (suggestion.amount) {
        const lots = floorToLot(suggestion.amount, market.lotSize);
        if (lots) setAmount(lots);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion?.nonce]);

  const input = { side, type, price, amount };
  const checked = checkOrder(input, market, reference);
  const value = orderValue(input, reference);
  const max = maxAmount({ side, type, price, available, market, ref: reference });
  const tradable = signedIn && market.open && !blocked;

  // Advisory preview from the server, only for an order the client rules accept.
  const draft: Draft | null = useMemo(() => {
    if (!tradable || !checked.ok) return null;
    return {
      symbol: market.symbol,
      side,
      type,
      amount: checked.amount,
      ...(checked.price ? { price: checked.price } : {}),
      timeInForce: 'GTC',
      postOnly: false,
      clientOrderId: 'desk-preview',
    };
  }, [tradable, checked.ok, checked.ok ? checked.amount : '', checked.ok ? checked.price : '', market.symbol, side, type]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = draft ? `${draft.symbol}|${draft.side}|${draft.type}|${draft.amount}|${draft.price ?? ''}` : 'none';
  const { live, retry } = useLivePreview(api, draft && !review ? draft : null, key, context, () => env.poller.recordExternalRequest());
  const canSend = tradable && checked.ok && live.state === 'ok' && !busy;

  async function startReview() {
    if (!canSend || busyRef.current || !checked.ok) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setStatus(null);
    const fresh: Draft = {
      symbol: market.symbol,
      side,
      type,
      amount: checked.amount,
      ...(checked.price ? { price: checked.price } : {}),
      timeInForce: 'GTC',
      postOnly: false,
      clientOrderId: `desk:${crypto.randomUUID()}`,
    };
    const parsed = draftSchema.safeParse(fresh);
    if (!parsed.success) setFailure({ kind: 'network' });
    else {
      env.poller.recordExternalRequest();
      const result = await api.preview(parsed.data);
      if (!mounted.current) return;
      if (!result.ok) setFailure(failureOf(result, context));
      else if (previewIsOrderable(result.data)) setReview({ draft: parsed.data, preview: result.data, changed: false });
      else setFailure(refusalFailure(previewRefusalCode(result.data), context));
    }
    setBusy(false);
    busyRef.current = false;
  }

  async function confirm() {
    if (!review || busyRef.current || !userId) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const { draft: sending, preview } = review;
    const reservation = await reserve(userId, { kind: 'place', symbol: sending.symbol, id: sending.clientOrderId, startedAt: Date.now() });
    if (reservation !== 'reserved') {
      if (mounted.current) {
        setReview(null);
        setFailure(
          reservation === 'other-tab'
            ? { kind: 'refusal', copy: { title: t('Another tab'), body: t('Not sent') } }
            : reservation === 'no-locks'
              ? { kind: 'refusal', copy: { title: t('No tab lock'), body: t('Not sent') } }
              : reservation === 'no-storage'
                ? { kind: 'refusal', copy: { title: t('No storage'), body: t('Not sent') } }
                : { kind: 'refusal', copy: { title: t('Unreadable marker'), body: t('Not sent') } },
        );
        setBusy(false);
      }
      busyRef.current = false;
      return;
    }
    env.poller.recordExternalRequest(2);
    markInFlight(sending.clientOrderId);
    // `place` asks for a fresh preview first and refuses to send if it differs from the one reviewed. One call per
    // click: nothing here sends the order a second time.
    let result: Awaited<ReturnType<TradeApi['place']>>;
    try {
      result = await api.place(sending, preview, (refreshed) => mounted.current && previewIsOrderable(refreshed));
    } finally {
      unmarkInFlight(sending.clientOrderId);
    }
    if (result.ok) {
      release(userId, sending.clientOrderId);
      if (mounted.current) {
        const done = result.data;
        const sideWord = side === 'buy' ? t('Order placed side buy') : t('Order placed side sell');
        const complete = scaled(done.remaining) === 0n && done.status === 'closed';
        setStatus(
          complete
            ? t('Order placed filled', { side: sideWord, amount: fmtAmount(done.filled, { places: amountPlaces }), asset: market.base })
            : done.status === 'open'
              ? t('Order placed open', { side: sideWord })
              : t('Order placed done', { side: sideWord }),
        );
        setReview(null);
        setAmount('');
        setTotalEdit(null);
      }
      onPlaced();
    } else if (result.reason === 'changed') {
      // Nothing was sent: the fresh preview differs from the reviewed one. Show the new numbers and ask again.
      release(userId, sending.clientOrderId);
      if (mounted.current) {
        if (previewIsOrderable(result.preview)) setReview({ draft: sending, preview: result.preview, changed: true });
        else {
          setReview(null);
          setFailure(refusalFailure(previewRefusalCode(result.preview), context));
        }
      }
    } else if (result.reason === 'uncertain') {
      // The order may have reached the service. Keep the marker: the desk looks it up and blocks new orders until then.
      if (mounted.current) setReview(null);
      onPlaced();
      requestCheck();
    } else {
      release(userId, sending.clientOrderId);
      if (mounted.current) {
        setReview(null);
        setFailure(failureOf(result, context));
      }
    }
    if (mounted.current) setBusy(false);
    busyRef.current = false;
  }

  function pickPercent(percent: (typeof PERCENTS)[number]) {
    if (available === null) return;
    if (max === null) {
      setHint(t('Enter a price first'));
      return;
    }
    const portion = portionOf(max, percent, market.lotSize);
    if (portion === null) {
      setHint(refusalCopy('ledger.insufficient_funds', context).title);
      return;
    }
    edit(() => {
      setAmount(portion);
      setTotalEdit(null);
    });
  }

  const showProblem = !checked.ok && (checked.problem.kind !== 'amountEmpty' || price !== '');
  const total = totalEdit ?? (type === 'limit' ? (value?.value ?? '') : '');
  const verb = side === 'buy' ? t('Buy asset', { asset: market.base }) : t('Sell asset', { asset: market.base });
  const sideWord = side === 'buy' ? t('Side buy') : t('Side sell');
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  const bbo = bboPrice(side, reference);

  return (
    <form
      className="dk-form"
      data-side={side}
      aria-label={side === 'buy' ? t('Buy form', { asset: market.base }) : t('Sell form', { asset: market.base })}
      onSubmit={(event) => {
        event.preventDefault();
        void startReview();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && matchMedia('(pointer: fine)').matches) {
          event.preventDefault();
          void startReview();
        }
      }}
    >
      {type === 'limit' ? (
        <AmountInput
          label={t('Price')}
          value={price}
          onValueChange={(next) => edit(() => (setPrice(next), setTotalEdit(null)))}
          precision={pricePlaces}
          placeholder={fmtPrice('0', market.tickSize)}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quote}
          stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
          onBbo={bbo && referenceFresh ? () => edit(() => (setPrice(padDecimals(bbo, pricePlaces)), setTotalEdit(null))) : undefined}
          bboLabel={t('BBO')}
          aria-label={t('Price')}
        />
      ) : (
        <AmountInput
          label={t('Price')}
          value=""
          onValueChange={() => undefined}
          precision={pricePlaces}
          readOnly
          disabled
          unit={market.quote}
          placeholder={t('Market price word')}
          aria-label={t('Price')}
        />
      )}
      <AmountInput
        label={t('Amount')}
        value={amount}
        onValueChange={(next) => edit(() => (setAmount(next), setTotalEdit(null)))}
        precision={amountPlaces}
        unit={market.base}
        placeholder={market.minAmount ? t('Min amount', { min: fmtAmount(market.minAmount, { places: amountPlaces }) }) : '0'}
        onMax={max ? () => pickPercent(100) : undefined}
        maxLabel={t('Max')}
        autoFocus={autoFocus}
        aria-label={t('Amount')}
      />
      <div className="dk-percents" role="group" aria-label={t('Amount')}>
        {PERCENTS.map((percent) => (
          <button
            key={percent}
            type="button"
            disabled={!signedIn || available === null}
            aria-label={t('Percent of max', { percent })}
            onClick={() => pickPercent(percent)}
          >
            {percent}%
          </button>
        ))}
      </div>
      <AmountInput
        label={type === 'limit' ? t('Total') : t('Total estimate')}
        value={total}
        onValueChange={(next) =>
          edit(() => {
            if (type !== 'limit') return;
            if (scaled(price) === null) {
              setHint(t('Enter a price first'));
              return;
            }
            setTotalEdit(next);
            setAmount(next === '' ? '' : (amountForValue(next, price, market.lotSize) ?? ''));
          })
        }
        precision={8}
        unit={market.quote}
        readOnly={type !== 'limit'}
        placeholder="0"
        aria-label={t('Total')}
      />
      <dl className="dk-avail">
        <div>
          <dt>{t('Available')}</dt>
          <dd className="if-num">
            {signedIn ? <Amount value={available === null ? null : `${fmtAmount(available, { places: 8 })} ${spendAsset}`} /> : '—'}
          </dd>
        </div>
        <div>
          <dt>{side === 'buy' ? t('Max buy') : t('Max sell')}</dt>
          <dd className="if-num">{signedIn && max !== null ? `${fmtAmount(max, { places: amountPlaces })} ${market.base}` : '—'}</dd>
        </div>
      </dl>
      <p className="dk-fees if-num">
        {t('Fees line', { maker: fmtPct(market.maker, { signed: false }), taker: fmtPct(market.taker, { signed: false }) })}
      </p>
      {signedIn ? (
        <Button
          type="submit"
          variant={side}
          shape="rounded"
          size={40}
          fullWidth
          loading={busy && !review}
          disabled={!canSend}
          aria-describedby={`dk-reason-${side}`}
        >
          {verb}
        </Button>
      ) : (
        <a className={buttonVariants({ variant: side, shape: 'rounded', size: 40, fullWidth: true })} href={loginHref}>
          {t('Log in to trade')}
        </a>
      )}
      <div className="dk-reason" id={`dk-reason-${side}`} aria-live="polite">
        {hint ? <p className="dk-note">{hint}</p> : null}
        {signedIn && !market.open ? <p className="dk-note">{t('Market is closed')}</p> : null}
        {tradable && showProblem && !checked.ok ? <p className="dk-note">{problemText(checked.problem, market, t)}</p> : null}
        {tradable && checked.ok && live.state === 'checking' ? <p className="dk-note">{t('Checking the order')}</p> : null}
        {tradable && checked.ok && live.state === 'blocked' ? <RefusalNote failure={live.failure} /> : null}
        {tradable && checked.ok && live.state === 'error' ? <RefusalNote failure={{ kind: 'network' }} onRetry={retry} /> : null}
        {failure ? <RefusalNote failure={failure} /> : null}
        {status ? (
          <p className="dk-note dk-note--good" role="status">
            {status}
          </p>
        ) : null}
      </div>

      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) setReview(null);
        }}
      >
        {review ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{side === 'buy' ? t('Review buy') : t('Review sell')}</AlertDialogTitle>
              <AlertDialogDescription>{review.changed ? t('Review changed') : t('Review intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            <ReviewRows market={market} review={review} side={side} sideWord={sideWord} />
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={busy} onClick={() => setReview(null)}>
                {t('Cancel')}
              </Button>
              <Button variant={side} shape="pill" size={40} loading={busy} onClick={() => void confirm()}>
                {side === 'buy' ? t('Confirm buy') : t('Confirm sell')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </form>
  );
}

function ReviewRows({
  market,
  review,
  side,
}: {
  market: DeskMarket;
  review: { draft: Draft; preview: Preview };
  side: Side;
  sideWord: string;
}) {
  const { t } = deskCopy.useCopy();
  const { draft, preview } = review;
  const limit = draft.type === 'limit';
  const value = limit && draft.price ? orderValue({ side, type: 'limit', price: draft.price, amount: draft.amount }, null) : null;
  const feeRate = preview.feeBps === null ? null : fmtPct(bpsToRatio(preview.feeBps), { signed: false });
  return (
    <dl className="dk-review-rows">
      <div>
        <dt>{t('Review market')}</dt>
        <dd>{market.symbol}</dd>
      </div>
      <div>
        <dt>{t('Review type')}</dt>
        <dd>{limit ? t('Order type limit') : t('Order type market')}</dd>
      </div>
      <div>
        <dt>{t('Review price')}</dt>
        <dd className="if-num">
          {limit && draft.price ? `${fmtPrice(draft.price, market.tickSize)} ${market.quote}` : t('Review market price')}
        </dd>
      </div>
      <div>
        <dt>{t('Review amount')}</dt>
        <dd className="if-num">
          {fmtAmount(draft.amount, { places: placesOf(market.lotSize) })} {market.base}
        </dd>
      </div>
      {value ? (
        <div>
          <dt>{t('Review value')}</dt>
          <dd className="if-num">
            {fmtAmount(value.value, { places: 8 })} {market.quote}
          </dd>
        </div>
      ) : null}
      <div>
        <dt>{t('Review hold')}</dt>
        <dd className="if-num">
          {fmtAmount(preview.holdAmount, { places: 8 })} {preview.holdAsset}
        </dd>
      </div>
      <div>
        <dt>{t('Review fee')}</dt>
        <dd className="if-num">
          {fmtAmount(preview.estimatedFee, { places: 8 })} {preview.feeAsset}
          {feeRate
            ? ` (${t('Review fee rate', { rate: feeRate, role: preview.feeRole === 'maker' ? t('Review role maker') : t('Review role taker') })})`
            : ''}
        </dd>
      </div>
      {preview.protectionPrice ? (
        <div>
          <dt>{t('Review protection')}</dt>
          <dd className="if-num">
            {side === 'buy'
              ? t('Review protection buy', {
                  price: fmtPrice(preview.protectionPrice, market.tickSize),
                  asset: market.quote,
                  base: market.base,
                })
              : t('Review protection sell', {
                  price: fmtPrice(preview.protectionPrice, market.tickSize),
                  asset: market.quote,
                  base: market.base,
                })}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

interface PanelProps {
  market: DeskMarket;
  book: Loadable<WireBook>;
  balances: Loadable<Record<string, BalanceEntry>>;
  suggestion: BookPick | null;
  focusSide: Side | null;
  /** Called after an order was sent (placed, or outcome unknown) so the lists refresh. */
  onPlaced: () => void;
}

/** Centre bottom (UI-SPEC 5.7): Limit / Market tabs and the Buy and Sell forms side by side. */
export function OrderPanel({ market, book, balances, suggestion, focusSide, onPlaced }: PanelProps) {
  const { t } = deskCopy.useCopy();
  const { userId } = useSession();
  const api = useDeskApi();
  const refresh = useRefreshPrivate();
  const [type, setType] = useState<OrderType>('limit');
  const pending = usePendingOrder(userId);
  const [settled, setSettled] = useState<string | null>(null);
  const [stillChecking, setStillChecking] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const lastSuggestion = useRef(0);

  // A book click means a limit order at that price.
  useEffect(() => {
    if (suggestion && suggestion.nonce !== lastSuggestion.current) {
      lastSuggestion.current = suggestion.nonce;
      setType('limit');
    }
  }, [suggestion]);

  const bookData = book.status === 'ready' ? book.data : null;
  const reference: Reference | null = bookData ? { bestBid: bookData.bids[0]?.[0] ?? null, bestAsk: bookData.asks[0]?.[0] ?? null } : null;
  const referenceFresh = bookData !== null && Date.now() - bookData.timestamp < STALE_BOOK_MS;
  const signedIn = userId !== null;
  const free = (asset: string): string | null => (balances.status === 'ready' ? (balances.data[asset]?.free ?? '0') : null);

  const pendingValue: Pending | null = pending.state === 'pending' ? pending.value : null;
  const blocked = pending.state !== 'none';

  async function check() {
    if (!pendingValue || pendingValue.kind !== 'place' || !userId || checkingRef.current || isInFlight(pendingValue.id)) return;
    checkingRef.current = true;
    setChecking(true);
    const result = await api.reconcile(pendingValue.id, pendingValue.symbol);
    if (result.ok && !result.data.recoveryRequired) {
      release(userId, pendingValue.id);
      setStillChecking(false);
      setSettled(
        t('Settled filled', {
          status: t(`Order status ${result.data.status}` as 'Order status open'),
          filled: fmtAmount(result.data.filled, { places: placesOf(market.lotSize) }),
          amount: fmtAmount(result.data.amount, { places: placesOf(market.lotSize) }),
          asset: result.data.symbol.split('/')[0] ?? market.base,
        }),
      );
      refresh();
    } else setStillChecking(true);
    checkingRef.current = false;
    setChecking(false);
  }
  const checkRef = useRef(check);
  checkRef.current = check;
  const pendingId = pendingValue?.id;
  useEffect(() => {
    if (!pendingId || pendingValue?.kind !== 'place') return;
    void checkRef.current();
    const timer = setInterval(() => void checkRef.current(), 5_000);
    const stop = onCheckRequested(() => void checkRef.current());
    return () => {
      clearInterval(timer);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  const common = {
    market,
    reference,
    referenceFresh,
    signedIn,
    userId,
    blocked,
    api,
    suggestion,
    onPlaced: () => (refresh(), onPlaced()),
    type,
  } as const;
  return (
    <Tabs value={type} onValueChange={(value) => setType(value as OrderType)} className="dk-panel dk-order">
      <TabsList divider className="dk-tabs" aria-label={t('Order type')}>
        <TabsTab value="limit">{t('Limit')}</TabsTab>
        <TabsTab value="market">{t('Market')}</TabsTab>
      </TabsList>
      {!market.open ? (
        <div className="dk-order-body">
          <StateBlock kind="refused" title={t('Market closed title')} body={t('Market closed body')} />
        </div>
      ) : (
        <TabsPanel value={type} className="dk-order-body">
          {pending.state === 'pending' ? (
            <div className="dk-note dk-note--warn" role="status">
              <p className="dk-note-title">{t('Checking your order')}</p>
              <p>{t('Checking your order body')}</p>
              {pending.value.kind === 'place' ? (
                <button type="button" className="dk-link" disabled={checking} onClick={() => void check()}>
                  {t('Check now')}
                </button>
              ) : null}
              {stillChecking ? <p>{t('Still checking')}</p> : null}
            </div>
          ) : pending.state === 'unreadable' ? (
            <div className="dk-note dk-note--warn" role="status">
              <p>{t('Unreadable marker')}</p>
            </div>
          ) : settled ? (
            <div className="dk-note dk-note--good" role="status">
              <p>{settled}</p>
            </div>
          ) : null}
          {balances.status === 'loading' && signedIn ? (
            <div className="dk-forms" aria-busy="true">
              <Skeleton height={320} className="bg-field" />
              <Skeleton height={320} className="bg-field" />
            </div>
          ) : (
            <div className="dk-forms">
              <SideForm {...common} side="buy" available={signedIn ? free(market.quote) : null} autoFocus={focusSide === 'buy'} />
              <SideForm {...common} side="sell" available={signedIn ? free(market.base) : null} autoFocus={focusSide === 'sell'} />
            </div>
          )}
        </TabsPanel>
      )}
    </Tabs>
  );
}
