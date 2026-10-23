import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { uiCopy } from '../../../shared/ui-copy';
import { navigate } from '../../../app/location';
import { useResource } from '../../../shared/resource';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { PayDetails } from '../components';
import { wasPlacedUnderHeldReference, type PersonalPayApi } from '../pay-api';
import type { Offer, TakeQuote, Trade } from '../schemas';
import { p2pDepth } from './p2p-depth-copy';
import { TraderName, useTraders } from './Trader';
import { P2PEligibilityPanel } from './Eligibility';
import {
  checkTake,
  exceedsAvailable,
  feePercent,
  isOwnOffer,
  offerMethodIds,
  placedNotice,
  takeFailureKind,
  tradeMovedFromQuote,
  takeRequest,
  takerRole,
  type TakeFailure,
  type TakeRequest,
} from './p2p-model';

type CopyT = ReturnType<typeof p2pDepth.useCopy>['t'];

/** The plain sentence for a kind of failure. No service text and no code ever reaches the customer. */
export function takeFailureText(t: CopyT, kind: TakeFailure, context: 'quote' | 'take'): string {
  switch (kind) {
    case 'unconfirmed':
      return t('failUnconfirmed');
    case 'notFound':
      return t('failNotFound');
    case 'termsChanged':
      return t('failTermsChanged');
    case 'quoteChanged':
      return t('failQuoteChanged');
    case 'quoteExpired':
      return t('failQuoteExpired');
    case 'ownOffer':
      return t('failOwnOffer');
    case 'unavailable':
      return t('failUnavailable');
    case 'blocked':
      return t('failBlocked');
    case 'methodRefused':
      return t('failMethodRefused');
    case 'tooSmall':
      return t('failTooSmall');
    case 'outOfBounds':
      return t('failOutOfBounds');
    case 'signIn':
      return t('failSignIn');
    case 'noRecord':
      return t('failNoRecord');
    case 'verify':
      return t('failVerify');
    case 'region':
      return t('failRegion');
    case 'contact':
      return t('failContact');
    case 'risk':
      return t('failRisk');
    case 'unchecked':
      return t('failUnchecked');
    case 'viewChanged':
      return t('failViewChanged');
    case 'noService':
      return t('failNoService');
    case 'generic':
      return context === 'quote' ? t('failQuote') : t('failGeneric');
  }
}

/** A failed attempt, in words. An unconfirmed one is called that: it is never described as refused or unchanged. */
export function TakeFailureNote({ failure, context }: { failure: Extract<ApiResult<unknown>, { ok: false }>; context: 'quote' | 'take' }) {
  const { t } = p2pDepth.useCopy();
  const kind = takeFailureKind(failure);
  return (
    <div
      className="failure"
      role={kind === 'unconfirmed' || kind === 'notFound' ? 'alert' : 'status'}
      data-testid="take-failure"
      data-kind={kind}
    >
      {kind === 'unconfirmed' || kind === 'notFound' ? <h3>{t('failUnconfirmedTitle')}</h3> : null}
      <p>{takeFailureText(t, kind, context)}</p>
      {kind === 'verify' ? (
        <a className="text-link" href="/verification">
          {t('failVerifyLink')}
        </a>
      ) : null}
    </div>
  );
}

