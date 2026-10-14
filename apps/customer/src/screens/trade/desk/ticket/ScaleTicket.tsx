import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../../../shared/api';
import { useDataEnv } from '../../../../data/hooks';
import { exactValue, type Draft, type Preview, type TradeApi } from '../../../../features/trade/trade-api';
import { formatAmount, parseAmount } from '../../../../shared/money';
import { deskCopy } from '../copy';
import type { DeskMarket } from '../market';
import { holdShort, bpsToRatio } from '../form-logic';
import { bboPrice, padDecimals, type Reference, type Side } from '../order-math';
import { failureOf, previewRefusalCode, refusalFailure, type Failure } from '../preview';
import { markInFlight, release, requestCheck, reserve, unmarkInFlight } from '../pending';
import { placesOf } from '../text';
import { ticketCopy } from './copy';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Amount,
  AmountInput,
  Button,
  buttonVariants,
  fmtAmount,
  fmtPct,
  fmtPrice,
  refusalCopy,
  SegmentedControl,
} from './deps';
import { itemWord } from './outcome-words';
import { RefusalNote } from './RefusalNote';
import { PostOnlyField, InfoTip } from './TicketOptionsRow';
import { buildDrafts, checkAll, samePreviews, scaleSlotId, sendBatch, totalsOf, type BatchOutcome, type ScaleTotals } from './scale-flow';
import { clearScaleMarker, writeScaleMarker } from './scale-marker';
import { crossingCount, planHold, planScale, SCALE_MIN_ORDERS, type ScaleProblem, type Spread } from './scale-math';
import './ticket.css';

type Words = ReturnType<typeof ticketCopy.useCopy>['t'];

function problemText(problem: ScaleProblem, market: DeskMarket, t: Words): string {
  switch (problem.kind) {
    case 'count':
      return t('Scale problem count', { min: problem.min, max: problem.max });
    case 'priceEmpty':
      return t('Scale problem price');
    case 'priceTick':
      return t('Scale problem tick', { tick: fmtPrice(problem.tick, problem.tick), asset: market.quote });
    case 'samePrice':
      return t('Scale problem same');
    case 'tooNarrow':
      return t('Scale problem narrow', { count: problem.count });
    case 'amountEmpty':
      return t('Scale problem amount');
    case 'amountLot':
      return t('Scale problem lot', { lot: fmtAmount(problem.lot, { places: placesOf(problem.lot) }), asset: market.base });
    case 'tooSmall':
      return t('Scale problem small', {
        count: problem.count,
        lot: fmtAmount(problem.lot, { places: placesOf(problem.lot) }),
        asset: market.base,
      });
    case 'amountMin':
      return t('Scale problem min amount', { min: fmtAmount(problem.min, { places: placesOf(market.lotSize) }), asset: market.base });
    case 'valueMin':
      return t('Scale problem min value', { min: fmtAmount(problem.min, { places: 8 }), asset: market.quote });
  }
}

interface Review {
  drafts: Draft[];
  previews: Preview[];
  totals: ScaleTotals;
  changed: boolean;
  batchId: string;
}

interface Done {
  drafts: Draft[];
  outcome: BatchOutcome;
}

interface FormProps {
  side: Side;
  market: DeskMarket;
  reference: Reference | null;
  referenceFresh: boolean;
  available: string | null;
  signedIn: boolean;
  userId: string | null;
  blocked: boolean;
  api: TradeApi;
  client: ApiClient;
  onPlaced: () => void;
}

