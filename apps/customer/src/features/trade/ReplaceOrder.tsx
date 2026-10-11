import {
  TradeOriginalMessage,
  tradeRefusal,
  tradeFailureFrom,
  TradeMessage,
  tradeCopy as copy,
  CopyText,
  TradeFailure as Failure,
} from './copy';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Field } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { displayAmount, parseAmount } from '../../shared/money';
import { draftSchema, exactValue, type Draft, type Order, type Preview, type TradeApi } from './trade-api';

type ReplacementIntent = { kind: 'replace'; id: string; orderId: string; symbol: string; startedAt: number };
export function ReplaceOrder({
  api,
  order,
  initialPrice,
  onClose,
  onIntent,
  onResolved,
  onStatus,
}: {
  api: TradeApi;
  order: Order;
  initialPrice?: string;
  onClose: () => void;
  onIntent: (intent: ReplacementIntent) => Promise<boolean>;
  onResolved: (identity: ReplacementIntent) => void;
  onStatus: (message: ReactNode) => void;
}) {
  const [current, setCurrent] = useState(order),
    [amount, setAmount] = useState(order.remaining),
    [price, setPrice] = useState(initialPrice ?? order.price ?? ''),
    [review, setReview] = useState<{ draft: Draft; preview: Preview } | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const mounted = useRef(true),
    active = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [base, quote] = current.symbol.split('/');
  async function latestOrder() {
    const result = await api.order(current);
    if (!mounted.current) return null;
    if (!result.ok) {
      setFailure(result);
      return null;
    }
    if (result.data.recoveryRequired || result.data.status !== 'open' || parseAmount(result.data.filled) > 0n) {
      setCurrent(result.data);
      setReview(null);
      setFailure(
        tradeRefusal(
          'thisOrderIsWithFilledCancelReplaceRequiresAnUnfilledWorking',
          { reason: 'error' },
          {
            resultDataStatus: String(result.data.status),
            resultDataFilled: String(result.data.filled),
            base: String(base),
          },
        ),
      );
      return null;
    }
    if (result.data.filled !== current.filled || result.data.remaining !== current.remaining || result.data.price !== current.price) {
      setCurrent(result.data);
      setReview(null);
      setFailure(tradeRefusal('theOriginalOrderChangedReviewItsRefreshedStateBeforeReplacingIt', { reason: 'error' }));
      return null;
    }
    return result.data;
  }
  async function run(confirm: boolean) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (!(await latestOrder())) return;
      if (!confirm) {
        const draft = draftSchema.safeParse({
          symbol: current.symbol,
          side: current.side,
          type: 'limit',
          amount,
          price,
          timeInForce: current.timeInForce ?? 'GTC',
          postOnly: current.postOnly,
          clientOrderId: `change:${crypto.randomUUID()}`,
        });
        if (!draft.success) {
          setFailure({ ok: false, reason: 'error', message: draft.error.issues.map((row) => row.message).join(' ') });
          return;
        }
        const result = await api.preview(draft.data);
        if (!mounted.current) return;
        if (result.ok) setReview({ draft: draft.data, preview: result.data });
        else setFailure(result);
        return;
      }
      if (!review || !mounted.current) return;
      const identity: ReplacementIntent = {
        kind: 'replace',
        id: review.draft.clientOrderId,
        orderId: current.id,
        symbol: current.symbol,
        startedAt: Date.now(),
      };
      if (!(await onIntent(identity))) return;
      const result = await api.replace(current, review.draft, review.preview, () => mounted.current);
      if (result.ok) {
        onResolved(identity);
        onStatus(
          <TradeMessage
            k={'replacementOutcome'}
            params={() => ({
              code: result.data.code,
              reason: result.data.reasonCode ? ` (${result.data.reasonCode})` : '',
              originalId: result.data.original.id,
              originalStatus: result.data.original.status,
              replacement: result.data.replacement
                ? copy.t('replacementOrderOutcome', {
                    id: result.data.replacement.id,
                    status: result.data.replacement.status,
                    remaining: result.data.replacement.remaining,
                    base: String(base),
                  })
                : copy.t('noReplacementSubmitted'),
              priority: result.data.replacement
                ? copy.t('replacementNewPriority')
                : result.data.original.status === 'open'
                  ? copy.t('originalWorkingRefusal')
                  : '',
            })}
          />,
        );
        onClose();
      } else if (result.reason === 'changed') {
        onResolved(identity);
        setReview({ draft: review.draft, preview: result.preview });
        setFailure(tradeFailureFrom(result, 'error'));
      } else {
        if (result.reason !== 'uncertain') onResolved(identity);
        setFailure(result);
        if (result.reason === 'uncertain') {
          onStatus(<TradeOriginalMessage source={result} />);
          onClose();
        }
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  function edit(update: () => void) {
    if (!active.current) {
      update();
      setReview(null);
      setFailure(null);
    }
  }
  return (
    <Dialog
      title={<CopyText k={'changePriceWithCancelReplace'} />}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {current.symbol} · {current.side} <CopyText k="limit" />
        {current.id}
      </p>
      <dl className="trade-review">
        <div>
          <dt>
            <CopyText k="originalRemaining" />
          </dt>
          <dd>
            {displayAmount(current.remaining)} {base}
          </dd>
        </div>
        <div>
          <dt>
            <CopyText k="originalLimitPrice" />
          </dt>
          <dd>
            {displayAmount(current.price)} {quote} <CopyText k="per" />
            {base}
          </dd>
        </div>
      </dl>
      <p className="trade-refusal">
        <CopyText k="theServiceFirstCancelsTheOriginalAndConfirmsItsReservationRelease" />
      </p>
      {review ? (
        <>
          <dl className="trade-review">
            <div>
              <dt>
                <CopyText k="replacementQuantity" />
              </dt>
              <dd>
                {displayAmount(review.draft.amount)} {base}
              </dd>
            </div>
            <div>
              <dt>
                <CopyText k="replacementPrice" />
              </dt>
              <dd>
                {displayAmount(review.preview.price)} {quote} <CopyText k="per" />
                {base}
              </dd>
            </div>
            <div>
              <dt>
                <CopyText k="replacementOrderValue" />
              </dt>
              <dd>
                {displayAmount(exactValue(review.draft.price ?? '0', review.draft.amount))} {quote}
              </dd>
            </div>
            <div>
              <dt>
                <CopyText k="conditions" />
              </dt>
              <dd>{review.preview.timeInForce}</dd>
            </div>
            <div>
              <dt>
                <CopyText k="estimatedFee" />
              </dt>
              <dd>
                {displayAmount(review.preview.estimatedFee)} {review.preview.feeAsset}
              </dd>
            </div>
            <div>
              <dt>
                <CopyText k="newReservation" />
              </dt>
              <dd>
                {displayAmount(review.preview.holdAmount)} {review.preview.holdAsset}
              </dd>
            </div>
          </dl>
          {review.preview.refusals.map((row) => (
            <p className="trade-refusal" key={`${row.code}:${row.field}`}>
              {row.message}
            </p>
          ))}
          <Button
            disabled={
              busy ||
              !review.preview.orderable ||
              review.preview.refusals.length > 0 ||
              review.preview.estimatedFee === null ||
              review.preview.feeAsset === null ||
              review.preview.holdAmount === null ||
              review.preview.holdAsset === null
            }
            onClick={() => void run(true)}
          >
            {busy ? <CopyText k={'checkingReplacement'} /> : <CopyText k={'confirmCancelReplace'} />}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
            <CopyText k="backToEdit" />
          </Button>
        </>
      ) : (
        <>
          <Field
            label={<CopyText k={'replacementLimitPricePer'} params={{ quote: String(quote), base: String(base) }} />}
            inputMode="decimal"
            value={price}
            onChange={(event) => edit(() => setPrice(event.target.value))}
          />
          <Field
            label={<CopyText k={'replacementQuantityef5c2c'} params={{ base: String(base) }} />}
            inputMode="decimal"
            value={amount}
            onChange={(event) => edit(() => setAmount(event.target.value))}
          />
          <Button disabled={busy} onClick={() => void run(false)}>
            {busy ? <CopyText k={'checkingOriginal'} /> : <CopyText k={'reviewReplacement'} />}
          </Button>
        </>
      )}
      {failure && <Failure result={failure} />}
      <Button variant="secondary" disabled={busy} onClick={onClose}>
        <CopyText k="keepOrder" />
      </Button>
    </Dialog>
  );
}
