import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { BalanceEntry } from '../../../data/derive';
import { useDataEnv } from '../../../data/hooks';
import { useSession } from '../../../features/session/session';
import { draftSchema, type Draft, type Preview, type TradeApi } from '../../../features/trade/trade-api';
import type { BookPick } from './OrderBook';
import { deskCopy } from './copy';
import { useDeskApi, useListedFees, useOpenOrders, useRefreshPrivate } from './data';
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
import { MoreOrderTypes, TifSelect } from './OrderOptions';
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
  probeAmount,
  protectionNow,
  scaled,
  exitSideOff,
  hasExits,
  isBuyOco,
  isPriced,
  serviceType,
  type OrderType,
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
import { bpsToRatio, exitFeeLines, feeRate, gateSubmit, holdShort, marketSellOff, sizeFor } from './form-logic';
import { CONFLICT_CODE, resendOrder, resendOutcome } from './resend';
import { clearOrdersPaused, markOrdersPaused } from './orders-paused';
import { scaleLockStays } from './ticket/scale-flow';
import { failureOf, isLedgerFrozen, previewIsOrderable, previewRefusalCode, refusalFailure, type Failure } from './preview';
import { placesOf } from './text';
import { problemText } from './problem-text';
import { draftOf } from './draft-of';
import { outcomeOf, tifLabelKey, tifOfDraft, tifFor, type Tif } from './tif';

const PERCENTS = [25, 50, 75, 100] as const;

/** Words for an order that came back with nothing traded: refused outright, or cancelled with nothing filled. */
function notTradedCopy(
  tif: Tif,
  kind: 'rejected' | 'noFill',
  t: ReturnType<typeof deskCopy.useCopy>['t'],
): { title: string; body: string } {
  if (tif === 'PO') return { title: t('Not placed post only title'), body: t('Not placed post only body') };
  if (tif === 'FOK') return { title: t('Not placed fok title'), body: t('Not placed fok body') };
  if (kind === 'noFill') return { title: t('Nothing filled title'), body: t('Nothing filled body') };
  return { title: t('Not placed title'), body: t('Not placed body') };
}

/** The reason a refusal gives, with its action link ("Verify now") when it has one. */
/**
 * A resting bracket entry is refused with the generic "order type" code when the login cannot back it (no trading scope,
 * or no known expiry). Say that, not "limit and market orders only".
 */
function restingRefusal(failure: Failure, draft: Draft): Failure {
  if (failure.kind !== 'refusal' || draft.exit?.kind !== 'bracket' || draft.type !== 'limit' || draft.timeInForce !== 'GTC') return failure;
  if (failure.copy.title !== refusalCopy('trade.order_type_unsupported', {}).title) return failure;
  return {
    kind: 'refusal',
    copy: { title: deskCopy.t('Resting bracket refused title'), body: deskCopy.t('Resting bracket refused body') },
  };
}

