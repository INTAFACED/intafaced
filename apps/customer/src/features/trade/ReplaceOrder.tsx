import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Failure, Field } from '../../shared/ui';
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
  onStatus: (message: string) => void;
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
    const result = await api.order(current.id);
    if (!mounted.current) return null;
    if (!result.ok) {
      setFailure(result);
      return null;
    }
    if (result.data.recoveryRequired || result.data.status !== 'open' || parseAmount(result.data.filled) > 0n) {
      setCurrent(result.data);
      setReview(null);
      setFailure({
        ok: false,
        reason: 'error',
        message: `This order is ${result.data.status}, with ${result.data.filled} ${base} filled. Cancel/replace requires an unfilled working order with no recovery.`,
      });
      return null;
    }
    if (result.data.filled !== current.filled || result.data.remaining !== current.remaining || result.data.price !== current.price) {
      setCurrent(result.data);
      setReview(null);
      setFailure({ ok: false, reason: 'error', message: 'The original order changed. Review its refreshed state before replacing it.' });
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
      const result = await api.replace(current.id, review.draft, review.preview, () => mounted.current);
      if (result.ok) {
        onResolved(identity);
        onStatus(
          `Cancel/replace: ${result.data.code}${result.data.reasonCode ? ` (${result.data.reasonCode})` : ''}. Original ${result.data.original.id}: ${result.data.original.status}. ${result.data.replacement ? `Replacement ${result.data.replacement.id}: ${result.data.replacement.status}; remaining ${result.data.replacement.remaining} ${base}.` : 'No replacement was submitted.'} Queue priority is not retained.`,
        );
        onClose();
      } else if (result.reason === 'changed') {
        onResolved(identity);
        setReview({ draft: review.draft, preview: result.preview });
        setFailure({ ok: false, reason: 'error', message: result.message });
      } else {
        if (result.reason !== 'uncertain') onResolved(identity);
        setFailure(result);
        if (result.reason === 'uncertain') {
          onStatus(result.message);
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
      title="Change price with cancel/replace"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {current.symbol} · {current.side} limit · {current.id}
      </p>
      <dl className="trade-review">
        <div>
          <dt>Original remaining</dt>
          <dd>
            {displayAmount(current.remaining)} {base}
          </dd>
        </div>
        <div>
          <dt>Original limit price</dt>
          <dd>
            {displayAmount(current.price)} {quote} per {base}
          </dd>
        </div>
      </dl>
      <p className="trade-refusal">
        The service first cancels the original and confirms its reservation release, then submits a new order. Queue priority is lost.
        Replacement can fail after cancellation; a fill can prevent replacement.
      </p>
      {review ? (
        <>
          <dl className="trade-review">
            <div>
              <dt>Replacement quantity</dt>
              <dd>
                {displayAmount(review.draft.amount)} {base}
              </dd>
            </div>
            <div>
              <dt>Replacement price</dt>
              <dd>
                {displayAmount(review.preview.price)} {quote} per {base}
              </dd>
            </div>
            <div>
              <dt>Replacement order value</dt>
              <dd>
                {displayAmount(exactValue(review.draft.price ?? '0', review.draft.amount))} {quote}
              </dd>
            </div>
            <div>
              <dt>Conditions</dt>
              <dd>{review.preview.timeInForce}</dd>
            </div>
            <div>
              <dt>Estimated fee</dt>
              <dd>
                {displayAmount(review.preview.estimatedFee)} {review.preview.feeAsset}
              </dd>
            </div>
            <div>
              <dt>New reservation</dt>
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
            {busy ? 'Checking replacement…' : 'Confirm cancel/replace'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
            Back to edit
          </Button>
        </>
      ) : (
        <>
          <Field
            label={`Replacement limit price (${quote} per ${base})`}
            inputMode="decimal"
            value={price}
            onChange={(event) => edit(() => setPrice(event.target.value))}
          />
          <Field
            label={`Replacement quantity (${base})`}
            inputMode="decimal"
            value={amount}
            onChange={(event) => edit(() => setAmount(event.target.value))}
          />
          <Button disabled={busy} onClick={() => void run(false)}>
            {busy ? 'Checking original…' : 'Review replacement'}
          </Button>
        </>
      )}
      {failure && <Failure result={failure} />}
      <Button variant="secondary" disabled={busy} onClick={onClose}>
        Keep order
      </Button>
    </Dialog>
  );
}
