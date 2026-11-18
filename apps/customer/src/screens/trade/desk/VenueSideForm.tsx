import { useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { displayAmount, parseAmount } from '../../../shared/money';
import {
  keys,
  type AsOf,
  type OrderIntent,
  type VenueMarket,
  type VenuePreview,
  type VenueTimeInForce,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  OutcomeLine,
  outcomeText,
  keepsDraft,
  useVenueActions,
  useVenueApi,
  type ActionResult,
  type VenueAccount,
} from '../../../features/trade/venue/VenueKit';
import { builderApproved, carriesBuilderFee } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { deskCopy } from './copy';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
} from './deps';
import { placesOf } from './text';
import { spotVenueCopy } from './venue-copy';
import { UnitFlag } from './VenueOrderOptions';
import {
  HeldDraft,
  amountForValue,
  tagProblem,
  valueOf,
  venueSelfTrade,
  draftSignature,
  intentOf,
  lockShortfall,
  previewMoved,
  refusedAtHeldWorst,
  ticketProblem,
  unpublishedRules,
  type TicketFields,
  type VenueOrderType,
  type VenueSide,
} from './venue-desk';
import type { Access } from './venue-access';
import { VenueReviewRows } from './VenueReviewRows';
import { VerifyNote } from './VenueVerifyDesk';

/** What a ticket is asked to hold by the DOM, the chart or one-click close (J-charts-desk-14). */
export interface TicketPick {
  type: VenueOrderType;
  /** A limit's price; '' for a market order. */
  price: string;
  amount: string;
  /** A market order's worst price under the owner's protection, or null. */
  worst: string | null;
  /** Instant placement is on: a limit is checked and sent at once, with no review. */
  instant: boolean;
}

/** How the desk fills one side's ticket from elsewhere on the page. */
export interface TicketHandle {
  flatten: (amount: string, worst: string | null) => void;
  pick: (pick: TicketPick) => void;
}

type Live =
  | { signature: string; state: 'checking' }
  | { signature: string; state: 'ok'; preview: AsOf<VenuePreview> }
  | {
      signature: string;
      state: 'refused';
      message: string;
      code?: string;
    };

/** J-cex-spot-10 #3: the venue door refuses before preparing anything while our builder fee is blank. */
const BUILDER_FEE_BLANK = 'trade.venue.builder_fee_not_published';

/** How long the ticket waits after the last keystroke before it asks the venue for its preview. */
const PREVIEW_DEBOUNCE_MS = 250;