function RefusalNote({ failure, onRetry, onDismiss }: { failure: Failure; onRetry?: () => void; onDismiss?: () => void }) {
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
      {onDismiss ? (
        <button type="button" className="dk-dismiss" aria-label={t('Dismiss')} onClick={onDismiss}>
          ×
        </button>
      ) : null}
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
  /** Time in force picked once for both tickets (limit: GTC, post only, IOC, FOK; market: standard or FOK). */
  tif: Tif;
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
  tif,
  onPlaced,
}: SideProps) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const [price, setPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLimit, setStopLimit] = useState('');
  // A bracket buy that went through but whose exits were refused: the SAME request is sent again to place them, never a new buy.
  const [exitRetry, setExitRetry] = useState<Draft | null>(null);
  const [amount, setAmount] = useState('');
  const [totalEdit, setTotalEdit] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // The id of the resting order that "Your order is in" is about; and whether the open list has shown it.
  const [restingId, setRestingId] = useState<string | null>(null);
  const restingSeen = useRef(false);
  const openOrders = useOpenOrders();
  const listedFees = useListedFees();
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

  // "Your order is in" is news for a moment, not a permanent fact: it would still be on screen after the order is cancelled (critic L5).
  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => setStatus(null), 12_000);
    return () => clearTimeout(timer);
  }, [status]);

  // ...and it goes the moment that order leaves Open orders (cancelled or filled), so it never sits beside "No open orders".
  useEffect(() => {
    if (restingId === null || (openOrders.status !== 'ready' && openOrders.status !== 'empty')) return;
    const open = openOrders.status === 'ready' ? openOrders.data : [];
    if (open.some((order) => order.id === restingId)) restingSeen.current = true;
    else if (restingSeen.current) {
      setStatus(null);
      setRestingId(null);
      restingSeen.current = false;
    }
  }, [restingId, openOrders]);

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

  const input = { side, type, price, amount, stopPrice, stopLimit, takeProfit, tif };
  const priced = isPriced(type);
  const checked = checkOrder(input, market, reference);
  const value = orderValue(input, reference);
  const sellOff = marketSellOff(side, type);
  const exitOff = exitSideOff(side, type);
  const held = blocked || exitRetry !== null;
  const tradable = signedIn && market.open && !held && !sellOff && !exitOff;

  // Advisory preview from the server, only for an order the client rules accept.
  const draft: Draft | null = useMemo(() => {
    if (!tradable || !checked.ok) return null;
    return draftOf({ market, side, type, tif, checked, clientOrderId: 'desk-preview' });
  }, [
    tradable,
    checked.ok,
    checked.ok ? checked.amount : '',
    checked.ok ? checked.price : '',
    checked.ok ? (checked.stopPrice ?? '') : '',
    checked.ok ? (checked.exit?.takeProfit ?? '') : '',
    checked.ok ? (checked.exit?.stopLoss ?? '') : '',
    checked.ok ? (checked.exit?.stopLossLimit ?? '') : '',
    market.symbol,
    side,
    type,
    tif,
  ]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = draft
    ? `${draft.symbol}|${draft.side}|${draft.type}|${draft.amount}|${draft.price ?? ''}|${draft.stopPrice ?? ''}|${tif}`
    : 'none';
  const { live, retry } = useLivePreview(api, draft && !review ? draft : null, key, context, () => env.poller.recordExternalRequest());

  // A market buy is held at the service's price protection (best ask plus the slippage cap), so Max is sized from it.
  // It is learnt from the order check, or from one small probe check on the Market tab; never guessed.
  const marketBuy = side === 'buy' && serviceType(type, price) === 'market';
  const [protection, setProtection] = useState<{ price: string; ask: string } | null>(null);
  const bestAsk = reference?.bestAsk ?? null;
  const liveProtection = live.state === 'ok' ? live.preview.protectionPrice : null;
  useEffect(() => {
    if (marketBuy && liveProtection && bestAsk) setProtection({ price: liveProtection, ask: bestAsk });
  }, [marketBuy, liveProtection, bestAsk]);
  const probed = useRef(false);
  useEffect(() => {
    if (!marketBuy || protection !== null || probed.current || !tradable || !bestAsk) return;
    const probe = probeAmount(market, bestAsk);
    if (!probe) return;
    probed.current = true;
    env.poller.recordExternalRequest();
    void api
      .preview({
        symbol: market.symbol,
        side: 'buy',
        type: 'market',
        amount: probe,
        timeInForce: 'GTC',
        postOnly: false,
        clientOrderId: 'desk-preview',
      })
      .then((result) => {
        if (mounted.current && result.ok && result.data.protectionPrice)
          setProtection({ price: result.data.protectionPrice, ask: bestAsk });
      });
  }, [marketBuy, protection, tradable, bestAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  const protectionPrice = marketBuy ? protectionNow(protection?.price ?? null, protection?.ask ?? null, bestAsk) : null;
  const max = maxAmount({ side, type, price, available, market, protectionPrice, stopLimit });
  const spendTyped = useRef(false);
  // A typed spend stays a cap while the ask moves: re-size the amount from the current protection price. Leaving a market buy drops it.
  useEffect(() => {
    if (totalEdit === null) return;
    if (!marketBuy) {
      if (spendTyped.current) setTotalEdit(null);
      return;
    }
    if (protectionPrice === null) return;
    setAmount(amountForValue(totalEdit, protectionPrice, market.lotSize) ?? '');
  }, [marketBuy, protectionPrice, totalEdit, market.lotSize]);
  const short = live.state === 'ok' && holdShort(live.preview, spendAsset, available);
  const gate = gateSubmit({
    signedIn,
    marketOpen: market.open,
    pending: held,
    side,
    type,
    checkedOk: checked.ok,
    live: live.state,
    short,
    busy,
  });
  const canSend = gate.canSend;

  async function startReview() {
    if (!canSend || busyRef.current || !checked.ok) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setStatus(null);
    const fresh = draftOf({ market, side, type, tif, checked, clientOrderId: `desk:${crypto.randomUUID()}` });
    const parsed = draftSchema.safeParse(fresh);
    if (!parsed.success) setFailure({ kind: 'network' });
    else {
      env.poller.recordExternalRequest();
      const result = await api.preview(parsed.data);
      if (!mounted.current) return;
      if (!result.ok) setFailure(failureOf(result, context));
      else if (previewIsOrderable(result.data) && holdShort(result.data, spendAsset, available))
        setFailure(refusalFailure('ledger.insufficient_funds', context));
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
    const reservation = await reserve(userId, {
      kind: 'place',
      symbol: sending.symbol,
      id: sending.clientOrderId,
      startedAt: Date.now(),
      draft: sending,
    });
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
      clearOrdersPaused();
      release(userId, sending.clientOrderId);
      if (mounted.current) {
        const done = result.data;
        const sideWord = side === 'buy' ? t('Order placed side buy') : t('Order placed side sell');
        const outcome = outcomeOf(done, tifOfDraft(sending));
        restingSeen.current = false;
        setRestingId(outcome.kind === 'resting' ? done.id : null);
        if (outcome.kind === 'rejected' || outcome.kind === 'noFill') {
          // Nothing traded: say so as a refusal, keep what the person typed, and never call it "done".
          setReview(null);
          setFailure({ kind: 'refusal', copy: notTradedCopy(outcome.tif, outcome.kind, t) });
        } else {
          setStatus(
            outcome.kind === 'filled'
              ? t('Order placed filled', { side: sideWord, amount: fmtAmount(done.filled, { places: amountPlaces }), asset: market.base })
              : outcome.kind === 'resting'
                ? t('Order placed open', { side: sideWord })
                : outcome.kind === 'partCancelled'
                  ? t('Order placed part cancelled', {
                      side: sideWord,
                      filled: fmtAmount(done.filled, { places: amountPlaces }),
                      amount: fmtAmount(done.amount, { places: amountPlaces }),
                      asset: market.base,
                    })
                  : t('Order placed done', { side: sideWord }),
          );
          setReview(null);
          setAmount('');
          setTotalEdit(null);
        }
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
    } else if (result.code === 'trade.bracket_exit_failed') {
      // The buy went through; only the exits were refused. Offer the same request again so the buy is never repeated.
      release(userId, sending.clientOrderId);
      if (mounted.current) {
        setReview(null);
        setExitRetry(sending);
      }
      onPlaced();
    } else {
      release(userId, sending.clientOrderId);
      if (isLedgerFrozen(result)) markOrdersPaused();
      if (mounted.current) {
        setReview(null);
        setFailure(restingRefusal(failureOf(result, context), sending));
      }
    }
    if (mounted.current) setBusy(false);
    busyRef.current = false;
  }

  /** Send the same bracket request again (same order number): the service returns the buy it has and places the exits. */
  async function placeExits() {
    if (!exitRetry || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    markInFlight(exitRetry.clientOrderId);
    let result: Awaited<ReturnType<TradeApi['resend']>>;
    try {
      env.poller.recordExternalRequest();
      result = await api.resend(exitRetry);
    } finally {
      unmarkInFlight(exitRetry.clientOrderId);
    }
    if (mounted.current) {
      if (result.ok) {
        setExitRetry(null);
        setStatus(t('Exits placed'));
        setAmount('');
        setTotalEdit(null);
        onPlaced();
      } else if (result.code === 'trade.bracket_exit_failed' || result.reason === 'uncertain') setHint(t('Exits still not placed'));
      else setFailure(failureOf(result, context));
    }
    if (mounted.current) setBusy(false);
    busyRef.current = false;
  }

  function pickPercent(percent: (typeof PERCENTS)[number]) {
    if (available === null) return;
    const size = sizeFor({ side, type, price, available, lotSize: market.lotSize, protectionPrice, stopLimit, percent });
    if (size.amount === null) {
      setHint(
        size.needsPrice
          ? marketBuy
            ? t('Checking the order')
            : t('Enter a price first')
          : refusalCopy('ledger.insufficient_funds', context).title,
      );
      return;
    }
    const sized = size.amount;
    edit(() => {
      setAmount(sized);
      setTotalEdit(null);
    });
  }

  const showProblem = !checked.ok && status === null && (checked.problem.kind !== 'amountEmpty' || price !== '');
  const total = totalEdit ?? value?.value ?? '';
  const verb = side === 'buy' ? t('Buy asset', { asset: market.base }) : t('Sell asset', { asset: market.base });
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  const bbo = bboPrice(side, reference);
  const listed = listedFees.status === 'ready' ? (listedFees.data[market.symbol] ?? null) : null;

  const stopInput = (label: string) => (
    <AmountInput
      label={label}
      value={stopPrice}
      onValueChange={(next) => edit(() => setStopPrice(next))}
      precision={pricePlaces}
      placeholder={fmtPrice('0', market.tickSize)}
      tick={market.tickSize}
      min={market.tickSize}
      unit={market.quote}
      stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
      aria-label={label}
    />
  );

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
      {type === 'stop_limit' ? stopInput(t('Stop price')) : null}
      {type === 'bracket' ? (
        <AmountInput
          label={t('Entry price')}
          value={price}
          onValueChange={(next) => edit(() => (setPrice(next), setTotalEdit(null)))}
          precision={pricePlaces}
          placeholder={t('Entry price market')}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quote}
          stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
          onBbo={bbo && referenceFresh ? () => edit(() => (setPrice(padDecimals(bbo, pricePlaces)), setTotalEdit(null))) : undefined}
          bboLabel={t('BBO')}
          aria-label={t('Entry price')}
        />
      ) : priced ? (
        <AmountInput
          label={type === 'oco' ? t('Take profit') : t('Price')}
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
          aria-label={type === 'oco' ? t('Take profit') : t('Price')}
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
      {type === 'bracket' ? (
        <AmountInput
          label={t('Take profit')}
          value={takeProfit}
          onValueChange={(next) => edit(() => setTakeProfit(next))}
          precision={pricePlaces}
          placeholder={fmtPrice('0', market.tickSize)}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quote}
          stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
          aria-label={t('Take profit')}
        />
      ) : null}
      {hasExits(type) ? stopInput(t('Stop loss')) : null}
      {isBuyOco(side, type) ? (
        <AmountInput
          label={t('Stop loss limit')}
          value={stopLimit}
          onValueChange={(next) => edit(() => (setStopLimit(next), setTotalEdit(null)))}
          precision={pricePlaces}
          placeholder={fmtPrice('0', market.tickSize)}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quote}
          stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
          aria-label={t('Stop loss limit')}
        />
      ) : null}
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
        label={priced ? t('Total') : marketBuy ? t('Spend up to') : t('Total estimate')}
        value={total}
        onValueChange={(next) =>
          edit(() => {
            if (!priced && !marketBuy) return;
            // A priced order is sized at its price; a market buy at the service's price protection, so the hold never passes the spend.
            const heldPrice = marketBuy ? protectionPrice : isBuyOco(side, type) ? stopLimit : price;
            if (heldPrice === null || scaled(heldPrice) === null) {
              setHint(marketBuy ? t('Checking the order') : t('Enter a price first'));
              return;
            }
            spendTyped.current = marketBuy;
            setTotalEdit(next);
            setAmount(next === '' ? '' : (amountForValue(next, heldPrice, market.lotSize) ?? ''));
          })
        }
        precision={8}
        unit={market.quote}
        readOnly={!priced && !(marketBuy && protectionPrice !== null)}
        placeholder="0"
        aria-label={marketBuy ? t('Spend') : t('Total')}
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
        <span>
          {sellOff
            ? t('Fee at fill')
            : live.state === 'ok' && feeRate(live.preview) !== null
              ? live.preview.feeRole === 'maker'
                ? t('Fee maker', { rate: fmtPct(feeRate(live.preview)!, { signed: false }) })
                : priced && tif === 'GTC'
                  ? t('Fee up to', { rate: fmtPct(feeRate(live.preview)!, { signed: false }) })
                  : t('Fee taker', { rate: fmtPct(feeRate(live.preview)!, { signed: false }) })
              : t('Fee unknown')}
        </span>
        {listed ? (
          <span className="dk-fees-listed" title={t('Fee listed title')}>
            {t('Fee listed', { maker: fmtPct(listed.maker, { signed: false }), taker: fmtPct(listed.taker, { signed: false }) })}
          </span>
        ) : null}
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
        {signedIn && market.open && sellOff ? <p className="dk-note">{t('Market sell off')}</p> : null}
        {signedIn && market.open && exitOff ? <p className="dk-note">{t('Bracket sell off', { asset: market.base })}</p> : null}
        {market.open && hasExits(type) && !exitOff ? (
          <p className="dk-note-small">
            {type === 'oco'
              ? side === 'buy'
                ? t('Exit note oco buy', { asset: market.base })
                : t('Exit note oco', { asset: market.base })
              : tif === 'GTC'
                ? t('Exit note bracket resting', { asset: market.base })
                : t('Exit note bracket', { asset: market.base })}
          </p>
        ) : null}
        {exitRetry ? (
          <div className="dk-note dk-note--bad" role="alert">
            <RefusalNote failure={refusalFailure('trade.bracket_exit_failed', context)} />
            <button type="button" className="dk-link" disabled={busy} onClick={() => void placeExits()}>
              {t('Place the exits')}
            </button>
          </div>
        ) : null}
        {gate.reason === 'short' ? <RefusalNote failure={refusalFailure('ledger.insufficient_funds', context)} /> : null}
        {tradable && showProblem && !checked.ok ? <p className="dk-note">{problemText(checked.problem, market, t)}</p> : null}
        {tradable && checked.ok && live.state === 'checking' && !failure && !status ? (
          <p className="dk-note">{t('Checking the order')}</p>
        ) : null}
        {tradable && checked.ok && live.state === 'blocked' ? <RefusalNote failure={live.failure} /> : null}
        {tradable && checked.ok && live.state === 'error' ? <RefusalNote failure={{ kind: 'network' }} onRetry={retry} /> : null}
        {failure ? <RefusalNote failure={failure} onDismiss={() => setFailure(null)} /> : null}
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
            <ReviewRows market={market} review={review} side={side} />
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

function ReviewRows({ market, review, side }: { market: DeskMarket; review: { draft: Draft; preview: Preview }; side: Side }) {
  const { t } = deskCopy.useCopy();
  const { draft, preview } = review;
  const limit = draft.type !== 'market';
  const stop = draft.type === 'stop_limit';
  const exit = draft.exit ?? null;
  const value = limit && draft.price ? orderValue({ side, type: 'limit', price: draft.price, amount: draft.amount }, null) : null;
  const rate = preview.feeBps === null ? null : fmtPct(bpsToRatio(preview.feeBps), { signed: false });
  return (
    <dl className="dk-review-rows">
      <div>
        <dt>{t('Review market')}</dt>
        <dd>{market.symbol}</dd>
      </div>
      <div>
        <dt>{t('Review type')}</dt>
        <dd>
          {exit
            ? exit.kind === 'oco'
              ? t('Order type oco')
              : t('Order type bracket')
            : stop
              ? t('Order type stopLimit')
              : limit
                ? t('Order type limit')
                : t('Order type market')}
        </dd>
      </div>
      <div>
        <dt>{t('Review time in force')}</dt>
        <dd>{t(tifLabelKey(draft.type, tifOfDraft(draft)))}</dd>
      </div>
      {stop && draft.stopPrice ? (
        <div>
          <dt>{t('Review stop price')}</dt>
          <dd className="if-num">
            {fmtPrice(draft.stopPrice, market.tickSize)} {market.quote}
          </dd>
        </div>
      ) : null}
      {exit?.kind === 'oco' ? null : (
        <div>
          <dt>{exit ? t('Entry price') : t('Review price')}</dt>
          <dd className="if-num">
            {limit && draft.price ? `${fmtPrice(draft.price, market.tickSize)} ${market.quote}` : t('Review market price')}
          </dd>
        </div>
      )}
      {exit ? (
        <>
          <div>
            <dt>{t('Review take profit')}</dt>
            <dd className="if-num">
              {fmtPrice(exit.takeProfit, market.tickSize)} {market.quote}
            </dd>
          </div>
          <div>
            <dt>{t('Review stop loss')}</dt>
            <dd className="if-num">
              {fmtPrice(exit.stopLoss, market.tickSize)} {market.quote}
            </dd>
          </div>
          {exit.stopLossLimit ? (
            <div>
              <dt>{t('Review stop loss limit')}</dt>
              <dd className="if-num">
                {fmtPrice(exit.stopLossLimit, market.tickSize)} {market.quote}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t('Review exit note label')}</dt>
            <dd>
              {exit.kind === 'oco'
                ? draft.side === 'buy'
                  ? t('Review exit note oco buy', { asset: market.base })
                  : t('Review exit note oco', { asset: market.base })
                : draft.type === 'limit' && draft.timeInForce === 'GTC'
                  ? t('Review exit note bracket resting', { asset: market.base })
                  : t('Review exit note bracket', { asset: market.base })}
            </dd>
          </div>
        </>
      ) : null}
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
          {rate ? ` (${t('Review fee rate', { rate })})` : ''}
        </dd>
      </div>
      {exitFeeLines(preview).map((line) => (
        <div key={line.leg}>
          <dt>{line.leg === 'takeProfit' ? t('Review take profit fee') : t('Review stop loss fee')}</dt>
          <dd className="if-num">
            {fmtAmount(line.fee, { places: 8 })} {line.asset} ({t('Review fee rate', { rate: fmtPct(line.ratio, { signed: false }) })})
          </dd>
        </div>
      ))}
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
  /** Best bid and ask of the book; null while there is no book. Stable between updates that change nothing. */
  reference: Reference | null;
  /** The book snapshot is recent enough to price against (BBO). */
  referenceFresh: boolean;
  balances: Loadable<Record<string, BalanceEntry>>;
  suggestion: BookPick | null;
  focusSide: Side | null;
  /** Called after an order was sent (placed, or outcome unknown) so the lists refresh. */
  onPlaced: () => void;
}

/** Centre bottom (UI-SPEC 5.7): Limit / Market tabs and the Buy and Sell forms side by side. */
export const OrderPanel = memo(function OrderPanel({
  market,
  reference,
  referenceFresh,
  balances,
  suggestion,
  focusSide,
  onPlaced,
}: PanelProps) {
  const { t } = deskCopy.useCopy();
  const { userId, api: client } = useSession();
  const api = useDeskApi();
  const refresh = useRefreshPrivate();
  const [type, setType] = useState<OrderType>('limit');
  const [pickedTif, setTif] = useState<Tif>('GTC');
  // Market orders take only what an immediate order can use; a limit-only pick (post only, IOC) falls back to standard.
  const tif = tifFor(type, pickedTif);
  const pending = usePendingOrder(userId);
  const [settled, setSettled] = useState<string | null>(null);
  const [stillChecking, setStillChecking] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const lastSuggestion = useRef(0);
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const resendingRef = useRef(false);
  const env = useDataEnv();
  const attempts = useRef(0);

  // A book click means a limit order at that price.
  useEffect(() => {
    if (suggestion && suggestion.nonce !== lastSuggestion.current) {
      lastSuggestion.current = suggestion.nonce;
      setType('limit');
    }
  }, [suggestion]);

  const signedIn = userId !== null;
  const free = (asset: string): string | null => (balances.status === 'ready' ? (balances.data[asset]?.free ?? '0') : null);

  const pendingValue: Pending | null = pending.state === 'pending' ? pending.value : null;
  const blocked = pending.state !== 'none';

  async function check() {
    if (!pendingValue || pendingValue.kind !== 'place' || !userId || checkingRef.current || isInFlight(pendingValue.id)) return;
    checkingRef.current = true;
    setChecking(true);
    env.poller.recordExternalRequest(2);
    const result = await api.reconcile(pendingValue.id, pendingValue.symbol);
    if (result.ok && !result.data.recoveryRequired) {
      attempts.current = 0;
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
    } else {
      attempts.current += 1;
      setStillChecking(true);
    }
    checkingRef.current = false;
    setChecking(false);
  }
  const checkRef = useRef(check);
  checkRef.current = check;
  const pendingId = pendingValue?.id;
  useEffect(() => {
    if (!pendingId || pendingValue?.kind !== 'place') return;
    // First look at once, then 5, 10, 20, then every 60 seconds, so a lost order does not keep the desk over its budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      await checkRef.current();
      if (stopped) return;
      const wait = [5_000, 10_000, 20_000][Math.max(0, attempts.current - 1)] ?? 60_000;
      timer = setTimeout(() => void loop(), wait);
    };
    void loop();
    const stop = onCheckRequested(() => void checkRef.current());
    return () => {
      stopped = true;
      clearTimeout(timer);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  /** On the person's click only: the same order, the same clientOrderId. The trade service never makes two of it. */
  async function sendAgain() {
    if (!pendingValue?.draft || !userId || resendingRef.current || checkingRef.current || isInFlight(pendingValue.id)) return;
    resendingRef.current = true;
    setResending(true);
    setResendNote(null);
    const sending = pendingValue.draft;
    env.poller.recordExternalRequest();
    markInFlight(sending.clientOrderId);
    let result: Awaited<ReturnType<typeof resendOrder>>;
    try {
      result = await resendOrder(client, sending);
    } finally {
      unmarkInFlight(sending.clientOrderId);
    }
    if (result.ok) {
      release(userId, sending.clientOrderId);
      setStillChecking(false);
      setSettled(t('Resent ok', { status: t(`Order status ${result.order.status}` as 'Order status open') }));
      refresh();
      onPlaced();
    } else if (scaleLockStays(resendOutcome(result))) {
      setResendNote(t('Resent unsure'));
      requestCheck();
    } else if (result.reason === 'refused' && result.code === CONFLICT_CODE) {
      setResendNote(t('Resent unsure'));
    } else {
      // The service said no, so nothing was placed. The marker can go.
      release(userId, sending.clientOrderId);
      setResendNote(t('Resent not sent'));
    }
    resendingRef.current = false;
    setResending(false);
  }

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
    tif,
  } as const;
  return (
    <Tabs
      value={type}
      onValueChange={(value) => {
        setType(value as OrderType);
        // A bracket entry resolves at once unless the trader picks "Rest on the book": resting is never the default.
        if (value === 'bracket') setTif('IOC');
      }}
      className="dk-panel dk-order"
    >
      <div className="dk-order-head">
        <TabsList className="dk-tabs" aria-label={t('Order type')}>
          <TabsTab value="limit">{t('Limit')}</TabsTab>
          <TabsTab value="stop_limit">{t('Order type stopLimit')}</TabsTab>
          <TabsTab value="oco">{t('Order type oco')}</TabsTab>
          <TabsTab value="bracket">{t('Order type bracket')}</TabsTab>
          <TabsTab value="market">{t('Market')}</TabsTab>
        </TabsList>
        <MoreOrderTypes />
        {market.open ? <TifSelect type={type} tif={tif} onTif={setTif} /> : null}
      </div>
      {!market.open ? (
        <div className="dk-order-body">
          <StateBlock kind="refused" title={t('Market closed title')} body={t('Market closed body')} />
        </div>
      ) : (
        <TabsPanel value={type} className="dk-order-body">
          {pending.state === 'pending' && !isInFlight(pending.value.id) ? (
            <div className="dk-note dk-note--warn" role="status">
              <p className="dk-note-title">{t('Checking your order')}</p>
              <p>{t('Checking your order body')}</p>
              {pending.value.kind === 'place' ? (
                <div className="dk-note-actions">
                  <button type="button" className="dk-link" disabled={checking || resending} onClick={() => void check()}>
                    {t('Check order')}
                  </button>
                  {pending.value.draft ? (
                    <button type="button" className="dk-link" disabled={checking || resending} onClick={() => void sendAgain()}>
                      {resending ? t('Sending again') : t('Send again')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <p>{t('Other request open')}</p>
              )}
              {pending.value.kind === 'place' && pending.value.draft ? <p className="dk-note-small">{t('Send again hint')}</p> : null}
              {resendNote ? <p role="status">{resendNote}</p> : null}
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
});
