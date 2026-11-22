import { useId } from 'react';
import { parseAmount } from '../../shared/money';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { Field } from './ui-kit';
import { PayAmount } from './components';
import { DateTime } from './portal/ui/DateTime';
import type { BusinessPayApi } from './pay-api';
import { HISTORY_WINDOW } from './merchant-refund-copy';
import { moneyReason } from './portal/access/money-step';
import { useMerchantRefund } from './merchant-refund-state';
import './merchant-refund.css';

/** Conditional Business-only original recovery. Review amounts never enter storage. The state is `useMerchantRefund`. */
export function MerchantRefund({
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
    <details className="merchant-refund-details">
      <summary>{t('details')}</summary>
      <dl>
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
    <section className="merchant-refund" aria-labelledby={titleId} ref={form} lang={requestedLocale}>
      <header>
        <h3 id={titleId}>
          {receipt
            ? t(receipt.kind === 'refunded' ? 'recorded' : 'reversed')
            : recovery
              ? t(snapshot.status === 'unreadable' ? 'unreadable' : 'unknown')
              : t('title')}
        </h3>
        {(receipt || recovery) && (
          <p className="muted">
            {receipt
              ? t(receipt.kind === 'refunded' ? 'recordedBody' : 'reversedBody')
              : t(snapshot.status === 'unreadable' ? 'unreadableBody' : 'unknownBody')}
          </p>
        )}
      </header>
      {(receipt || recovery) && references(receipt?.refundId ?? snapshot.reference)}
      {receipt && (
        <div className="merchant-refund-proof" role="status">
          <p className="muted">
            <Copy k="matched" />
          </p>
          <strong>{t(receipt.kind === 'refunded' ? 'recorded' : 'reversed')}</strong>
          <DateTime value={receipt.ts} />
        </div>
      )}
      {receipt && cleanupPending && (
        <>
          <div className="merchant-refund-note">
            <h4>
              <Copy k="cleanup" />
            </h4>
            <p className="muted">
              <Copy k="cleanupBody" />
            </p>
          </div>
          <div className="merchant-refund-actions">
            <Button onClick={() => void cleanup(receipt)} disabled={shown?.busy}>
              <Copy k="cleanupAction" />
            </Button>
            <p className="muted">
              <Copy k="cleanupOnly" />
            </p>
          </div>
        </>
      )}
      {receipt && !cleanupPending && (
        <>
          {receipt.kind === 'reversed' && (
            <div className="merchant-refund-note">
              <h4>
                <Copy k="spent" />
              </h4>
              <p className="muted">
                <Copy k="spentBody" />
              </p>
            </div>
          )}
          <Button onClick={() => newReview(receipt)} disabled={shown?.busy}>
            <Copy k="newReview" />
          </Button>
        </>
      )}
      {!receipt && recovery && (
        <>
          {snapshot.status === 'unreadable' ? (
            <div className="merchant-refund-note">
              <h4>
                <Copy k="noSend" />
              </h4>
              <p className="muted">{snapshot.problem === 'conflict' ? t('conflict') : t('retryBody')}</p>
              {snapshot.references.map((ref) => (
                <p lang="zxx" key={ref} style={{ overflowWrap: 'anywhere' }}>
                  {ref}
                </p>
              ))}
            </div>
          ) : !snapshot.reference ? (
            <p>
              <Copy k="legacy" />
            </p>
          ) : shown?.count !== null && shown?.count !== undefined ? (
            <div className="merchant-refund-note">
              <h4>
                <Copy k="noMatch" />
              </h4>
              <p className="muted">
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
          <p className="muted">
            <Copy k="paused" />
          </p>
          <Button disabled={shown?.busy} onClick={() => (snapshot.status === 'unreadable' ? void loadPayment() : void check())}>
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
                <p role="note" className="muted">
                  {moneyReason('refund', pay.authority?.scopes)}
                </p>
              )}
              <Button
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
          <Button variant="secondary" onClick={() => void loadPayment()}>
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
      <Button variant="secondary" onClick={back}>
        <Copy k="back" />
      </Button>
      {currentReview && (
        <Dialog closeLabel={t('back')} title={t('review')} onClose={() => dismiss(currentReview, false)}>
          <div className="merchant-refund merchant-refund-review">
            <p className="muted">
              <Copy k="reviewBody" />
            </p>
            <p className="muted">
              <Copy k="reviewAmount" />
            </p>
            <PayAmount value={currentReview.input.amount} unit={currentReview.assetId} label={t('reviewAmount')} />
            {references(currentReview.input.refundId)}
            <div className="merchant-refund-note">
              <h4>
                <Copy k="continuity" />
              </h4>
              <p className="muted">
                <Copy k="continuityBody" />
              </p>
            </div>
            <div className="merchant-refund-actions">
              <Button onClick={() => void confirm(currentReview)} disabled={shown?.busy}>
                <Copy k="confirm" />
              </Button>
              <Button variant="secondary" onClick={() => dismiss(currentReview, true)}>
                <Copy k="edit" />
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
