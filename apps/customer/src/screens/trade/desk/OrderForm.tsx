import { memo, useId, useMemo, useRef, useState } from 'react';
import { useMounted, useTimeout } from '../../../shared/outside';
import { useBackoffPoll } from '../../../shared/backoff-poll';
import { useResource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import type { BalanceEntry } from '../../../data/derive';
import { useDataEnv } from '../../../data/hooks';
import { useSession } from '../../../features/session/session';
import { TradingHoldReason } from '../../../features/account/TradingHoldReason';
import { usePreferences } from '../../../shared/preferences';
import { fitsPlaces } from '../../../features/account/trading-settings';
import { draftSchema, isStopType, type Draft, type Preview, type TradeApi } from '../../../features/trade/trade-api';
import { useLeadMode } from '../../../features/trade/lead-mode';
import type { BookPick } from './OrderBook';
import { deskCopy } from './copy';
import { useDeskApi, useFeeToken, useMyFees, useOpenOrders, useRefreshPrivate } from './data';
import { feeTokenChoice, type FeeTokenChoice } from './fee-token';
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
import { SPOT_TICKET_ORDER_TYPES } from '@intafaced/contracts/spot-order-types';
import { MoreOrderTypes, SelfTradeSelect, TagField, TifSelect } from './OrderOptions';
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
  isStopTab,
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
import { bpsToRatio, exitFeeLines, feeRate, gateSubmit, holdShort, rebateRate, sizeFor } from './form-logic';
import { CONFLICT_CODE, resendOrder, resendOutcome } from './resend';
import { clearOrdersPaused, markOrdersPaused } from './orders-paused';
import { scaleLockStays } from './ticket/scale-flow';
import { TicketRules } from './MarketRules';
import { failureOf, isLedgerFrozen, previewFailure, previewIsOrderable, refusalFailure, type Failure } from './preview';
import { placesOf } from './text';
import { dayTime } from './time';
import { problemText } from './problem-text';
import { draftOf } from './draft-of';
import { reviewIdFor } from './review-id';
import { expiryIsFuture, expiryOf, outcomeOf, tifLabelKey, tifOfDraft, tifFor, TYPE_TAB_KEY, type Tif } from './tif';
import { DateInput } from '@intafaced/ui/lit';

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

/** A shut session says when it opens, and that nothing waits for it (J-cex-spot-14 #6). */
function SessionShut({ market }: { market: DeskMarket }) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <StateBlock
      kind="refused"
      title={t('Session shut title')}
      body={market.opensAt != null ? t('Session shut body opens', { time: dayTime(market.opensAt, timeZone) }) : t('Session shut body')}
    />
  );
}

