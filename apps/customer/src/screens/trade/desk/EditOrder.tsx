import { useEffect, useRef, useState } from 'react';
import { useDataEnv } from '../../../data/hooks';
import { draftSchema, type Draft, type Order, type Preview } from '../../../features/trade/trade-api';
import { deskCopy } from './copy';
import { useDeskApi } from './data';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
  fmtAmount,
  fmtPrice,
} from './deps';
import type { DeskMarket } from './market';
import { checkOrder, padDecimals, scaled } from './order-math';
import { asReplacement, failureOf, previewFailure, previewIsOrderable } from './preview';
import { problemText } from './problem-text';
import { canEdit } from './order-kind';
import { outcomeOf, orderTag, tifFields, type Tif } from './tif';
import { placesOf } from './text';
import { replaceKey } from './replace-key';

type Note = { tone: 'good' | 'bad'; text: string } | null;

export { canEdit };

/**
 * Change an open limit order. A smaller (or larger) amount at the same price goes through the service's native amend,
 * which keeps the order's place in the queue. A new price is a different thing: the service cancels the order and
 * places a new one (CANCEL_REPLACE), so it is reviewed first, said plainly, and never sent twice.
 */
export function EditOrder({
  order,
  market,
  onDone,
  onClose,
}: {
  order: Order;
  market: DeskMarket;
  /** A change was sent (or may have been): refresh the lists. */
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = deskCopy.useCopy();
  const env = useDataEnv();
  const api = useDeskApi();
  const pricePlaces = placesOf(market.tickSize);
  const amountPlaces = placesOf(market.lotSize);
  const [price, setPrice] = useState(() => padDecimals(order.price ?? '', pricePlaces));
  const [amount, setAmount] = useState(order.remaining);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState<Note>(null);
  const [review, setReview] = useState<{ draft: Draft; preview: Preview; changed: boolean } | null>(null);
  const [finished, setFinished] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const partlyFilled = (scaled(order.filled) ?? 0n) > 0n;
  const context = { asset: market.base, pair: market.symbol.replace('/', '-') };
  const side = order.side;
  const sideWord = side === 'buy' ? t('Order placed side buy') : t('Order placed side sell');

  function close() {
    if (busyRef.current) return;
    onClose();
  }
  function edit(apply: () => void) {
    if (busyRef.current || finished) return;
    apply();
    setNote(null);
    setReview(null);
  }
  const checked = checkOrder({ side, type: 'limit', price, amount }, market, null);
  const priceChanged = checked.ok && scaled(checked.price) !== scaled(order.price);
  const amountChanged = checked.ok && scaled(checked.amount) !== scaled(order.remaining);
  // Only a lower amount is changed here: a higher one would take a new hold that this dialog never shows.
  const amountUp = checked.ok && (scaled(checked.amount) ?? 0n) > (scaled(order.remaining) ?? 0n);

  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const fail = (result: Parameters<typeof failureOf>[0]) => {
    const failure = failureOf(result, context);
    setNote({ tone: 'bad', text: failure.kind === 'refusal' ? `${failure.copy.title}. ${failure.copy.body}` : t('Edit couldn’t check') });
  };

  /** Same price, new amount: native amend. One PATCH per click. */
  const amend = () =>
    run(async () => {
      if (!checked.ok || amountUp) return;
      // The amount sent is the new amount LEFT, so look again first: if part of the order filled while this was open, a
      // lower number than the one on screen could still be a raise.
      env.poller.recordExternalRequest();
      const fresh = await api.order(order);
      if (!mounted.current) return;
      if (!fresh.ok || fresh.data.status !== 'open' || scaled(fresh.data.remaining) !== scaled(order.remaining)) {
        setNote({ tone: 'bad', text: t('Edit changed meanwhile') });
        setFinished(true);
        onDone();
        return;
      }
      env.poller.recordExternalRequest();
      const result = await api.amend(order, checked.amount);
      if (!result.ok) {
        if (result.reason === 'uncertain') setNote({ tone: 'bad', text: t('Edit uncertain') });
        else fail(result);
        setFinished(result.reason === 'uncertain');
        onDone();
        return;
      }
      const done = result.data;
      if (done.accepted) {
        setNote({
          tone: 'good',
          text: t(done.priority === 'lost' ? 'Edit amended lost' : done.priority === 'retained' ? 'Edit amended kept' : 'Edit amended', {
            amount: fmtAmount(done.order.remaining, { places: amountPlaces }),
            asset: market.base,
          }),
        });
      } else {
        setNote({ tone: 'bad', text: refusedAmend(done.code, done.reasonCode, t) });
      }
      setFinished(true);
      onDone();
    });

  /** New price: check the replacement with the service, show it, and wait for the person to confirm. */
  const reviewReplacement = () =>
    run(async () => {
      if (!checked.ok || checked.price === null) return;
      const draft = draftSchema.safeParse({
        symbol: order.symbol,
        side,
        type: 'limit',
        amount: checked.amount,
        price: checked.price,
        ...tifFields(orderTag(order) === 'PO' ? 'PO' : 'GTC'),
        // The same replacement is the same number; a changed price or amount is a different one.
        clientOrderId: replaceKey(order.id, checked.price, checked.amount),
      });
      if (!draft.success) return setNote({ tone: 'bad', text: t('Edit couldn’t check') });
      env.poller.recordExternalRequest();
      const answer = await api.preview(draft.data);
      if (!answer.ok) return fail(answer);
      const preview = { ...answer, data: asReplacement(answer.data) };
      if (!previewIsOrderable(preview.data)) {
        const failure = previewFailure(preview.data, context, market.tickSize);
        return setNote({
          tone: 'bad',
          text: failure.kind === 'refusal' ? `${failure.copy.title}. ${failure.copy.body}` : t('Edit couldn’t check'),
        });
      }
      setReview({ draft: draft.data, preview: preview.data, changed: false });
    });

  const confirmReplacement = () =>
    run(async () => {
      if (!review) return;
      env.poller.recordExternalRequest(2);
      const result = await api.replace(
        order,
        review.draft,
        review.preview,
        (fresh) => mounted.current && previewIsOrderable(asReplacement(fresh)),
      );
      if (result.ok) {
        const done = result.data;
        if (done.accepted && done.replacement) {
          const tif: Tif = orderTag(order) === 'PO' ? 'PO' : 'GTC';
          const outcome = outcomeOf(done.replacement, tif);
          const filled = fmtAmount(done.replacement.filled, { places: amountPlaces });
          const left = fmtAmount(done.replacement.amount, { places: amountPlaces });
          setNote(
            outcome.kind === 'resting'
              ? {
                  tone: 'good',
                  text: t('Edit replaced', {
                    amount: left,
                    asset: market.base,
                    price: fmtPrice(done.replacement.price ?? review.draft.price ?? '', market.tickSize),
                    quote: market.quote,
                  }),
                }
              : outcome.kind === 'filled'
                ? { tone: 'good', text: t('Edit replaced filled', { amount: filled, asset: market.base }) }
                : outcome.kind === 'partCancelled'
                  ? { tone: 'bad', text: t('Edit replaced part', { filled, amount: left, asset: market.base }) }
                  : outcome.kind === 'rejected'
                    ? { tone: 'bad', text: t('Edit replaced rejected') }
                    : { tone: 'bad', text: t('Edit replaced nofill') },
          );
        } else {
          setNote({
            tone: 'bad',
            text: t(
              done.originalState === 'open'
                ? 'Edit not replaced open'
                : done.originalState === 'canceled'
                  ? 'Edit not replaced gone'
                  : 'Edit not replaced unknown',
            ),
          });
        }
        setReview(null);
        setFinished(true);
        onDone();
      } else if (result.reason === 'changed') {
        if (previewIsOrderable(result.preview)) setReview({ draft: review.draft, preview: result.preview, changed: true });
        else {
          setReview(null);
          const failure = previewFailure(result.preview, context, market.tickSize);
          setNote({
            tone: 'bad',
            text: failure.kind === 'refusal' ? `${failure.copy.title}. ${failure.copy.body}` : t('Edit couldn’t check'),
          });
        }
      } else if (result.reason === 'uncertain') {
        setNote({ tone: 'bad', text: t('Edit replace uncertain') });
        setReview(null);
        setFinished(true);
        onDone();
      } else {
        // Refused before anything was sent (the check, or the dialog was closed): the old order is untouched.
        fail(result);
        setReview(null);
      }
    });

  const problem = !checked.ok && (checked.problem.kind !== 'amountEmpty' || amount !== '') ? problemText(checked.problem, market, t) : null;
  const unchanged = checked.ok && !priceChanged && !amountChanged;
  const asset = market.base;
  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialogContent className="dk-review dk-edit">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('Edit order title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('Edit order intro', {
              side: sideWord,
              amount: fmtAmount(order.remaining, { places: amountPlaces }),
              asset,
              price: fmtPrice(order.price ?? '', market.tickSize),
              quote: market.quote,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review ? (
          <dl className="dk-review-rows">
            <div>
              <dt>{t('Review price')}</dt>
              <dd className="if-num">
                {fmtPrice(order.price ?? '', market.tickSize)} → {fmtPrice(review.draft.price ?? '', market.tickSize)} {market.quote}
              </dd>
            </div>
            <div>
              <dt>{t('Review amount')}</dt>
              <dd className="if-num">
                {fmtAmount(review.draft.amount, { places: amountPlaces })} {asset}
              </dd>
            </div>
            <div>
              <dt>{t('Review hold')}</dt>
              <dd className="if-num">
                {fmtAmount(review.preview.holdAmount, { places: 8 })} {review.preview.holdAsset}
              </dd>
            </div>
            <div>
              <dt>{t('Review fee')}</dt>
              <dd className="if-num">
                {fmtAmount(review.preview.estimatedFee, { places: 8 })} {review.preview.feeAsset}
              </dd>
            </div>
          </dl>
        ) : finished ? null : (
          <div className="dk-edit-fields">
            <AmountInput
              label={t('Price')}
              value={price}
              onValueChange={(next) => edit(() => setPrice(next))}
              precision={pricePlaces}
              tick={market.tickSize}
              min={market.tickSize}
              unit={market.quote}
              disabled={partlyFilled}
              stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
              aria-label={t('Price')}
            />
            <AmountInput
              label={t('Edit amount label')}
              value={amount}
              onValueChange={(next) => edit(() => setAmount(next))}
              precision={amountPlaces}
              unit={asset}
              autoFocus
              aria-label={t('Edit amount label')}
            />
            <p className="dk-note dk-edit-help">
              {partlyFilled ? t('Edit price locked') : priceChanged ? t('Edit replace explain') : t('Edit amend explain')}
            </p>
          </div>
        )}
        {review?.changed ? (
          <p data-testid="dk-note--warn" className="dk-note dk-note--warn">
            {t('Review changed')}
          </p>
        ) : null}
        {review ? (
          <p data-testid="dk-note--warn" className="dk-note dk-note--warn">
            {t('Edit replace explain')}
          </p>
        ) : null}
        {problem && !review && !finished ? <p className="dk-note">{problem}</p> : null}
        {amountUp && !review && !finished ? <p className="dk-note">{t('Edit amount too big')}</p> : null}
        {unchanged && !finished ? <p className="dk-note">{t('Edit nothing changed')}</p> : null}
        {note ? (
          <p
            data-testid={note.tone === 'good' ? undefined : 'dk-note--bad'}
            className={note.tone === 'good' ? 'dk-note dk-note--good' : 'dk-note dk-note--bad'}
            role={note.tone === 'good' ? 'status' : 'alert'}
          >
            {note.text}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button variant="secondary" size={40} disabled={busy} onClick={close}>
            {finished ? t('Edit close') : t('Edit keep order')}
          </Button>
          {finished ? null : review ? (
            <Button variant="primary" shape="pill" size={40} loading={busy} onClick={() => void confirmReplacement()}>
              {t('Edit confirm replace')}
            </Button>
          ) : (
            <Button
              variant="primary"
              shape="pill"
              size={40}
              loading={busy}
              disabled={!checked.ok || unchanged || amountUp}
              onClick={() => void (priceChanged ? reviewReplacement() : amend())}
            >
              {priceChanged ? t('Edit review replace') : t('Edit change amount')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Why the service did not change the amount, in words. Unknown codes get the plain "not changed", never the raw code. */
function refusedAmend(code: string, reason: string | null, t: ReturnType<typeof deskCopy.useCopy>['t']): string {
  const why = reason ?? code;
  if (why === 'trade.order_not_open') return t('Edit refused finished');
  if (why === 'trade.hold_uncovered') return t('Edit refused funds');
  if (code === 'CANCEL_REPLACE') return t('Edit refused replace');
  return t('Edit refused');
}