/** Every figure the service returned for this take, as the taker sees it. Nothing is computed here. */
export function TakeQuoteDetails({ offer, quote }: { offer: Pick<Offer, 'side' | 'asset' | 'fiatCurrency'>; quote: TakeQuote }) {
  const { t } = p2pDepth.useCopy();
  const buying = takerRole(offer) === 'buyer';
  const fee = t('quoteFeeValue', { fee: displayAmount(quote.fee), asset: offer.asset, percent: feePercent(quote.feeBps) });
  const price = `${displayAmount(quote.price)} ${offer.fiatCurrency} / ${offer.asset}`;
  const quantity = `${displayAmount(quote.amount)} ${offer.asset}`;
  const fiat = `${displayAmount(quote.fiatAmount)} ${offer.fiatCurrency}`;
  const net = `${displayAmount(quote.netAmount)} ${offer.asset}`;
  return (
    <div data-testid="take-quote">
      <PayDetails
        values={
          buying
            ? [
                [t('quoteBuy'), quantity],
                [t('quotePay'), fiat],
                [t('quotePrice'), price],
                [t('quoteFee'), fee],
                [t('quoteReceive'), net],
              ]
            : [
                [t('quoteSell'), quantity],
                [t('quoteReceiveFiat'), fiat],
                [t('quotePrice'), price],
                [t('quoteFeeSeller'), fee],
                [t('quoteBuyerReceives'), net],
              ]
        }
      />
    </div>
  );
}

/** What the seller has available of the asset, from the balance read Money uses. Nothing is shown while it is still loading. */
export function TakeAvailable({ state, asset }: { state: ApiResult<string> | 'loading' | null; asset: string }) {
  const { t } = p2pDepth.useCopy();
  if (state === null || state === 'loading') return null;
  return (
    <p className="muted" data-testid="take-available">
      {state.ok ? t('takeAvailable', { amount: displayAmount(state.data), asset }) : t('takeAvailableOff')}
    </p>
  );
}

/**
 * The order being reviewed: who it is with, the payment method by its name, and every figure the service quoted. The
 * counterparty is the maker as the taker sees them (@handle, or "Member"); never an account id.
 */
export function TakeReviewDetails({
  offer,
  quote,
  methodLabel,
  counterparty,
}: {
  offer: Pick<Offer, 'side' | 'asset' | 'fiatCurrency'>;
  quote: TakeQuote;
  methodLabel: string;
  counterparty: ReactNode;
}) {
  const { t } = p2pDepth.useCopy();
  const buying = takerRole(offer) === 'buyer';
  return (
    <>
      <PayDetails
        values={[
          [t(buying ? 'takeSellerLabel' : 'takeBuyerLabel'), counterparty],
          [t('takeMethod'), methodLabel],
        ]}
      />
      <TakeQuoteDetails offer={offer} quote={quote} />
    </>
  );
}

type QuoteState = { key: string; result: ApiResult<TakeQuote> | 'loading' } | null;

const FIAT_TEXT = /^\d{1,18}(\.\d{1,18})?$/;

const clock = (at: Date) => at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * How long the service holds the reviewed quote, to the second. Once it ends the order cannot be placed from it: the
 * service would refuse `p2p.quote_expired`, so the button is off and a new quote is one click.
 */
export function QuoteCountdown({
  endsAt,
  renewing,
  onRenew,
  now = () => Date.now(),
  children,
}: {
  endsAt: string;
  renewing: boolean;
  onRenew: () => void;
  now?: () => number;
  children: (ended: boolean) => ReactNode;
}) {
  const { t } = p2pDepth.useCopy();
  const end = new Date(endsAt);
  const [left, setLeft] = useState(() => Math.max(0, end.getTime() - now()));
  useEffect(() => {
    setLeft(Math.max(0, end.getTime() - now()));
    const timer = setInterval(() => setLeft(Math.max(0, end.getTime() - now())), 1000);
    return () => clearInterval(timer);
  }, [endsAt]);
  const ended = left <= 0;
  const seconds = Math.ceil(left / 1000);
  return (
    <>
      <div className="p2p-quote-countdown" role="timer" aria-live="off" data-testid="take-quote-countdown" data-ended={ended}>
        {ended ? (
          <p role="status">
            {t('quoteEnded', { time: clock(end) })}{' '}
            <Button type="button" variant="secondary" disabled={renewing} onClick={onRenew} data-testid="take-quote-renew">
              {renewing ? t('quoteLocking') : t('quoteRenew')}
            </Button>
          </p>
        ) : (
          <p className="muted">
            {t('quoteHeld', { left: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, time: clock(end) })}
          </p>
        )}
      </div>
      {children(ended)}
    </>
  );
}

