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
import { placesOf } from './text';
import { replaceKey } from './replace-key';

type Note = { tone: 'good' | 'bad'; text: string } | null;

/**
 * Change the trigger of a stop that has not fired (J-cex-spot-08 #3): its stop price, and a stop-limit's limit price.
 * The amount stays. The service cancels the stop and places a new one with the new trigger (CANCEL_REPLACE), so the
 * replacement is checked with the service, shown, and sent only on the person's confirm, with one order number per
 * replacement so a retry never places a second stop.
 */
export function StopEdit({
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
  const stopMarket = order.type === 'stop';
  const [stop, setStop] = useState(() => padDecimals(order.stopPrice ?? '', pricePlaces));
  const [price, setPrice] = useState(() => padDecimals(order.price ?? '', pricePlaces));
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
  const context = { asset: market.base, pair: market.symbol.replace('/', '-') };
  const side = order.side;
  const kind = stopMarket ? t('Order type stopMarket') : t('Order type stopLimit');
  const amount = order.remaining;

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
  const checked = checkOrder(
    { side, type: stopMarket ? 'stop_market' : 'stop_limit', price: stopMarket ? '' : price, stopPrice: stop, amount },
    market,
    null,
  );
  const stopChanged = checked.ok && scaled(checked.stopPrice) !== scaled(order.stopPrice);
  const priceChanged = checked.ok && !stopMarket && scaled(checked.price) !== scaled(order.price);
  const unchanged = checked.ok && !stopChanged && !priceChanged;

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

  const refusalText = (failure: ReturnType<typeof failureOf>) =>
    failure.kind === 'refusal' ? `${failure.copy.title}. ${failure.copy.body}` : t('Edit couldn’t check');

  const reviewReplacement = () =>
    run(async () => {
      if (!checked.ok || !checked.stopPrice) return;
      const draft = draftSchema.safeParse({
        symbol: order.symbol,
        side,
        type: order.type,
        amount: checked.amount,
        ...(stopMarket || checked.price === null ? {} : { price: checked.price }),
        stopPrice: checked.stopPrice,
        timeInForce: 'GTC',
        postOnly: false,
        // The same new trigger is the same number; a different trigger or limit is a different replacement.
        clientOrderId: replaceKey(order.id, `${checked.stopPrice}|${checked.price ?? ''}`, checked.amount),
      });
      if (!draft.success) return setNote({ tone: 'bad', text: t('Edit couldn’t check') });
      env.poller.recordExternalRequest();
      const answer = await api.preview(draft.data);
      if (!answer.ok) return setNote({ tone: 'bad', text: refusalText(failureOf(answer, context)) });
      const preview = asReplacement(answer.data);
      if (!previewIsOrderable(preview))
        return setNote({ tone: 'bad', text: refusalText(previewFailure(preview, context, market.tickSize)) });
      setReview({ draft: draft.data, preview, changed: false });
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
        if (done.accepted && done.replacement && done.replacement.status === 'open') {
          setNote({
            tone: 'good',
            text: t('Edit stop replaced', {
              kind,
              stop: fmtPrice(done.replacement.stopPrice ?? review.draft.stopPrice ?? '', market.tickSize),
              quote: market.quote,
            }),
          });
        } else if (done.accepted && done.replacement) {
          setNote({ tone: 'bad', text: t('Edit stop replaced ended') });
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
          setNote({ tone: 'bad', text: refusalText(previewFailure(result.preview, context, market.tickSize)) });
        }
      } else if (result.reason === 'uncertain') {
        setNote({ tone: 'bad', text: t('Edit replace uncertain') });
        setReview(null);
        setFinished(true);
        onDone();
      } else {
        // Refused before anything was sent (the check, or the dialog was closed): the stop is untouched.
        setNote({ tone: 'bad', text: refusalText(failureOf(result, context)) });
        setReview(null);
      }
    });

  const problem = !checked.ok ? problemText(checked.problem, market, t) : null;
  const asset = market.base;
  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialogContent className="dk-review dk-edit">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('Edit stop title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('Edit stop intro', {
              side: side === 'buy' ? t('Order placed side buy') : t('Order placed side sell'),
              kind,
              amount: fmtAmount(amount, { places: amountPlaces }),
              asset,
              stop: fmtPrice(order.stopPrice ?? '', market.tickSize),
              quote: market.quote,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review ? (
          <dl className="dk-review-rows">
            <div>
              <dt>{t('Review stop price')}</dt>
              <dd className="if-num">
                {fmtPrice(order.stopPrice ?? '', market.tickSize)} → {fmtPrice(review.draft.stopPrice ?? '', market.tickSize)}{' '}
                {market.quote}
              </dd>
            </div>
            <div>
              <dt>{stopMarket ? t('Review protection price') : t('Review price')}</dt>
              <dd className="if-num">
                {fmtPrice(order.price ?? '', market.tickSize)} → {fmtPrice(review.preview.price ?? '', market.tickSize)} {market.quote}
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
              label={t('Stop price')}
              value={stop}
              onValueChange={(next) => edit(() => setStop(next))}
              precision={pricePlaces}
              tick={market.tickSize}
              min={market.tickSize}
              unit={market.quote}
              autoFocus
              stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
              aria-label={t('Stop price')}
            />
            {stopMarket ? null : (
              <AmountInput
                label={t('Price')}
                value={price}
                onValueChange={(next) => edit(() => setPrice(next))}
                precision={pricePlaces}
                tick={market.tickSize}
                min={market.tickSize}
                unit={market.quote}
                stepLabels={{ up: t('Price up one step'), down: t('Price down one step') }}
                aria-label={t('Price')}
              />
            )}
            <p className="dk-note dk-edit-help">{t('Edit stop explain')}</p>
          </div>
        )}
        {review?.changed ? (
          <p data-testid="dk-note--warn" className="dk-note dk-note--warn">
            {t('Review changed')}
          </p>
        ) : null}
        {review ? (
          <p data-testid="dk-note--warn" className="dk-note dk-note--warn">
            {t('Edit stop explain')}
          </p>
        ) : null}
        {problem && !review && !finished ? <p className="dk-note">{problem}</p> : null}
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
              disabled={!checked.ok || unchanged}
              onClick={() => void reviewReplacement()}
            >
              {t('Edit review replace')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