/** One side's ticket; its order key is held while the order is unchanged, so a reopened review names the same order. */
export function VenueSideForm({
  side,
  type,
  tif,
  protectionBps,
  market,
  status,
  owner,
  access,
  account,
  worst,
  capSet,
  run,
  onPlaced,
  waiting,
  settledKeys,
  handle,
}: {
  side: VenueSide;
  type: VenueOrderType;
  /** A limit order's time in force, picked once for both tickets. */
  tif: VenueTimeInForce;
  /** The owner's market price protection in bps, or null when blank. */
  protectionBps: string | null;
  market: VenueMarket;
  status: VenueUp;
  owner: string | null;
  access: Access;
  account: VenueAccount;
  worst: string | null;
  capSet: boolean;
  run: ReturnType<typeof useVenueActions>['run'];
  onPlaced: (intent: OrderIntent, answer: ActionResult, tag: string) => void;
  /** An earlier order has no definite answer yet: no new order is sent until the venue names it. */
  waiting: boolean;
  settledKeys: readonly string[];
  /** Flatten (J-cex-spot-05 #8): the sell ticket registers here how it types all the free base in and opens its review. */
  handle?: Ref<TicketHandle>;
}) {
  const { t } = spotVenueCopy.useCopy();
  const d = deskCopy.useCopy().t;
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  // The unit flag: the person types the size in the base asset (Amount) or in the quote asset (Total, or Spend on a
  // market buy); the other field follows. A typed value is dropped when the order type changes (J-cex-spot-03 #1, #9).
  const [unit, setUnit] = useState<'base' | 'quote'>('base');
  const [value, setValue] = useState('');
  const [tag, setTag] = useState('');
  const [sent, setSent] = useState<OrderIntent | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [review, setReview] = useState<{ intent: OrderIntent; preview: AsOf<VenuePreview> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const [approving, setApproving] = useState<ActionResult | null>(null);
  const [moved, setMoved] = useState(false);
  const [reviewProblem, setReviewProblem] = useState<string | null>(null);

  /** A sell that carries our builder fee, with no approval on the venue: the wallet signs the approval first. */
  async function approve() {
    if (!status.builder || sending.current) return;
    sending.current = true;
    const answer = await run(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      { actionKey: keys.builderApproval(owner ?? '', status.builder.address, status.builder.feeBps) },
    );
    sending.current = false;
    setApproving(answer);
    account.reload();
  }
  const draft = useMemo(() => (owner ? new HeldDraft(owner, market.symbol) : null), [owner, market.symbol]);
  // A key the venue has since named is let go before this render holds one (settle only drops a key still held).
  for (const key of settledKeys) draft?.settle(key);
  const [typed, setTyped] = useState(type);
  if (typed !== type) {
    // The order type changed: a typed spend or total is dropped, never carried into the next kind of order.
    setTyped(type);
    setValue('');
  }
  // The price a value is sized at: a limit's own price, or a market order's worst price (so a buy's lock stays within it).
  const sizedAt = type === 'limit' ? price.trim() || null : worst;
  const sizedAmount = unit === 'quote' ? (amountForValue(value, sizedAt, market.lotSize) ?? '') : amount;
  const fields: TicketFields = { side, type, price, amount: sizedAmount, tif };
  const issue = ticketProblem(fields, market, worst, capSet);
  // A market order's worst price is held with its key (HeldDraft.hold): the intent sent under one key never changes.
  const held = draft && issue === null ? draft.hold(fields, worst) : null;
  const intent = held ? intentOf(fields, market, held.worst, held.key, capSet) : null;
  const shownWorst = type === 'market' ? (intent?.price ?? worst) : null;
  const signature = intent ? `${draftSignature(fields)}|${intent.price}|${intent.clientOrderKey}` : null;

  // The venue's preview as the order is typed: one ask per settled order, the latest answer kept.
  useEffect(() => {
    if (!owner || !intent || !signature) {
      setLive(null);
      return;
    }
    setLive({ signature, state: 'checking' });
    let gone = false;
    const timer = setTimeout(() => {
      void venue.preview(owner, intent).then((answer) => {
        if (gone) return;
        setLive(
          answer.ok
            ? { signature, state: 'ok', preview: answer.data }
            : { signature, state: 'refused', message: answer.message, ...(answer.code ? { code: answer.code } : {}) },
        );
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
    // The signature names every part of the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, signature, venue]);

  const verb = side === 'buy' ? d('Buy asset', { asset: market.baseAsset }) : d('Sell asset', { asset: market.baseAsset });
  // The venue's own figures: what this order locks against what the venue account has free (J-cex-spot-02 #6).
  const balances = account.balances.data?.value ?? null;
  const short = live?.state === 'ok' && live.signature === signature && balances ? lockShortfall(live.preview.value, balances) : null;
  const refusedNow = live?.state === 'refused' && live.signature === signature;
  const tagBad = tagProblem(tag);
  const canSend =
    access === 'verified' && owner !== null && intent !== null && !busy && !waiting && short === null && !refusedNow && !tagBad;
  const amountPlaces = placesOf(market.lotSize);
  const valueLabel = type === 'market' && side === 'buy' ? t('Spend') : t('Total');
  const pricePlaces = placesOf(market.tickSize);

  async function startReview(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || !intent || !owner) return;
    setProblem(null);
    setResult(null);
    const fresh = live && live.signature === signature && live.state === 'ok' ? live.preview : null;
    if (fresh) {
      setMoved(false);
      setReviewProblem(null);
      return setReview({ intent, preview: fresh });
    }
    const answer = await venue.preview(owner, intent);
    if (!answer.ok)
      return setProblem(answer.code === BUILDER_FEE_BLANK ? v('Builder fee owner blank') : t('Not placeable', { detail: answer.message }));
    if (balances && lockShortfall(answer.data.value, balances)) return;
    setMoved(false);
    setReviewProblem(null);
    setReview({ intent, preview: answer.data });
  }

  // Flatten: a market sell of `amount`, typed into this ticket and reviewed at once, under the key the draft holds for it,
  // so every retry of the same flatten sends the same client order id.
  useImperativeHandle(handle, () => ({
    // A ladder click, a chart Buy or Sell or one-click close (J-charts-desk-14): the ticket shows the draft, and it is
    // reviewed, or with instant placement on (a limit only) checked with the venue and sent at once. Either way it is the
    // desk's own venue order: one key held for the draft, so one client order id and one signature however often it is
    // pressed. Nothing is reviewed or sent without a size.
    pick({ type: kind, price: at, amount: size, worst: worstNow, instant }: TicketPick) {
      setUnit('base');
      setValue('');
      setPrice(kind === 'limit' ? at : '');
      setAmount(size);
      setResult(null);
      setProblem(null);
      if (size.trim() === '') return;
      const f: TicketFields = { side, type: kind, price: kind === 'limit' ? at : '', amount: size, tif };
      if (!draft || !owner || access !== 'verified' || waiting || ticketProblem(f, market, worstNow, capSet) !== null) return;
      const hold = draft.hold(f, worstNow);
      const order = intentOf(f, market, hold.worst, hold.key, capSet);
      if (!order) return;
      void (instant && kind === 'limit' ? sendNow(order) : reviewOf(order));
    },
    flatten(all: string, worstNow: string | null) {
      // The ticket shows the same market sell the review holds, so its draft keeps the one key for it.
      setUnit('base');
      setPrice('');
      setAmount(all);
      setResult(null);
      setProblem(null);
      const f: TicketFields = { side, type: 'market', price: '', amount: all, tif };
      if (!draft || !owner || access !== 'verified' || ticketProblem(f, market, worstNow, capSet) !== null) return;
      const hold = draft.hold(f, worstNow);
      const sell = intentOf(f, market, hold.worst, hold.key, capSet);
      if (sell) void reviewOf(sell);
    },
  }));

  async function reviewOf(sell: OrderIntent) {
    if (!owner) return;
    const answer = await venue.preview(owner, sell);
    if (!answer.ok) return setProblem(t('Not placeable', { detail: answer.message }));
    setMoved(false);
    setReviewProblem(null);
    setReview({ intent: sell, preview: answer.data });
  }

  /**
   * Instant placement: the venue checks the order now, as the review would, and only an order it takes that the venue
   * account can pay for goes to the wallet. One that needs a builder approval first opens the review, where it is asked.
   */
  async function sendNow(order: OrderIntent) {
    if (!owner || sending.current) return;
    sending.current = true;
    const now = await venue.preview(owner, order);
    if (!now.ok) {
      sending.current = false;
      setProblem(t('Not placeable', { detail: now.message }));
      return;
    }
    const lacking = balances ? lockShortfall(now.data.value, balances) : null;
    if (lacking) {
      sending.current = false;
      setProblem(t('Not enough free', { asset: lacking.asset, lock: displayAmount(lacking.lock), free: displayAmount(lacking.free) }));
      return;
    }
    if (carriesBuilderFee(now.data.value.builderFee) && builderApproved(account, status) !== true) {
      sending.current = false;
      setMoved(false);
      setReviewProblem(null);
      setReview({ intent: order, preview: now.data });
      return;
    }
    await send(order);
  }

  /** The order goes: the wallet signs it, then the venue answers under the ticket. `sending` is already held. */
  async function send(order: OrderIntent) {
    setReview(null);
    setBusy(true);
    setSent(order);
    const answer = await run(order);
    sending.current = false;
    setBusy(false);
    setResult(answer);
    if (!keepsDraft(answer) || refusedAtHeldWorst(answer)) draft?.settle(order.clientOrderKey);
    onPlaced(order, answer, tag.trim());
  }

  async function confirm() {
    if (!review || sending.current || !owner) return;
    sending.current = true;
    const sent = review.intent;
    // The venue is asked again at Confirm: numbers that moved since the review are shown and asked again, never sent
    // (J-cex-spot-02 #7). A refusal now is said in the review; nothing is signed.
    const now = await venue.preview(owner, sent);
    if (!now.ok) {
      sending.current = false;
      setReviewProblem(t('Not placeable', { detail: now.message }));
      return;
    }
    if (previewMoved(review.preview.value, now.data.value)) {
      sending.current = false;
      setMoved(true);
      setReview({ intent: sent, preview: now.data });
      return;
    }
    // The review closes on Confirm: what follows is the wallet's, then the venue's answer under the ticket.
    await send(sent);
  }

  const edit = (apply: () => void) => {
    apply();
    setResult(null);
    setProblem(null);
  };

  return (
    <form
      data-testid="dk-form"
      className="dk-form"
      data-side={side}
      aria-label={side === 'buy' ? d('Buy form', { asset: market.baseAsset }) : d('Sell form', { asset: market.baseAsset })}
      onSubmit={(event) => void startReview(event)}
    >
      {type === 'limit' ? (
        <AmountInput
          label={d('Price')}
          value={price}
          onValueChange={(next) => edit(() => setPrice(next))}
          precision={pricePlaces}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quoteAsset}
          stepLabels={{ up: d('Price up one step'), down: d('Price down one step') }}
          aria-label={d('Price')}
        />
      ) : (
        <AmountInput
          label={d('Price')}
          value=""
          onValueChange={() => undefined}
          precision={pricePlaces}
          readOnly
          disabled
          unit={market.quoteAsset}
          placeholder={d('Market price word')}
          aria-label={d('Price')}
        />
      )}
      <UnitFlag
        unit={unit}
        base={market.baseAsset}
        quote={market.quoteAsset}
        onUnit={(next) =>
          edit(() => {
            setUnit(next);
            setValue('');
            setAmount('');
          })
        }
      />
      <AmountInput
        label={d('Amount')}
        value={sizedAmount}
        onValueChange={(next) => edit(() => setAmount(next))}
        precision={amountPlaces}
        unit={market.baseAsset}
        placeholder="0"
        readOnly={unit === 'quote'}
        aria-label={d('Amount')}
      />
      <AmountInput
        label={valueLabel}
        value={unit === 'quote' ? value : (valueOf(amount, sizedAt) ?? '')}
        onValueChange={(next) => edit(() => setValue(next))}
        precision={pricePlaces}
        unit={market.quoteAsset}
        placeholder="0"
        readOnly={unit === 'base'}
        aria-label={valueLabel}
      />
      <label className="dk-tif dk-opt">
        <span className="dk-tif-label">{t('Tag label')}</span>
        <input
          type="text"
          className="dk-expiry-input dk-tag-input"
          value={tag}
          maxLength={32}
          onChange={(event) => edit(() => setTag(event.target.value))}
          aria-label={t('Tag label')}
          aria-describedby={`dk-tag-note-${side}`}
        />
        <span className="dk-opt-note" id={`dk-tag-note-${side}`}>
          {t('Tag note')}
        </span>
      </label>
      {shownWorst ? (
        <p className="dk-note-small if-num" data-testid="venue-worst-price">
          {t('Worst price line', { price: displayAmount(shownWorst), quote: market.quoteAsset })}
        </p>
      ) : null}
      <Button
        type="submit"
        variant={side}
        shape="rounded"
        size={40}
        fullWidth
        loading={busy}
        disabled={!canSend}
        aria-describedby={`dk-reason-${side}`}
      >
        {verb}
      </Button>
      <div className="dk-reason" id={`dk-reason-${side}`} aria-live="polite">
        {access === 'verify' ? (
          <VerifyNote />
        ) : access === 'loading' ? (
          <p className="dk-note">{t('Checking verification')}</p>
        ) : access === 'unread' ? (
          <p className="dk-note">{t('Verification unread')}</p>
        ) : issue === 'rule_unpublished' ? (
          <p className="dk-note dk-note--bad" role="alert" data-code="trade.venue_rule_unpublished">
            {t('Rule unpublished', {
              venue: status.venue.displayName,
              symbol: market.symbol,
              rules: unpublishedRules(market)
                .map((rule) => t(rule === 'min' ? 'Rule name min' : rule === 'band' ? 'Rule name band' : 'Rule name cap'))
                .join(', '),
            })}
          </p>
        ) : !owner ? (
          <p className="dk-note">{t('Connect to trade')}</p>
        ) : issue === 'no_cap' && type === 'market' ? (
          <p className="dk-note" data-code={protectionBps !== null ? 'trade.spread_limit_unset' : 'trade.slippage_cap_unset'}>
            {t('No price protection')}
          </p>
        ) : tagBad ? (
          <p className="dk-note dk-note--bad" role="alert">
            {t('Tag bad')}
          </p>
        ) : issue === 'no_book' ? (
          <p className="dk-note">{t('No book side')}</p>
        ) : issue === 'amount_step' && amount ? (
          <p className="dk-note">{t('Not a step', { field: d('Amount'), step: market.lotSize })}</p>
        ) : issue === 'price_step' && price ? (
          <p className="dk-note">{t('Not a step', { field: d('Price'), step: market.tickSize })}</p>
        ) : live?.state === 'checking' ? (
          <p className="dk-note">{t('Checking venue')}</p>
        ) : live?.state === 'refused' ? (
          <p className="dk-note dk-note--bad" role="alert" data-testid="venue-ticket-refused" data-code={live.code ?? ''}>
            {live.code === BUILDER_FEE_BLANK ? v('Builder fee owner blank') : t('Not placeable', { detail: live.message })}
          </p>
        ) : short ? (
          <p className="dk-note dk-note--bad" role="alert" data-testid="venue-ticket-short">
            {t('Not enough free', { asset: short.asset, lock: displayAmount(short.lock), free: displayAmount(short.free) })}
          </p>
        ) : null}
        {busy ? <p className="dk-note">{t('Waiting wallet')}</p> : null}
        {problem ? (
          <p className="dk-note dk-note--bad" role="alert">
            {problem}
          </p>
        ) : null}
        {result?.kind === 'unknown' ? (
          <p className="dk-note" role="status">
            {outcomeText(v, result)}
          </p>
        ) : result ? (
          <OutcomeLine result={result} owner={owner} />
        ) : null}
        {result ? <TicketOutcome result={result} sent={sent} base={market.baseAsset} /> : null}
      </div>
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !sending.current) setReview(null);
        }}
      >
        {review ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{side === 'buy' ? d('Review buy') : d('Review sell')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Review intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            {moved ? (
              <p className="dk-note dk-note--bad" role="alert" data-testid="venue-review-moved">
                {t('Numbers changed')}
              </p>
            ) : null}
            {reviewProblem ? (
              <p className="dk-note dk-note--bad" role="alert" data-testid="venue-review-refused">
                {reviewProblem}
              </p>
            ) : null}
            <VenueReviewRows
              intent={review.intent}
              preview={review.preview}
              status={status}
              approved={builderApproved(account, status)}
              protectionBps={protectionBps}
              selfTrade={venueSelfTrade(market)}
              tag={tag.trim()}
            />
            {carriesBuilderFee(review.preview.value.builderFee) && builderApproved(account, status) === false ? (
              <Button variant="secondary" size={40} onClick={() => void approve()}>
                {v('Approve in wallet')}
              </Button>
            ) : null}
            <OutcomeLine result={approving} owner={owner} />
            <AlertDialogFooter>
              <Button variant="secondary" size={40} onClick={() => setReview(null)}>
                {t('Cancel')}
              </Button>
              <Button
                variant={side}
                shape="pill"
                size={40}
                disabled={carriesBuilderFee(review.preview.value.builderFee) && builderApproved(account, status) !== true}
                onClick={() => void confirm()}
              >
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
 * What the venue's definite answer means for the order just sent (J-cex-spot-03 #4, #6): one that ended at once with
 * nothing filled traded nothing, and the venue released its lock; a post-only order the venue refused was never placed.
 */
function TicketOutcome({ result, sent, base }: { result: ActionResult; sent: OrderIntent | null; base: string }) {
  const { t } = spotVenueCopy.useCopy();
  if (result.kind !== 'outcome' || !sent) return null;
  const o = result.outcome;
  if (!o.accepted) {
    return sent.timeInForce === 'ALO' ? (
      <p className="dk-note" data-testid="venue-ticket-outcome" data-outcome="post-only-refused">
        {t('Post only refused')}
      </p>
    ) : null;
  }
  if (o.order?.status !== 'canceled') return null;
  let filled = 0n;
  try {
    filled = parseAmount(o.order.filled);
  } catch {
    return null;
  }
  return (
    <p className="dk-note" data-testid="venue-ticket-outcome" data-outcome={filled === 0n ? 'nothing-traded' : 'partly-traded'}>
      {filled === 0n ? t('Nothing traded') : t('Partly traded', { filled: displayAmount(o.order.filled), asset: base })}
    </p>
  );
}