/**
 * Placing an order on someone else's offer. The quantity is checked against the offer's limits, the service quotes the
 * exact fee and net amount, and the order is placed only from a review of those figures. It locks money in escrow, so
 * the order id is chosen and stored first, a lost answer is "check before trying again", and nothing retries by itself.
 * The offer's own maker never gets this form.
 */
export function TakeOfferPanel({ offer, pay, userId }: { offer: Offer; pay: PersonalPayApi; userId: string | null }) {
  const { t, languageFor, directionFor } = p2pDepth.useCopy();
  const own = isOwnOffer(offer, userId);
  const methods = offerMethodIds(offer);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  // A fiat amount the service turns into the coin amount; editing the coin amount clears it.
  const [fiat, setFiat] = useState('');
  const [converted, setConverted] = useState<ApiResult<string> | 'loading' | null>(null);
  const [locking, setLocking] = useState(false);
  const [lockFailure, setLockFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const check = checkTake(offer, amount);
  const journalKey = `${userId}:take:${offer.id.toLowerCase()}`;
  const selling = takerRole(offer) === 'seller';
  const wantsBalance = selling && !own && Boolean(userId);
  const [available, setAvailable] = useState<ApiResult<string> | 'loading' | null>(null);
  // While an earlier take is held its escrow may already have used part of the balance, so the figure can't judge a retry.
  const over =
    wantsBalance && !pay.guard.status(journalKey) && check.kind === 'ok' && available !== null && available !== 'loading' && available.ok
      ? exceedsAvailable(amount, available.data)
      : false;
  // A quantity above what the seller has is refused here, before any quote is asked for.
  const request = over ? ({ ok: false, kind: 'aboveAvailable' } as const) : takeRequest(offer, amount, method);
  const labels = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  const methodLabel = (methodId: string) =>
    (labels.resource.status === 'ready' ? labels.resource.data.find((entry) => entry.methodId === methodId)?.label : undefined) ?? methodId;
  const traders = useTraders(pay, own ? [] : [offer.makerId]);
  const requestKey = request.ok ? `${request.request.offerId}|${request.request.amount}|${request.request.method}` : null;
  const mounted = useRef(true);
  const reviewToken = useRef(0);
  const [, notify] = useState(0);
  const [quote, setQuote] = useState<QuoteState>(null);
  const [quoteRound, setQuoteRound] = useState(0);
  const [review, setReview] = useState<{ token: number; request: TakeRequest; quote: TakeQuote } | null>(null);
  const [busy, setBusy] = useState(false);
  const placedQuotePrice = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<ApiResult<Trade> | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<ApiResult<Trade> | null>(null);
  // An order that exists but should not be opened silently: an earlier one, or one priced differently from the review.
  const [placed, setPlaced] = useState<{ trade: Trade; why: 'earlier' | 'moved' | 'resent' } | null>(null);
  const locked = !own && Boolean(userId) && Boolean(pay.guard.status(journalKey));

  useLayoutEffect(() => {
    mounted.current = true;
    if (userId && !own)
      void pay.guard.restore(journalKey).then(() => {
        if (mounted.current) notify((value) => value + 1);
      });
    return () => {
      mounted.current = false;
      reviewToken.current++;
    };
  }, [pay, journalKey]);

  useEffect(() => {
    if (!wantsBalance) {
      setAvailable(null);
      return;
    }
    const controller = new AbortController();
    setAvailable('loading');
    void pay.availableBalance(offer.asset, controller.signal).then((result) => {
      if (!controller.signal.aborted) setAvailable(result);
    });
    return () => controller.abort();
  }, [pay, offer.asset, wantsBalance]);

  // The quote follows the request: fetched once the quantity and method are valid, a moment after typing stops.
  useEffect(() => {
    if (own || !request.ok || requestKey === null) {
      setQuote(null);
      return;
    }
    const controller = new AbortController();
    const asked = request.request;
    setQuote({ key: requestKey, result: 'loading' });
    const timer = setTimeout(() => {
      void pay.quoteTake(offer, asked, controller.signal).then((result) => {
        if (!controller.signal.aborted) setQuote({ key: requestKey, result });
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestKey, quoteRound, own, pay]);

  // The fiat amount, a moment after typing stops, becomes the coin amount the service works out at this ad's price.
  const conversionMethod = method || methods[0] || '';
  useEffect(() => {
    if (own || !FIAT_TEXT.test(fiat.trim()) || !conversionMethod) {
      setConverted(null);
      return;
    }
    const controller = new AbortController();
    setConverted('loading');
    const timer = setTimeout(() => {
      void pay.coinForFiat(offer, { fiatAmount: fiat.trim(), method: conversionMethod }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setConverted(result);
        if (result.ok) setAmount(result.data);
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fiat, conversionMethod, own, pay]);

  if (own)
    return (
      <section
        className="p2p-take"
        aria-label={t('takeOwnTitle')}
        lang={languageFor('takeOwnTitle')}
        dir={directionFor('takeOwnTitle')}
        data-testid="take-own"
      >
        <h3>{t('takeOwnTitle')}</h3>
        <p className="muted">{t('takeOwnBody')}</p>
      </section>
    );

  const problem =
    check.kind === 'empty'
      ? t('takeNeedAmount')
      : check.kind === 'invalid'
        ? t('takeInvalid')
        : check.kind === 'belowMin'
          ? t('takeBelowMin')
          : check.kind === 'aboveMax'
            ? t('takeAboveMax')
            : check.kind === 'aboveRemaining'
              ? t('takeAboveRemaining')
              : over
                ? t('takeAboveAvailable')
                : null;
  const shown = quote && quote.key === requestKey ? quote.result : null;
  const ready = shown !== null && shown !== 'loading' && shown.ok ? shown.data : null;
  const heldReference = locked ? pay.guard.reference(journalKey) : null;

  const goToOrder = (trade: Trade) => navigate(`/uc/order?tradeId=${encodeURIComponent(trade.id)}`);
  const closeReview = () => {
    reviewToken.current++;
    setReview(null);
    setOutcome(null);
    setLockFailure(null);
  };
  // The review holds the service's figures for the quote's window: the order names this quote, and an ended one refuses.
  async function lockAndReview(asked: TakeRequest) {
    if (locking || busy) return;
    setLocking(true);
    setLockFailure(null);
    const held = await pay.lockQuote(offer, asked);
    if (!mounted.current) return;
    setLocking(false);
    if (!held.ok) {
      setLockFailure(held);
      return;
    }
    setOutcome(null);
    setReview({ token: ++reviewToken.current, request: asked, quote: held.data });
  }
  async function confirm() {
    if (busy || !review || !userId) return;
    const { token } = review;
    setBusy(true);
    setOutcome(null);
    const earlier = pay.guard.reference(journalKey)?.toLowerCase() ?? null;
    const result = await pay.takeOffer(offer, review.request, {
      quote: review.quote,
      current: () => mounted.current && reviewToken.current === token,
    });
    if (!mounted.current) return;
    if (result.ok) {
      // The order exists. Open it, unless it is an older order or is priced differently from the review: say so first.
      // The form stays locked so a second click can't place another.
      const why = placedNotice({
        heldReference: earlier,
        trade: result.data,
        quote: review.quote,
        placedNow: wasPlacedUnderHeldReference(result.data),
      });
      if (!why) {
        goToOrder(result.data);
        return;
      }
      placedQuotePrice.current = review.quote.price;
      closeReview();
      setPlaced({ trade: result.data, why });
      return;
    }
    setBusy(false);
    if (result.reason === 'aborted') {
      notify((value) => value + 1);
      return;
    }
    if (takeFailureKind(result) === 'unconfirmed') {
      // Possibly placed. Leave the review, keep the stored reference, and ask for a check.
      closeReview();
      setOutcome(result);
      notify((value) => value + 1);
      return;
    }
    setOutcome(result);
    notify((value) => value + 1);
  }
  async function checkEarlier() {
    if (checking) return;
    setChecking(true);
    setChecked(null);
    const known = pay.guard.knownProof(journalKey);
    if (known) {
      const cleared = await pay.guard.cleanupKnown(journalKey, () => mounted.current, known);
      if (!mounted.current) return;
      setChecking(false);
      if (!cleared) setChecked({ ok: false, reason: 'not_supported', message: '', code: 'pay.recovery_journal_unavailable' });
      notify((value) => value + 1);
      return;
    }
    const result = await pay.reconcileTake(offer, () => mounted.current);
    if (!mounted.current) return;
    setChecking(false);
    if (result.ok) {
      setPlaced({ trade: result.data, why: 'earlier' });
      return;
    }
    setChecked(result);
    notify((value) => value + 1);
  }

  if (placed)
    return (
      <section
        className="p2p-take"
        aria-label={t('takeTitle')}
        lang={languageFor('takeFound')}
        dir={directionFor('takeFound')}
        data-testid="take-placed"
      >
        <h3>{t('takeTitle')}</h3>
        <div className="failure" role="status" data-why={placed.why}>
          <p>
            {placed.why === 'earlier'
              ? t('takeFound')
              : placed.why === 'resent'
                ? t('takeResent')
                : t('takePriceMoved', {
                    price: displayAmount(placed.trade.price),
                    fiat: offer.fiatCurrency,
                    asset: offer.asset,
                    total: displayAmount(placed.trade.fiatAmount),
                    reviewed: displayAmount(placedQuotePrice.current ?? placed.trade.price),
                  })}
          </p>
          <Button variant="primary" onClick={() => goToOrder(placed.trade)} data-testid="take-open-order">
            {t('takeOpenOrder')}
          </Button>
        </div>
      </section>
    );

  return (
    <section
      className="p2p-take"
      aria-label={t('takeTitle')}
      lang={languageFor('takeTitle')}
      dir={directionFor('takeTitle')}
      data-testid="take-offer"
    >
      <h3>{t('takeTitle')}</h3>
      {locked ? (
        <section className="p2p-reason" role="alert" aria-label={t('takeUnresolvedTitle')} data-testid="take-unresolved">
          <h3>{t('takeUnresolvedTitle')}</h3>
          <p>{t('takeUnresolvedBody')}</p>
          {heldReference ? <PayDetails values={[[t('takeReference'), <span lang="zxx">{heldReference}</span>]]} /> : null}
          {outcome && !outcome.ok && !review ? <TakeFailureNote failure={outcome} context="take" /> : null}
          {checked && !checked.ok ? <TakeFailureNote failure={checked} context="take" /> : null}
          <Button variant="primary" disabled={checking} onClick={() => void checkEarlier()} data-testid="take-check">
            {checking ? t('takeChecking') : t('takeCheck')}
          </Button>
        </section>
      ) : null}
      <P2PEligibilityPanel pay={pay} userId={userId} compact />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && request.ok && !busy) void lockAndReview(request.request);
        }}
        className="form-stack"
        noValidate
      >
        <p className="muted">
          {t('takeLimits', { min: displayAmount(offer.minAmount), max: displayAmount(offer.maxAmount), asset: offer.asset })}
        </p>
        {wantsBalance ? <TakeAvailable state={available} asset={offer.asset} /> : null}
        <label className="field">
          <span>{t('takeAmount', { asset: offer.asset })}</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setFiat('');
              setLockFailure(null);
            }}
            aria-invalid={problem !== null && check.kind !== 'empty'}
          />
          {problem && check.kind !== 'empty' ? <small className="error-text">{problem}</small> : null}
        </label>
        <label className="field">
          <span>{t('takeFiatAmount', { fiat: offer.fiatCurrency })}</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={fiat}
            onChange={(event) => {
              // The coin amount waits for this fiat amount's conversion, so a stale one can't be reviewed meanwhile.
              setFiat(event.target.value);
              setAmount('');
              setLockFailure(null);
            }}
            data-testid="take-fiat-amount"
          />
          <small className="muted">
            {converted === 'loading' ? t('takeFiatConverting', { asset: offer.asset }) : t('takeFiatHint', { asset: offer.asset })}
          </small>
          {converted && converted !== 'loading' && !converted.ok ? <TakeFailureNote failure={converted} context="quote" /> : null}
        </label>
        <label className="field">
          <span>{t('takeMethod')}</span>
          <select
            value={method}
            onChange={(event) => {
              setMethod(event.target.value);
              setLockFailure(null);
            }}
          >
            <option value="">{methods.length ? '—' : t('takeNoMethods')}</option>
            {methods.map((id) => (
              <option key={id} value={id}>
                {methodLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <div className="p2p-quote" aria-live="polite" data-testid="take-quote-area">
          <h4>{t('takeQuoteTitle')}</h4>
          {shown === null ? (
            <p className="muted">{t('takeQuoteNeed')}</p>
          ) : shown === 'loading' ? (
            <p className="muted">{t('takeQuoteLoading')}</p>
          ) : shown.ok ? (
            <>
              <TakeQuoteDetails offer={offer} quote={shown.data} />
              <p className="muted">{t('takeQuoteNote')}</p>
            </>
          ) : (
            <>
              <TakeFailureNote failure={shown} context="quote" />
              <Button type="button" variant="secondary" onClick={() => setQuoteRound((value) => value + 1)}>
                {t('takeQuoteRetry')}
              </Button>
            </>
          )}
        </div>
        {lockFailure && !review ? <TakeFailureNote failure={lockFailure} context="quote" /> : null}
        <Button type="submit" variant="primary" disabled={ready === null || busy || locking} data-testid="take-review">
          {locking ? t('quoteLocking') : t('takeReview')}
        </Button>
      </form>
      {review ? (
        <Dialog
          closeLabel={uiCopy.t('closeDialog')}
          title={t('takeReviewTitle')}
          onClose={() => {
            if (!busy) closeReview();
          }}
        >
          <div className="form-stack" data-testid="take-review-dialog">
            <p className="muted">
              {t(takerRole(offer) === 'buyer' ? 'takeLeadBuy' : 'takeLeadSell', {
                amount: displayAmount(review.quote.amount),
                asset: offer.asset,
              })}
            </p>
            <TakeReviewDetails
              offer={offer}
              quote={review.quote}
              methodLabel={methodLabel(review.request.method)}
              counterparty={<TraderName record={traders[offer.makerId.toLowerCase()] ?? null} />}
            />
            <QuoteCountdown
              endsAt={review.quote.reservationExpiresAt}
              renewing={locking}
              onRenew={() => void lockAndReview(review.request)}
            >
              {(ended) => (
                <>
                  {outcome && !outcome.ok ? <TakeFailureNote failure={outcome} context="take" /> : null}
                  {lockFailure ? <TakeFailureNote failure={lockFailure} context="quote" /> : null}
                  <div className="actions">
                    <Button variant="ghost" disabled={busy} onClick={closeReview}>
                      {t('takeBack')}
                    </Button>
                    <Button variant="primary" disabled={busy || ended} onClick={() => void confirm()} data-testid="take-confirm">
                      {busy ? t('takePlacing') : t('takeConfirm')}
                    </Button>
                  </div>
                </>
              )}
            </QuoteCountdown>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
