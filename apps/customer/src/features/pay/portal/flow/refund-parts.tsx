import { useId } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { parseAmount } from '../../../../shared/money';
import type { BusinessPayApi } from '../../pay-api';
import { HISTORY_WINDOW } from '../../merchant-refund-copy';
import { useMerchantRefund } from '../../merchant-refund-state';
import { moneyReason } from '../access/money-step';
import { Amount } from '../../p2p-flow/parts';
import { Actions, DateTime } from './parts';

/**
 * The kit view of the merchant refund (`../../MerchantRefund.tsx`): the same states, words and handlers, drawn only
 * from `@intafaced/ui/lit`. Both views run `useMerchantRefund` (`../../merchant-refund-state.ts`), so the review, the
 * "Confirm it's you" before it, the one confirm with its refund reference, the recovery of an unanswered refund and the
 * receipt are the same code. Review amounts never enter storage.
 */
export function MerchantRefundView({
  pay,
  paymentId,
  onRecorded,
  onBack,
}: {
  pay: BusinessPayApi;
  paymentId: string;
  onRecorded: () => void;
  onBack: () => void;
}) {
  const titleId = useId();
  const {
    t,
    Copy,
    requestedLocale,
    form,
    hidden,
    snapshot,
    shown,
    receipt,
    cleanupPending,
    recovery,
    currentReview,
    failure,
    failureKey,
    loadPayment,
    prepare,
    dismiss,
    confirm,
    check,
    cleanup,
    newReview,
    back,
    editAmount,
  } = useMerchantRefund({ pay, paymentId, onRecorded, onBack });
  // The technical references sit behind a disclosure: support asks for them, a merchant seldom does.
  const references = (reference: string | null) => (
    <details>
      <summary>{t('details')}</summary>
      <dl className="lt-kv">
        <div>
          <dt>
            <Copy k="payment" />
          </dt>
          <dd lang="zxx">{paymentId}</dd>
        </div>
        <div>
          <dt>
            <Copy k="reference" />
          </dt>
          <dd lang={reference ? 'zxx' : requestedLocale}>{reference ?? t('unavailable')}</dd>
        </div>
      </dl>
    </details>
  );
  if (hidden) return null;
  return (
    <section aria-labelledby={titleId} ref={form} lang={requestedLocale}>
      <header>
        <h3 id={titleId}>
          {receipt
            ? t(receipt.kind === 'refunded' ? 'recorded' : 'reversed')
            : recovery
              ? t(snapshot.status === 'unreadable' ? 'unreadable' : 'unknown')
              : t('title')}
        </h3>
        {(receipt || recovery) && (
          <p className="lt-hint">
            {receipt
              ? t(receipt.kind === 'refunded' ? 'recordedBody' : 'reversedBody')
              : t(snapshot.status === 'unreadable' ? 'unreadableBody' : 'unknownBody')}
          </p>
        )}
      </header>
      {(receipt || recovery) && references(receipt?.refundId ?? snapshot.reference)}
      {receipt && (
        <div role="status">
          <p className="lt-hint">
            <Copy k="matched" />
          </p>
          <strong>{t(receipt.kind === 'refunded' ? 'recorded' : 'reversed')}</strong>
          <DateTime value={receipt.ts} />
        </div>
      )}
      {receipt && cleanupPending && (
        <>
          <div>
            <h4>
              <Copy k="cleanup" />
            </h4>
            <p className="lt-hint">
              <Copy k="cleanupBody" />
            </p>
          </div>
          <Actions>
            <Button tone="primary" onClick={() => void cleanup(receipt)} disabled={shown?.busy}>
              <Copy k="cleanupAction" />
            </Button>
            <p className="lt-hint">
              <Copy k="cleanupOnly" />
            </p>
          </Actions>
        </>
      )}
      {receipt && !cleanupPending && (
        <>
          {receipt.kind === 'reversed' && (
            <div>
              <h4>
                <Copy k="spent" />
              </h4>
              <p className="lt-hint">
                <Copy k="spentBody" />
              </p>
            </div>
          )}
          <Button tone="primary" onClick={() => newReview(receipt)} disabled={shown?.busy}>
            <Copy k="newReview" />
          </Button>
        </>
      )}
      {!receipt && recovery && (
        <>
          {snapshot.status === 'unreadable' ? (
            <div>
              <h4>
                <Copy k="noSend" />
              </h4>
              <p className="lt-hint">{snapshot.problem === 'conflict' ? t('conflict') : t('retryBody')}</p>
              {snapshot.references.map((ref) => (
                <p lang="zxx" key={ref} className="lt-mono">
                  {ref}
                </p>
              ))}
            </div>
          ) : !snapshot.reference ? (
            <p>
              <Copy k="legacy" />
            </p>
          ) : shown?.count !== null && shown?.count !== undefined ? (
            <div>
              <h4>
                <Copy k="noMatch" />
              </h4>
              <p className="lt-hint">
                <Copy k={shown.count >= HISTORY_WINDOW ? 'historyWindow' : 'historyAll'} params={{ count: shown.count }} />
              </p>
              <p>
                <Copy k="noProof" />
              </p>
            </div>
          ) : null}
          {snapshot.problem === 'busy' && (
            <p role="status">
              <Copy k="busy" />
            </p>
          )}
          <p className="lt-hint">
            <Copy k="paused" />
          </p>
          <Button
            tone="primary"
            disabled={shown?.busy}
            onClick={() => (snapshot.status === 'unreadable' ? void loadPayment() : void check())}
          >
            {t(snapshot.status === 'unreadable' ? 'retry' : 'check')}
          </Button>
        </>
      )}
      {!receipt &&
        !recovery &&
        (shown?.loading ? (
          <p role="status">
            <Copy k="loading" />
          </p>
        ) : shown?.payment ? (
          parseAmount(shown.payment.capturedAmount) > parseAmount(shown.payment.refundedAmount) &&
          ['captured', 'settled', 'refunded'].includes(shown.payment.status) ? (
            <>
              <Field
                label={t('amount', { asset: shown.payment.assetId })}
                inputMode="decimal"
                value={shown.draft?.amount ?? ''}
                onChange={(event) => editAmount(event.target.value)}
              />
              {pay.access('pay:refund') && (
                <p role="note" className="lt-hint">
                  {moneyReason('refund', pay.authority?.scopes)}
                </p>
              )}
              <Button
                tone="primary"
                onClick={() => void prepare()}
                disabled={!shown.draft?.amount || shown.busy || Boolean(pay.access('pay:refund')) || Boolean(snapshot.problem)}
              >
                <Copy k="reviewAction" />
              </Button>
            </>
          ) : (
            <p>
              <Copy k="noCaptured" />
            </p>
          )
        ) : (
          <Button tone="secondary" onClick={() => void loadPayment()}>
            <Copy k="readRetry" />
          </Button>
        ))}
      {failure && (
        <p role="alert" lang={requestedLocale}>
          {t(failureKey)}
        </p>
      )}
      {shown?.busy && (
        <p role="status">
          <Copy k="checking" />
        </p>
      )}
      <Button tone="secondary" onClick={back}>
        <Copy k="back" />
      </Button>
      {currentReview && (
        <Sheet open title={t('review')} closeLabel={t('back')} onClose={() => dismiss(currentReview, false)}>
          <div data-testid="form-stack">
            <p className="lt-hint">
              <Copy k="reviewBody" />
            </p>
            <p className="lt-hint">
              <Copy k="reviewAmount" />
            </p>
            <Amount value={currentReview.input.amount} unit={currentReview.assetId} label={t('reviewAmount')} />
            {references(currentReview.input.refundId)}
            <div>
              <h4>
                <Copy k="continuity" />
              </h4>
              <p className="lt-hint">
                <Copy k="continuityBody" />
              </p>
            </div>
            <Actions>
              <Button tone="primary" onClick={() => void confirm(currentReview)} disabled={shown?.busy}>
                <Copy k="confirm" />
              </Button>
              <Button tone="secondary" onClick={() => dismiss(currentReview, true)}>
                <Copy k="edit" />
              </Button>
            </Actions>
          </div>
        </Sheet>
      )}
    </section>
  );
}