function ScaleForm({ side, market, reference, referenceFresh, available, signedIn, userId, blocked, api, client, onPlaced }: FormProps) {
  const { t } = ticketCopy.useCopy();
  const desk = deskCopy.useCopy().t;
  const env = useDataEnv();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [count, setCount] = useState('5');
  const [total, setTotal] = useState('');
  const [spread, setSpread] = useState<Spread>('even');
  const [postOnly, setPostOnly] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const spendAsset = side === 'buy' ? market.quote : market.base;
  const pricePlaces = placesOf(market.tickSize);
  const amountPlaces = placesOf(market.lotSize);
  const context = useMemo(
    () => ({
      asset: spendAsset,
      available: available === null ? undefined : fmtAmount(available, { places: 8 }),
      pair: market.symbol.replace('/', '-'),
    }),
    [spendAsset, available, market.symbol],
  );

  const plan = useMemo(() => planScale({ side, from, to, count, total, spread }, market), [side, from, to, count, total, spread, market]);
  const touched = from !== '' || to !== '' || total !== '';
  const need = plan.ok ? planHold(side, plan) : null;
  const short = need !== null && available !== null && parseAmount(need) > parseAmount(available);
  const tradable = signedIn && market.open && !blocked;
  const canReview = tradable && plan.ok && !short && !busy;

  const edit = (apply: () => void) => {
    if (busyRef.current) return;
    apply();
    setReview(null);
    setDone(null);
    setFailure(null);
  };

  const bbo = bboPrice(side, reference);

  async function startReview() {
    if (!canReview || busyRef.current || !plan.ok) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setDone(null);
    const batchId = crypto.randomUUID();
    const drafts = buildDrafts({ symbol: market.symbol, side, rows: plan.rows, postOnly, batchId });
    let asked = 0;
    setProgress({ done: 0, total: drafts.length });
    const checked = await checkAll(
      api,
      drafts,
      () => {
        asked += 1;
        env.poller.recordExternalRequest();
        if (mounted.current) setProgress({ done: Math.min(asked, drafts.length), total: drafts.length });
      },
      () => mounted.current,
    );
    if (!mounted.current) return;
    setProgress(null);
    if (!checked.ok) {
      setFailure(checked.failure ? failureOf(checked.failure, context) : refusalFailure(previewRefusalCode(checked.preview!), context));
    } else {
      const totals = totalsOf(checked.previews);
      if (!totals) setFailure({ kind: 'network' });
      else if (totals.holdAsset === spendAsset && available !== null && parseAmount(totals.hold) > parseAmount(available))
        setFailure(refusalFailure('ledger.insufficient_funds', context));
      else setReview({ drafts, previews: checked.previews, totals, changed: false, batchId });
    }
    setBusy(false);
    busyRef.current = false;
  }

  async function confirm() {
    if (!review || busyRef.current || !userId) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const sending = review;

    // 1. Ask again, right before sending, exactly as a single order does. Different numbers mean the person has not
    //    reviewed what would be sent: show the new numbers and send nothing.
    let asked = 0;
    setProgress({ done: 0, total: sending.drafts.length });
    const fresh = await checkAll(
      api,
      sending.drafts,
      () => {
        asked += 1;
        env.poller.recordExternalRequest();
        if (mounted.current) setProgress({ done: Math.min(asked, sending.drafts.length), total: sending.drafts.length });
      },
      () => mounted.current,
    );
    if (!mounted.current) return;
    setProgress(null);
    const stop = (next: Failure) => {
      setReview(null);
      setFailure(next);
      setBusy(false);
      busyRef.current = false;
    };
    if (!fresh.ok)
      return stop(fresh.failure ? failureOf(fresh.failure, context) : refusalFailure(previewRefusalCode(fresh.preview!), context));
    const totals = totalsOf(fresh.previews);
    if (!totals) return stop({ kind: 'network' });
    if (totals.holdAsset === spendAsset && available !== null && parseAmount(totals.hold) > parseAmount(available))
      return stop(refusalFailure('ledger.insufficient_funds', context));
    if (!samePreviews(sending.previews, fresh.previews)) {
      setReview({ ...sending, previews: fresh.previews, totals, changed: true });
      setBusy(false);
      busyRef.current = false;
      return;
    }

    // 2. Take the account's one order slot, then save the exact orders, BEFORE anything is sent.
    const slot = scaleSlotId(sending.batchId);
    const startedAt = Date.now();
    // Marked as "being sent by this tab" from the moment the slot is taken, so the recovery view never looks up a batch that is
    // still on its way.
    markInFlight(slot);
    const reservation = await reserve(userId, { kind: 'place', symbol: market.symbol, id: slot, startedAt });
    if (reservation !== 'reserved') {
      unmarkInFlight(slot);
      return stop({
        kind: 'refusal',
        copy: {
          title:
            reservation === 'other-tab'
              ? desk('Another tab')
              : reservation === 'no-locks'
                ? desk('No tab lock')
                : reservation === 'no-storage'
                  ? desk('No storage')
                  : desk('Unreadable marker'),
          body: desk('Not sent'),
        },
      });
    }
    if (!writeScaleMarker(userId, { batchId: sending.batchId, symbol: market.symbol, startedAt, drafts: sending.drafts })) {
      release(userId, slot);
      unmarkInFlight(slot);
      return stop({ kind: 'refusal', copy: { title: desk('No storage'), body: desk('Not sent') } });
    }

    // 3. One POST, no retry. Whatever is doubtful afterwards is looked up by its own number, never sent again by itself.
    env.poller.recordExternalRequest(2);
    let outcome: BatchOutcome;
    try {
      outcome = await sendBatch(client, sending.drafts);
      const unsure = outcome.items
        .map((item, i) => (item.kind === 'unknown' ? sending.drafts[i]! : null))
        .filter((d): d is Draft => d !== null);
      if (unsure.length === 0) {
        release(userId, slot);
        clearScaleMarker(userId);
      } else {
        // Keep the slot; the marker now lists only the orders still in doubt.
        writeScaleMarker(userId, { batchId: sending.batchId, symbol: market.symbol, startedAt, drafts: unsure });
      }
    } finally {
      unmarkInFlight(slot);
    }
    if (outcome.items.some((item) => item.kind === 'unknown')) requestCheck();
    onPlaced();
    if (mounted.current) {
      setReview(null);
      setDone({ drafts: sending.drafts, outcome });
      if (outcome.items.some((item) => item.kind === 'placed')) setTotal('');
      setBusy(false);
    }
    busyRef.current = false;
  }

  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  const crossing = plan.ok ? crossingCount(side, plan.rows, reference) : 0;
  const verb = side === 'buy' ? t('Scale review button buy') : t('Scale review button sell');
  const spreadTip = spread === 'even' ? t('Tip even') : t('Tip weighted');

  return (
    <form
      className="dk-form tk-scale"
      data-side={side}
      aria-label={side === 'buy' ? t('Scale buy form', { asset: market.base }) : t('Scale sell form', { asset: market.base })}
      onSubmit={(event) => {
        event.preventDefault();
        void startReview();
      }}
    >
      <AmountInput
        label={t('First price')}
        aria-label={t('First price')}
        value={from}
        onValueChange={(next) => edit(() => setFrom(next))}
        precision={pricePlaces}
        placeholder={fmtPrice('0', market.tickSize)}
        tick={market.tickSize}
        min={market.tickSize}
        unit={market.quote}
        stepLabels={{ up: desk('Price up one step'), down: desk('Price down one step') }}
        onBbo={bbo && referenceFresh ? () => edit(() => setFrom(padDecimals(bbo, pricePlaces))) : undefined}
        bboLabel={desk('BBO')}
      />
      <AmountInput
        label={t('Last price')}
        aria-label={t('Last price')}
        value={to}
        onValueChange={(next) => edit(() => setTo(next))}
        precision={pricePlaces}
        placeholder={fmtPrice('0', market.tickSize)}
        tick={market.tickSize}
        min={market.tickSize}
        unit={market.quote}
        stepLabels={{ up: desk('Price up one step'), down: desk('Price down one step') }}
      />
      <div className="tk-pair">
        <AmountInput
          label={t('Number of orders')}
          aria-label={t('Number of orders')}
          value={count}
          onValueChange={(next) => edit(() => setCount(next))}
          precision={0}
          placeholder={String(SCALE_MIN_ORDERS)}
          steppers={false}
        />
        <AmountInput
          label={t('Total amount')}
          aria-label={t('Total amount')}
          value={total}
          onValueChange={(next) => edit(() => setTotal(next))}
          precision={amountPlaces}
          unit={market.base}
          placeholder="0"
        />
      </div>
      <div className="tk-opt">
        <span className="tk-opt-label">
          {t('Size spread')}
          <InfoTip text={spreadTip} label={t('Size spread')} />
        </span>
        <SegmentedControl
          size={32}
          aria-label={t('Size spread')}
          value={spread}
          onValueChange={(next) => edit(() => setSpread(next === 'weighted' ? 'weighted' : 'even'))}
          items={[
            { value: 'even', label: t('Spread even') },
            { value: 'weighted', label: t('Spread weighted') },
          ]}
        />
      </div>
      <PostOnlyField checked={postOnly} allowed onChange={(next) => edit(() => setPostOnly(next))} />

      {plan.ok ? (
        <div className="tk-plan" aria-label={t('Orders you would place')}>
          <table className="tk-table">
            <thead>
              <tr>
                <th>#</th>
                <th className="dk-num">{t('Scale col price')}</th>
                <th className="dk-num">{t('Scale col amount')}</th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((row, i) => (
                <tr key={`${row.price}:${i}`}>
                  <td>{i + 1}</td>
                  <td className="dk-num if-num">{fmtPrice(row.price, market.tickSize)}</td>
                  <td className="dk-num if-num">{fmtAmount(row.amount, { places: amountPlaces })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="dk-avail">
            <div>
              <dt>{t('Scale total value')}</dt>
              <dd className="if-num">
                {fmtAmount(plan.totalValue, { places: 8 })} {market.quote}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      <dl className="dk-avail">
        <div>
          <dt>{desk('Available')}</dt>
          <dd className="if-num">
            {signedIn ? <Amount value={available === null ? null : `${fmtAmount(available, { places: 8 })} ${spendAsset}`} /> : '—'}
          </dd>
        </div>
      </dl>

      {signedIn ? (
        <Button
          type="submit"
          variant={side}
          shape="rounded"
          size={40}
          fullWidth
          loading={busy && !review}
          disabled={!canReview}
          aria-describedby={`tk-reason-${side}`}
        >
          {progress && !review ? t('Scale checking', progress) : verb}
        </Button>
      ) : (
        <a className={buttonVariants({ variant: side, shape: 'rounded', size: 40, fullWidth: true })} href={loginHref}>
          {desk('Log in to trade')}
        </a>
      )}
      <div className="dk-reason" id={`tk-reason-${side}`} aria-live="polite">
        {signedIn && !market.open ? <p className="dk-note">{desk('Market is closed')}</p> : null}
        {touched && !plan.ok ? <p className="dk-note">{problemText(plan.problem, market, t)}</p> : null}
        {short ? <p className="dk-note">{t('Scale short', { asset: spendAsset })}</p> : null}
        {failure ? (
          <>
            <RefusalNote failure={failure} />
            <p className="dk-note">{t('Scale not sent')}</p>
          </>
        ) : null}
        {done ? <ScaleResult done={done} market={market} /> : null}
      </div>

      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) setReview(null);
        }}
      >
        {review ? (
          <AlertDialogContent className="dk-review tk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {side === 'buy'
                  ? t('Scale review title buy', { count: review.drafts.length })
                  : t('Scale review title sell', { count: review.drafts.length })}
              </AlertDialogTitle>
              <AlertDialogDescription>{review.changed ? t('Scale review changed') : t('Scale review intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            <ReviewBody review={review} market={market} side={side} postOnly={postOnly} crossing={crossing} />
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={busy} onClick={() => setReview(null)}>
                {t('Scale cancel')}
              </Button>
              <Button variant={side} shape="pill" size={40} loading={busy} onClick={() => void confirm()}>
                {progress
                  ? t('Scale checking', progress)
                  : side === 'buy'
                    ? t('Scale confirm buy', { count: review.drafts.length })
                    : t('Scale confirm sell', { count: review.drafts.length })}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </form>
  );
}

function ReviewBody({
  review,
  market,
  side,
  postOnly,
  crossing,
}: {
  review: Review;
  market: DeskMarket;
  side: Side;
  postOnly: boolean;
  crossing: number;
}) {
  const { t } = ticketCopy.useCopy();
  const { totals } = review;
  const rate = totals.feeBps === null ? null : fmtPct(bpsToRatio(totals.feeBps), { signed: false });
  const amountPlaces = placesOf(market.lotSize);
  // Added up from the very orders that will be sent, so the totals can never describe a different list.
  let amountSum = 0n;
  let valueSum = 0n;
  const values = review.drafts.map((draft) => {
    const value = draft.price ? exactValue(draft.price, draft.amount) : '0';
    amountSum += parseAmount(draft.amount);
    valueSum += parseAmount(value);
    return value;
  });
  const totalAmount = formatAmount(amountSum);
  const totalValue = formatAmount(valueSum);
  return (
    <>
      <dl className="dk-review-rows">
        <div>
          <dt>{t('Scale review market')}</dt>
          <dd>{market.symbol}</dd>
        </div>
        <div>
          <dt>{t('Review post-only')}</dt>
          <dd>{postOnly ? t('Review post-only on') : t('Review post-only off')}</dd>
        </div>
        <div>
          <dt>{t('Scale review total amount')}</dt>
          <dd className="if-num">
            {fmtAmount(totalAmount, { places: amountPlaces })} {market.base}
          </dd>
        </div>
        <div>
          <dt>{t('Scale review total value')}</dt>
          <dd className="if-num">
            {fmtAmount(totalValue, { places: 8 })} {market.quote}
          </dd>
        </div>
        <div>
          <dt>{t('Scale review total held')}</dt>
          <dd className="if-num">
            {fmtAmount(totals.hold, { places: 8 })} {totals.holdAsset}
          </dd>
        </div>
        <div>
          <dt>{t('Scale review total fee')}</dt>
          <dd className="if-num">
            {fmtAmount(totals.fee, { places: 8 })} {totals.feeAsset}
            {rate ? ` (${t('Scale review fee rate', { rate })})` : ''}
          </dd>
        </div>
      </dl>
      {crossing > 0 ? (
        <p className="dk-note dk-note--warn">
          {postOnly ? t('Scale cross post-only', { count: crossing }) : t('Scale cross', { count: crossing })}
        </p>
      ) : null}
      <p className="tk-list-title">{t('Scale review list', { count: review.drafts.length })}</p>
      <div className="tk-list" role="region" aria-label={t('Scale review list', { count: review.drafts.length })} tabIndex={0}>
        <table className="tk-table">
          <thead>
            <tr>
              <th>#</th>
              <th className="dk-num">{t('Scale col price')}</th>
              <th className="dk-num">{t('Scale col amount')}</th>
              <th className="dk-num">{t('Scale col value')}</th>
            </tr>
          </thead>
          <tbody>
            {review.drafts.map((draft, i) => {
              return (
                <tr key={draft.clientOrderId} data-side={side}>
                  <td>{i + 1}</td>
                  <td className="dk-num if-num">{fmtPrice(draft.price ?? '', market.tickSize)}</td>
                  <td className="dk-num if-num">{fmtAmount(draft.amount, { places: amountPlaces })}</td>
                  <td className="dk-num if-num">{fmtAmount(values[i]!, { places: 8 })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ScaleResult({ done, market }: { done: Done; market: DeskMarket }) {
  const { t } = ticketCopy.useCopy();
  const placed = done.outcome.items.filter((item) => item.kind === 'placed').length;
  const refused = done.outcome.items.filter((item) => item.kind === 'refused').length;
  const rejected = done.outcome.items.filter((item) => item.kind === 'rejected' || item.kind === 'ended').length;
  const unsure = done.outcome.items.filter((item) => item.kind === 'unknown').length;
  const total = done.drafts.length;
  const amountPlaces = placesOf(market.lotSize);
  const headline =
    placed === total
      ? t('Scale done all', { count: total })
      : placed === 0 && unsure === 0
        ? t('Scale none placed')
        : t('Scale done some', { placed, total });
  return (
    <div className={`dk-note ${placed === total ? 'dk-note--good' : 'dk-note--warn'}`} role="status">
      <p className="dk-note-title">{headline}</p>
      {refused > 0 && placed !== 0 ? <p>{t('Scale done refused', { count: refused })}</p> : null}
      {rejected > 0 ? <p>{t('Scale done rejected', { count: rejected })}</p> : null}
      {unsure > 0 ? <p>{t('Scale done unsure', { count: unsure })}</p> : null}
      <div className="tk-list">
        <table className="tk-table">
          <thead>
            <tr>
              <th>#</th>
              <th className="dk-num">{t('Scale col price')}</th>
              <th className="dk-num">{t('Scale col amount')}</th>
              <th>{t('Scale result col')}</th>
            </tr>
          </thead>
          <tbody>
            {done.drafts.map((draft, i) => {
              const item = done.outcome.items[i]!;
              return (
                <tr key={draft.clientOrderId}>
                  <td>{i + 1}</td>
                  <td className="dk-num if-num">{fmtPrice(draft.price ?? '', market.tickSize)}</td>
                  <td className="dk-num if-num">{fmtAmount(draft.amount, { places: amountPlaces })}</td>
                  <td>{itemWord(item, t, (code) => refusalCopy(code ?? 'unknown').title)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface ScaleTicketProps {
  market: DeskMarket;
  reference: Reference | null;
  referenceFresh: boolean;
  freeOf: (asset: string) => string | null;
  signedIn: boolean;
  userId: string | null;
  blocked: boolean;
  api: TradeApi;
  client: ApiClient;
  onPlaced: () => void;
}

/** Scale tab: Buy and Sell side by side, like Limit and Market. */
export function ScaleTicket({ freeOf, ...rest }: ScaleTicketProps) {
  return (
    <div className="dk-forms">
      <ScaleForm {...rest} side="buy" available={rest.signedIn ? freeOf(rest.market.quote) : null} />
      <ScaleForm {...rest} side="sell" available={rest.signedIn ? freeOf(rest.market.base) : null} />
    </div>
  );
}