function RefusalNote({ failure, onRetry, onDismiss }: { failure: Failure; onRetry?: () => void; onDismiss?: () => void }) {
  const { t } = deskCopy.useCopy();
  if (failure.kind === 'network')
    return (
      <div data-testid="dk-note--bad" className="dk-note dk-note--bad" role="alert">
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
    <div data-testid="dk-note--bad" className="dk-note dk-note--bad" role="alert">
      {onDismiss ? (
        <button type="button" className="dk-dismiss" aria-label={t('Dismiss')} onClick={onDismiss}>
          ×
        </button>
      ) : null}
      <p className="dk-note-title">{title}</p>
      <p>{body}</p>
      {failure.tradingHold ? <TradingHoldReason /> : null}
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
  /** The expiry a good-till-date pick carries (UTC ISO), or null while none valid is picked. Unused by other picks. */
  expireAt: string | null;
  /** The person's own label for the order, trimmed; null when none. */
  tag: string | null;
  /** A listed lead's Lead trade switch (J-copy-bots-otc-04 #5); undefined for everyone who is not a lead. */
  lead: boolean | undefined;
  onPlaced: () => void;
}

/**
 * A listed lead's Lead trade switch (J-copy-bots-otc-04 #5): on, the order is a lead trade that followers copy once it
 * fills; off, it is the lead's own order and is never copied.
 */
function LeadSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const { t } = deskCopy.useCopy();
  const noteId = useId();
  // The switch is named "Lead trade"; what it does is its description, outside the label.
  return (
    <div className="dk-tif">
      <label>
        <input type="checkbox" role="switch" checked={on} aria-describedby={noteId} onChange={(event) => onChange(event.target.checked)} />
        <span className="lt-hint lt-nowrap">{t('Lead trade')}</span>
      </label>
      <span id={noteId} className="dk-note-small">
        {on ? t('Lead trade on') : t('Lead trade off')}
      </span>
    </div>
  );
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
  expireAt,
  tag,
  lead,
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
  const preferences = usePreferences();
  const [amount, setAmount] = useState('');
  const [totalEdit, setTotalEdit] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // The id of the resting order that "Your order is in" is about; and whether the open list has shown it.
  const [restingId, setRestingId] = useState<string | null>(null);
  const [restingSeen, setRestingSeen] = useState(false);
  const openOrders = useOpenOrders();
  const myFees = useMyFees();
  const feeToken = useFeeToken();
  // The person's choice to pay fees in the platform token. Sent only while the choice is offered for this order.
  const [payInToken, setPayInToken] = useState(false);
  const [review, setReview] = useState<{ draft: Draft; preview: Preview; changed: boolean } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useMounted();
  const spendAsset = side === 'buy' ? market.quote : market.base;
  const amountPlaces = placesOf(market.lotSize);
  const pricePlaces = placesOf(market.tickSize);

  const context = useMemo(
    () => ({
      asset: spendAsset,
      available: available === null ? undefined : fmtAmount(available, { places: 8 }),
      pair: market.symbol.replace('/', '-'),
    }),
    [spendAsset, available, market.symbol],
  );

  // "Your order is in" is news for a moment, not a permanent fact: it would still be on screen after the order is cancelled (critic L5).
  useTimeout(() => setStatus(null), status === null ? null : 12_000, status);

  // ...and it goes the moment that order leaves Open orders (cancelled or filled), so it never sits beside "No open orders".
  // Read during render: whether the open list (once loaded) holds that order.
  const restingListed =
    restingId === null || (openOrders.status !== 'ready' && openOrders.status !== 'empty')
      ? null
      : (openOrders.status === 'ready' ? openOrders.data : []).some((order) => order.id === restingId);
  if (restingListed === true && !restingSeen) setRestingSeen(true);
  else if (restingListed === false && restingSeen) {
    setStatus(null);
    setRestingId(null);
    setRestingSeen(false);
  }

  // A click whose review this ticket opens itself once the order check of the clicked draft answers: Flatten (Assets), or a
  // DOM ladder or chart Buy/Sell (J-charts-desk-14). Any other edit of the form drops it. `type`: the ticket type the
  // click picked; the review waits while the ticket shows another. `instant` (J-charts-desk-14 #6 and #7): instant
  // placement is on, so it sends once the check allows it, without the review sheet; a refusal still stops it.
  const [clickReview, setClickReview] = useState<{ kind: 'flatten' | 'review'; type: OrderType; instant: boolean } | null>(null);
  const edit = (apply: () => void) => {
    if (busyRef.current) return;
    setClickReview(null);
    apply();
    setReview(null);
    setFailure(null);
    setStatus(null);
    setHint(null);
  };

  // A click from the book, the trades list, the DOM ladder, a chart Buy/Sell or Flatten reaches this ticket as a new
  // `suggestion` (its nonce). It is taken during render, once per click, the first render included, as the click's own
  // render reaches this ticket; `undefined` until the first render has looked, so a click already there at mount is taken.
  // - Flatten (Assets): the sell form takes every free lot as a market sell and opens its review once the order check
  //   allows it. The review number comes from the order itself, so pressing Flatten again for the same amount is the same
  //   order, never a second one.
  // - A DOM ladder or chart Buy/Sell click: this side's ticket takes the price and amount and opens its own review once the
  //   order check allows it. It is the desk's own review and confirm, so the order holds exactly as one typed here, and
  //   nothing is sent until the person confirms (or, with instant placement, until the check allows it).
  // - A book or trades-list click fills the price (and the cumulative amount with Shift).
  // A click that opens a review asks the order check again (`recheck`), so the review is judged by the check of the
  // clicked draft, never by an answer about the draft before it.
  const clickNonce = suggestion?.nonce ?? null;
  const [takenNonce, setTakenNonce] = useState<number | null | undefined>(undefined);
  const takingClick = takenNonce !== clickNonce;
  let recheck = false;
  if (takingClick) {
    setTakenNonce(clickNonce);
    if (suggestion?.flatten) {
      if (side === 'sell')
        edit(() => {
          setTotalEdit(null);
          const lots = floorToLot(suggestion.amount, market.lotSize);
          setAmount(lots ?? '');
          // Less than one lot is nothing to sell: no review is opened for it.
          if (lots !== null) {
            setClickReview({ kind: 'flatten', type: 'market', instant: suggestion.instant === true });
            recheck = true;
          }
        });
    } else if (suggestion?.review) {
      if (suggestion.side !== side) setClickReview(null);
      else
        edit(() => {
          if (suggestion.price) setPrice(padDecimals(suggestion.price, pricePlaces));
          setTotalEdit(null);
          const lots = suggestion.amount ? floorToLot(suggestion.amount, market.lotSize) : null;
          setAmount(lots ?? '');
          if (lots !== null) {
            setClickReview({ kind: 'review', type: suggestion.type ?? 'limit', instant: suggestion.instant === true });
            recheck = true;
          }
        });
    } else if (suggestion)
      edit(() => {
        setPrice(padDecimals(suggestion.price, pricePlaces));
        setTotalEdit(null);
        if (suggestion.amount) {
          const lots = floorToLot(suggestion.amount, market.lotSize);
          if (lots) setAmount(lots);
        }
      });
  }

  const input = { side, type, price, amount, stopPrice, stopLimit, takeProfit, tif };
  const priced = isPriced(type);
  const checked = checkOrder(input, market, reference);
  const value = orderValue(input, reference);
  const exitOff = exitSideOff(side, type);
  const held = blocked || exitRetry !== null;
  const tradable = signedIn && market.open && !held && !exitOff;

  // Advisory preview from the server, only for an order the client rules accept.
  const draft: Draft | null = useMemo(() => {
    if (!tradable || !checked.ok || (tif === 'GTD' && expireAt === null)) return null;
    // The tag does not price the order: it joins only the reviewed and sent draft, so typing it never re-checks.
    return draftOf({ market, side, type, tif, expireAt, checked, clientOrderId: 'desk-preview', lead });
  }, [
    tradable,
    checked.ok,
    checked.ok ? checked.amount : '',
    checked.ok ? checked.price : '',
    checked.ok ? (checked.stopPrice ?? '') : '',
    checked.ok ? (checked.exit?.takeProfit ?? '') : '',
    checked.ok ? (checked.exit?.stopLoss ?? '') : '',
    checked.ok ? (checked.exit?.stopLossLimit ?? '') : '',
    checked.ok ? (checked.close ?? '') : '',
    market.symbol,
    side,
    type,
    tif,
    expireAt,
  ]);
  const key = draft
    ? `${draft.symbol}|${draft.side}|${draft.type}|${draft.amount}|${draft.price ?? ''}|${draft.stopPrice ?? ''}|${tif}|${draft.expireAt ?? ''}`
    : 'none';
  const checkedDraft = draft && !review ? draft : null;
  // Each answer of the order check is seen here as it lands, so a click's review starts from the answer about its draft.
  const settled = useRef<(asked: Draft, result: ApiResult<Preview>) => void>(() => undefined);
  const liveApi: TradeApi = useMemo(
    () => ({
      ...api,
      preview: async (asked: Draft) => {
        const result = await api.preview(asked);
        settled.current(asked, result);
        return result;
      },
    }),
    [api],
  );
  const { live, retry } = useLivePreview(liveApi, checkedDraft, key, context, () => env.poller.recordExternalRequest(), market.tickSize);
  if (recheck) retry();
  // The asset the fee comes out of: the order check's own answer once it has one, else the asset the order receives.
  const receiveAsset = (live.state === 'ok' ? live.preview.feeAsset : null) ?? (side === 'buy' ? market.base : market.quote);
  const tokenChoice = feeTokenChoice(feeToken, receiveAsset, type, signedIn);
  const feeCurrency = payInToken && tokenChoice.kind === 'offered' ? tokenChoice.token : null;

  // A market buy is held at the service's price protection (best ask plus the slippage cap), so Max is sized from it.
  // It is learnt from the order check, or from one small probe check on the Market tab; never guessed.
  const marketBuy = side === 'buy' && serviceType(type, price) === 'market';
  const [protection, setProtection] = useState<{ price: string; ask: string } | null>(null);
  const bestAsk = reference?.bestAsk ?? null;
  const liveProtection = live.state === 'ok' ? live.preview.protectionPrice : null;
  // Learnt from the order check during render: a new protection price, or a new ask beside it, is kept at once.
  const [protectionSeen, setProtectionSeen] = useState<{ marketBuy: boolean; price: string | null; ask: string | null }>({
    marketBuy: false,
    price: null,
    ask: null,
  });
  if (protectionSeen.marketBuy !== marketBuy || protectionSeen.price !== liveProtection || protectionSeen.ask !== bestAsk) {
    setProtectionSeen({ marketBuy, price: liveProtection, ask: bestAsk });
    if (marketBuy && liveProtection && bestAsk) setProtection({ price: liveProtection, ask: bestAsk });
  }
  // The probe is asked once per ticket, the first time a market buy has no protection price yet; its answer is kept even
  // after leaving the market buy. `probeAsk` holds the ask and amount it was asked with, so its key never changes again.
  const [probeAsk, setProbeAsk] = useState<{ ask: string; amount: string } | null>(null);
  if (probeAsk === null && marketBuy && protection === null && !liveProtection && tradable && bestAsk) {
    const probe = probeAmount(market, bestAsk);
    if (probe) setProbeAsk({ ask: bestAsk, amount: probe });
  }
  const { resource: probed } = useResource<string | null>(
    async () => {
      if (probeAsk === null) return { ok: true, data: null };
      env.poller.recordExternalRequest();
      const result = await api.preview({
        symbol: market.symbol,
        side: 'buy',
        type: 'market',
        amount: probeAsk.amount,
        timeInForce: 'GTC',
        postOnly: false,
        clientOrderId: 'desk-preview',
      });
      return result.ok ? { ok: true, data: result.data.protectionPrice ?? null } : result;
    },
    probeAsk === null ? 'no-probe' : 'probe',
  );
  // Its answer is kept once, as it lands; a later order check's protection price replaces it as before.
  const probedPrice = probeAsk !== null && probed.status === 'ready' ? probed.data : null;
  const [probeKept, setProbeKept] = useState(false);
  if (probedPrice && probeAsk && !probeKept) {
    setProbeKept(true);
    setProtection({ price: probedPrice, ask: probeAsk.ask });
  }
  const protectionPrice = marketBuy ? protectionNow(protection?.price ?? null, protection?.ask ?? null, bestAsk) : null;
  const max = maxAmount({ side, type, price, available, market, protectionPrice, stopLimit });
  const spendTyped = useRef(false);
  // A typed spend stays a cap while the ask moves: re-size the amount from the current protection price. Leaving a market buy drops it.
  // Kept in step during render, each time the market buy, its protection price, the typed spend or the lot changes.
  const [spendSized, setSpendSized] = useState<{ marketBuy: boolean; price: string | null; spend: string | null; lot: string } | null>(
    null,
  );
  if (
    spendSized === null ||
    spendSized.marketBuy !== marketBuy ||
    spendSized.price !== protectionPrice ||
    spendSized.spend !== totalEdit ||
    spendSized.lot !== market.lotSize
  ) {
    setSpendSized({ marketBuy, price: protectionPrice, spend: totalEdit, lot: market.lotSize });
    if (totalEdit !== null) {
      if (!marketBuy) {
        if (spendTyped.current) setTotalEdit(null);
      } else if (protectionPrice !== null) setAmount(amountForValue(totalEdit, protectionPrice, market.lotSize) ?? '');
    }
  }
  const short = live.state === 'ok' && holdShort(live.preview, spendAsset, available);
  const gateArgs = { signedIn, marketOpen: market.open, pending: held, side, type, checkedOk: checked.ok, busy };
  const gate = gateSubmit({ ...gateArgs, live: live.state, short });
  const canSend = gate.canSend && (tif !== 'GTD' || expireAt !== null);

  // Whether the ticket can send with a given answer of the order check: the same gate as the button's, with that answer.
  const canSendWith = (preview: Preview) =>
    gateSubmit({ ...gateArgs, live: 'ok', short: holdShort(preview, spendAsset, available) }).canSend &&
    (tif !== 'GTD' || expireAt !== null);

  // A click's review is dropped once the ticket on its type no longer holds an order to check.
  if (!takingClick && clickReview?.kind === 'review' && type === clickReview.type && (!tradable || !checked.ok)) setClickReview(null);

  // The order check of the clicked draft answered: open the click's review if the ticket can send with that answer, or drop
  // it when the check refused or failed. An answer about another draft (the form changed since) is not about this click.
  settled.current = (asked, result) => {
    const wanted = clickReview;
    if (!mounted.current || wanted === null || type !== wanted.type || asked !== checkedDraft) return;
    if (result.ok && previewIsOrderable(result.data)) {
      if (!canSendWith(result.data)) return;
      setClickReview(null);
      void startReview(wanted.instant, true);
    } else setClickReview(null);
  };

  /**
   * The review of the ticket's order. `instant` (instant placement on, J-charts-desk-14 #6 and #7): the same preview, and
   * when it is orderable the same confirm runs at once with it instead of opening the sheet. A refusal or a short balance
   * shows exactly as it would in the review. `ready`: whether the ticket can send, from the button's gate, or (a click's
   * review) from the gate with the order check's answer that has just landed.
   */
  async function startReview(instant = false, ready = canSend) {
    if (!ready || busyRef.current || !checked.ok) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setStatus(null);
    // The number is given once per draft: a repeat review of the same order keeps it, so a send that was lost cannot become a second order.
    const { clientOrderId: _unnumbered, ...body } = draftOf({
      market,
      side,
      type,
      tif,
      expireAt,
      tag,
      feeCurrency,
      checked,
      clientOrderId: '',
      lead,
    });
    const fresh = { ...body, clientOrderId: reviewIdFor(userId ?? '', body) };
    const parsed = draftSchema.safeParse(fresh);
    if (!parsed.success) setFailure({ kind: 'network' });
    else {
      env.poller.recordExternalRequest();
      const result = await api.preview(parsed.data);
      if (!mounted.current) return;
      if (!result.ok) setFailure(failureOf(result, context));
      else if (previewIsOrderable(result.data) && holdShort(result.data, spendAsset, available))
        setFailure(refusalFailure('ledger.insufficient_funds', context));
      else if (previewIsOrderable(result.data)) {
        const reviewed = { draft: parsed.data, preview: result.data, changed: false };
        if (instant) {
          setBusy(false);
          busyRef.current = false;
          await confirm(reviewed);
          return;
        }
        setReview(reviewed);
      } else setFailure(previewFailure(result.data, context, market.tickSize));
    }
    setBusy(false);
    busyRef.current = false;
  }

  /** Send the reviewed order: the open review, or (instant placement) the one `startReview` just checked. */
  async function confirm(given?: { draft: Draft; preview: Preview; changed: boolean }) {
    const current = given ?? review;
    if (!current || busyRef.current || !userId) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const { draft: sending, preview } = current;
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
        setRestingSeen(false);
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
          if (preferences.resetSizeOnSubmit) {
            setAmount('');
            setTotalEdit(null);
          }
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
          setFailure(previewFailure(result.preview, context, market.tickSize));
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
        if (preferences.resetSizeOnSubmit) {
          setAmount('');
          setTotalEdit(null);
        }
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
  const mine = myFees.status === 'ready' ? (myFees.data[market.symbol] ?? null) : null;

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
      data-testid="dk-form"
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
      {isStopTab(type) ? stopInput(t('Stop price')) : null}
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
          label={type === 'oco' ? t('Take profit') : type === 'oto' ? t('Entry price') : t('Price')}
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
          aria-label={type === 'oco' ? t('Take profit') : type === 'oto' ? t('Entry price') : t('Price')}
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
      {type === 'bracket' || type === 'oto' ? (
        <AmountInput
          label={type === 'oto' ? t('Close price') : t('Take profit')}
          value={takeProfit}
          onValueChange={(next) => edit(() => setTakeProfit(next))}
          precision={pricePlaces}
          placeholder={fmtPrice('0', market.tickSize)}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quote}
          stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
          aria-label={type === 'oto' ? t('Close price') : t('Take profit')}
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
      {preferences.quickSizes.length > 0 ? (
        <div className="dk-percents" role="group" aria-label={t('Quick sizes')}>
          {preferences.quickSizes.map((size) => (
            <button
              key={size}
              type="button"
              disabled={!fitsPlaces(size, amountPlaces)}
              aria-label={t('Quick size', { size, asset: market.base })}
              onClick={() => edit(() => (setAmount(size), setTotalEdit(null)))}
            >
              {size}
            </button>
          ))}
        </div>
      ) : null}
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
      <dl data-testid="dk-avail" className="dk-avail">
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
      <p data-testid="dk-fees" className="dk-fees if-num">
        <span>
          {live.state === 'ok' && feeRate(live.preview) !== null
            ? live.preview.feeRole === 'maker'
              ? rebateRate(live.preview) !== null
                ? t('Rebate maker', { rate: fmtPct(rebateRate(live.preview)!, { signed: false }) })
                : t('Fee maker', { rate: fmtPct(feeRate(live.preview)!, { signed: false }) })
              : priced && tif === 'GTC'
                ? rebateRate(live.preview, true) !== null
                  ? t('Fee up to rebate', {
                      rate: fmtPct(feeRate(live.preview)!, { signed: false }),
                      rebate: fmtPct(rebateRate(live.preview, true)!, { signed: false }),
                    })
                  : t('Fee up to', { rate: fmtPct(feeRate(live.preview)!, { signed: false }) })
                : t('Fee taker', { rate: fmtPct(feeRate(live.preview)!, { signed: false }) })
            : t('Fee unknown')}
        </span>
        {mine ? (
          <span data-testid="dk-fees-mine" className="dk-fees-mine" title={t('Fee yours title')}>
            {t('Fee yours', { maker: fmtPct(mine.maker, { signed: false }), taker: fmtPct(mine.taker, { signed: false }) })}
          </span>
        ) : null}
      </p>
      <FeeCurrencyRow side={side} receiveAsset={receiveAsset} choice={tokenChoice} chosen={feeCurrency !== null} onChoose={setPayInToken} />
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
        {hint ? <p className="lt-hint">{hint}</p> : null}
        {signedIn && !market.open ? <p className="lt-hint">{t('Market is closed')}</p> : null}
        {signedIn && market.open && exitOff ? (
          <p className="lt-hint">{t(type === 'oto' ? 'Oto sell off' : 'Bracket sell off', { asset: market.base })}</p>
        ) : null}
        {market.open && type === 'oto' && !exitOff ? <p className="dk-note-small">{t('Exit note oto', { asset: market.base })}</p> : null}
        {market.open && type === 'stop_market' ? (
          <p className="dk-note-small">
            {side === 'buy' ? t('Stop market note buy', { asset: market.base }) : t('Stop market note sell', { asset: market.base })}
          </p>
        ) : null}
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
          <div data-testid="dk-note--bad" className="dk-note dk-note--bad" role="alert">
            <RefusalNote failure={refusalFailure('trade.bracket_exit_failed', context)} />
            <button type="button" className="dk-link" disabled={busy} onClick={() => void placeExits()}>
              {t('Place the exits')}
            </button>
          </div>
        ) : null}
        {gate.reason === 'short' ? <RefusalNote failure={refusalFailure('ledger.insufficient_funds', context)} /> : null}
        {tradable && showProblem && !checked.ok ? <p className="lt-hint">{problemText(checked.problem, market, t)}</p> : null}
        {tradable && checked.ok && live.state === 'checking' && !failure && !status ? (
          <p className="lt-hint">{t('Checking the order')}</p>
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
            <ReviewRows market={market} review={review} side={side} tokenChoice={tokenChoice} />
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

/**
 * The asset the fee comes out of, and the platform token when the owner publishes its terms (fee-token.ts). Offered: a
 * toggle that says the stake discount and the published ladder. Not offered: the same control, aria-disabled, with its
 * reason, and nothing is sent (the service refuses the token on that order too).
 */
function FeeCurrencyRow({
  side,
  receiveAsset,
  choice,
  chosen,
  onChoose,
}: {
  side: Side;
  receiveAsset: string;
  choice: FeeTokenChoice;
  chosen: boolean;
  onChoose: (on: boolean) => void;
}) {
  const { t } = deskCopy.useCopy();
  const why = `dk-fee-asset-why-${side}`;
  if (choice.kind === 'offered') {
    const discount = fmtPct(bpsToRatio(choice.discountBps), { signed: false });
    return (
      <div className="dk-fee-asset" data-fee-currency={chosen ? choice.token : receiveAsset} data-fee-token="offered">
        <span>{t('Fees in', { asset: chosen ? choice.token : receiveAsset })}</span>
        <button
          type="button"
          className="dk-fee-asset-choice"
          aria-pressed={chosen}
          aria-describedby={why}
          onClick={() => onChoose(!chosen)}
        >
          {t('Pay fees in token', { token: choice.token })}
        </button>
        <span id={why} className="dk-fee-asset-why">
          {chosen
            ? t('Fee token on', { token: choice.token, discount, staked: fmtAmount(choice.staked, { places: 8 }), asset: receiveAsset })
            : t('Fee token offer', { token: choice.token, discount })}
          {choice.ladder && choice.ladder.length > 0 ? (
            <span className="dk-fee-ladder" data-fee-ladder>
              {' '}
              {t('Fee token ladder', {
                steps: choice.ladder
                  .map((step) =>
                    t('Fee token step', {
                      stake: fmtAmount(step.minStake, { places: 8 }),
                      token: choice.token,
                      discount: fmtPct(bpsToRatio(step.discountBps), { signed: false }),
                    }),
                  )
                  .join(', '),
              })}
            </span>
          ) : null}
        </span>
      </div>
    );
  }
  const reason =
    choice.reason === 'no_terms'
      ? t('Fee currency reason', { asset: receiveAsset })
      : choice.reason === 'received'
        ? t('Fee token received', { token: choice.token ?? receiveAsset })
        : choice.reason === 'no_price'
          ? t('Fee token no price', { token: choice.token ?? '', asset: receiveAsset })
          : choice.reason === 'signed_out'
            ? t('Fee token signed out', { token: choice.token ?? '', asset: receiveAsset })
            : choice.reason === 'order_type'
              ? t('Fee token order type', { token: choice.token ?? '', asset: receiveAsset })
              : t('Fee token no discount', { token: choice.token ?? '', asset: receiveAsset });
  return (
    <div className="dk-fee-asset" data-fee-currency={receiveAsset} data-fee-token={choice.reason}>
      <span>{t('Fees in', { asset: receiveAsset })}</span>
      {/* aria-disabled, not disabled: it stays in the tab order, so a keyboard or screen-reader user reaches the reason. */}
      <button
        type="button"
        className="dk-fee-asset-choice"
        aria-disabled="true"
        aria-describedby={why}
        onClick={(event) => event.preventDefault()}
      >
        {choice.token ? t('Pay fees in token', { token: choice.token }) : t('Pay fees in another asset')}
      </button>
      <span id={why} className="dk-fee-asset-why">
        {reason}
      </span>
    </div>
  );
}

function ReviewRows({
  market,
  review,
  side,
  tokenChoice,
}: {
  market: DeskMarket;
  review: { draft: Draft; preview: Preview };
  side: Side;
  tokenChoice: FeeTokenChoice;
}) {
  const { t } = deskCopy.useCopy();
  const { draft, preview } = review;
  const limit = draft.type !== 'market';
  const stop = isStopType(draft.type);
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
            : draft.close
              ? t('Order type oto')
              : stop
                ? t(draft.type === 'stop' ? 'Order type stopMarket' : 'Order type stopLimit')
                : limit
                  ? t('Order type limit')
                  : t('Order type market')}
        </dd>
      </div>
      <div>
        <dt>{t('Review time in force')}</dt>
        <dd>{t(tifLabelKey(draft.type === 'stop' ? 'stop_market' : draft.type, tifOfDraft(draft)))}</dd>
      </div>
      {draft.expireAt ? (
        <div>
          <dt>{t('Order expires')}</dt>
          <dd className="if-num">{new Date(draft.expireAt).toLocaleString()}</dd>
        </div>
      ) : null}
      {stop && draft.stopPrice ? (
        <div>
          <dt>{t('Review stop price')}</dt>
          <dd className="if-num">
            {fmtPrice(draft.stopPrice, market.tickSize)} {market.quote}
          </dd>
        </div>
      ) : null}
      {draft.type === 'stop' && preview.price ? (
        <div>
          <dt>{t('Review protection price')}</dt>
          <dd className="if-num">
            {fmtPrice(preview.price, market.tickSize)} {market.quote}
          </dd>
        </div>
      ) : null}
      {exit?.kind === 'oco' || draft.type === 'stop' ? null : (
        <div>
          <dt>{exit || draft.close ? t('Entry price') : t('Review price')}</dt>
          <dd className="if-num">
            {limit && draft.price ? `${fmtPrice(draft.price, market.tickSize)} ${market.quote}` : t('Review market price')}
          </dd>
        </div>
      )}
      {draft.close ? (
        <>
          <div>
            <dt>{t('Review close price')}</dt>
            <dd className="if-num">
              {fmtPrice(draft.close, market.tickSize)} {market.quote}
            </dd>
          </div>
          <div>
            <dt>{t('Review exit note label')}</dt>
            <dd>{t('Review exit note oto', { asset: market.base })}</dd>
          </div>
        </>
      ) : null}
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
      {draft.feeCurrency ? (
        <div data-review-fee-currency={draft.feeCurrency}>
          <dt>{t('Review fee currency')}</dt>
          <dd>
            {t('Review fee token', {
              token: draft.feeCurrency,
              discount: tokenChoice.kind === 'offered' ? fmtPct(bpsToRatio(tokenChoice.discountBps), { signed: false }) : '—',
              asset: preview.feeAsset ?? '',
            })}
          </dd>
        </div>
      ) : null}
      {preview.feeRole ? (
        <div>
          <dt>{t('Review fee role')}</dt>
          <dd>
            {preview.feeRole === 'maker'
              ? t('Review fee role maker')
              : // Taker is the server's worst case for an order that can rest (as the fee line's "up to" says): only an
                // order that never rests is surely a taker.
                draft.type === 'market' || tifOfDraft(draft) === 'IOC' || tifOfDraft(draft) === 'FOK'
                ? t('Review fee role taker')
                : t('Review fee role either')}
          </dd>
        </div>
      ) : null}
      {draft.stpMode ? (
        <div>
          <dt>{t('Review self trade')}</dt>
          <dd>{t('Self trade cancel maker')}</dd>
        </div>
      ) : null}
      {draft.tag ? (
        <div>
          <dt>{t('Review tag')}</dt>
          <dd>{draft.tag}</dd>
        </div>
      ) : null}
      <div>
        <dt>{t('Review client id')}</dt>
        <dd>
          {/* The end of the client order id (draft hash and mint); the rest is the account, which the person knows. */}
          <span data-testid="client-order-id" className="if-num">
            {draft.clientOrderId.split(':').at(-1)}
          </span>
          <br />
          {t('Review client id note')}
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
  // A good-till-date pick carries the expiry the trader types (local time); it is sent only once it names a future instant.
  const [expiry, setExpiry] = useState('');
  const expireAt = tif === 'GTD' && expiryIsFuture(expiry, Date.now()) ? expiryOf(expiry) : null;
  // The person's own label, kept for the next orders until they clear it; blank sends none.
  const [tagText, setTagText] = useState('');
  const tag = tagText.trim() === '' ? null : tagText.trim();
  // A listed lead's Lead trade switch (J-copy-bots-otc-04 #5): on when the lead account's link opened the desk.
  const leadMode = useLeadMode();
  const [leadOn, setLeadOn] = useState(() => new URLSearchParams(window.location.search).get('lead') === '1');
  const lead = leadMode.isLead ? leadOn : undefined;
  const pending = usePendingOrder(userId);
  const [settled, setSettled] = useState<string | null>(null);
  const [stillChecking, setStillChecking] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const resendingRef = useRef(false);
  const env = useDataEnv();
  const attempts = useRef(0);

  // A book click means a limit order at that price; Flatten means a market sell. Taken during render, once per click, so
  // the side forms see the click and its ticket type in the same render.
  const [typedNonce, setTypedNonce] = useState(0);
  if (suggestion && suggestion.nonce !== typedNonce) {
    setTypedNonce(suggestion.nonce);
    setType(suggestion.type ?? (suggestion.flatten ? 'market' : 'limit'));
  }

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
  const pendingId = pendingValue?.id;
  // A lost order's status check: first look at once, then 5, 10, 20, then every 60 seconds after each check ends, so a lost
  // order does not keep the desk over its budget; a check asked for elsewhere (requestCheck) runs at once as well.
  useBackoffPoll(
    pendingId && pendingValue?.kind === 'place' ? pendingId : null,
    check,
    () => [5_000, 10_000, 20_000][Math.max(0, attempts.current - 1)] ?? 60_000,
    onCheckRequested,
  );

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
    expireAt,
    tag,
    lead,
  } as const;
  return (
    <Tabs
      value={type}
      onValueChange={(value) => {
        setType(value as OrderType);
        // A bracket entry resolves at once unless the trader picks "Rest on the book": resting is never the default.
        if (value === 'bracket') setTif('IOC');
        // An OTO buy waits on the book for its price by default; its close is placed when it fills.
        if (value === 'oto') setTif('GTC');
      }}
      data-testid="dk-order"
      className="dk-panel dk-order"
    >
      <div className="dk-order-head">
        <TabsList className="dk-tabs" aria-label={t('Order type')}>
          {SPOT_TICKET_ORDER_TYPES.map((kind) => (
            <TabsTab key={kind} value={kind}>
              {t(TYPE_TAB_KEY[kind])}
            </TabsTab>
          ))}
        </TabsList>
        <MoreOrderTypes />
        {market.open ? <TifSelect type={type} tif={tif} onTif={setTif} /> : null}
        {market.open && tif === 'GTD' ? (
          <label className="dk-tif dk-expiry">
            <span className="lt-hint lt-nowrap">{t('Order expires')}</span>
            <DateInput
              type="datetime-local"
              className="dk-expiry-input"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              aria-label={t('Order expires')}
              aria-invalid={expiry !== '' && expireAt === null}
            />
            {expiry !== '' && expireAt === null ? (
              <span className="dk-expiry-note" role="note">
                {t('Order expiry past')}
              </span>
            ) : null}
          </label>
        ) : null}
      </div>
      {market.open ? (
        <div className="dk-order-opts">
          <SelfTradeSelect />
          <TagField value={tagText} onChange={setTagText} />
          {leadMode.isLead ? <LeadSwitch on={leadOn} onChange={setLeadOn} /> : null}
        </div>
      ) : null}
      <TicketRules market={market} />
      {!market.open ? (
        <div className="dk-order-body">
          {market.sessionShut ? (
            <SessionShut market={market} />
          ) : (
            <StateBlock kind="refused" title={t('Market closed title')} body={t('Market closed body')} />
          )}
        </div>
      ) : (
        <TabsPanel value={type} className="dk-order-body">
          {pending.state === 'pending' && !isInFlight(pending.value.id) ? (
            <div data-testid="dk-note--warn" className="dk-note dk-note--warn" role="status">
              <p className="dk-note-title">{t('Checking your order')}</p>
              <p>{t('Checking your order body')}</p>
              {pending.value.kind === 'place' ? (
                <div className="lt-actions">
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
            <div data-testid="dk-note--warn" className="dk-note dk-note--warn" role="status">
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
