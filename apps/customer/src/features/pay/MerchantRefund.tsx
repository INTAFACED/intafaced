import { useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ApiClient, ApiResult } from '../../shared/api';
import { parseAmount } from '../../shared/money';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { Field } from './ui-kit';
import { useSession } from '../session/session';
import { PayAmount } from './components';
import { DateTime } from './portal/ui/DateTime';
import type { BusinessPayApi } from './pay-api';
import type { RefundLookup, RefundReceipt, RefundSnapshot } from './merchant-refund-api';
import { HISTORY_WINDOW, refundCopy, refundFailureKey } from './merchant-refund-copy';
import * as s from './schemas';
import { moneyReason } from './portal/access/money-step';
import { payStepUp } from './portal/access/step-up-store';
import './merchant-refund.css';

type Context = {
  pay: BusinessPayApi;
  api: ApiClient;
  userId: string | null;
  authority: string;
  paymentId: string;
  href: string;
  epoch: number;
};
type Draft = { context: Context; amount: string };
type Review = { context: Context; input: { paymentId: string; amount: string; refundId: string }; assetId: string };
type OriginalContext = { context: Context; status: RefundSnapshot['status']; reference: string | null };
type Failure = Extract<ApiResult<unknown>, { ok: false }>;
type View = {
  context: Context;
  payment: s.Payment | null;
  draft: Draft | null;
  review: Review | null;
  receipt: RefundReceipt | null;
  cleanupPending: boolean;
  count: number | null;
  failure: Failure | null;
  busy: boolean;
  loading: boolean;
};
const signature = (pay: BusinessPayApi) => JSON.stringify(pay.authority);

/** Conditional Business-only original recovery. Review amounts never enter storage. */
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
  const { api, userId } = useSession();
  const titleId = useId();
  const version = useRef<Context>({ pay, api, userId, authority: signature(pay), paymentId, href: location.href, epoch: 0 });
  const previous = version.current;
  if (
    previous.pay !== pay ||
    previous.api !== api ||
    previous.userId !== userId ||
    previous.authority !== signature(pay) ||
    previous.paymentId !== paymentId ||
    previous.href !== location.href
  )
    version.current = { pay, api, userId, authority: signature(pay), paymentId, href: location.href, epoch: previous.epoch + 1 };
  const context = version.current;
  const lifetime = useRef({ context, mounted: true });
  lifetime.current.context = context;
  const [, invalidate] = useReducer((n) => n + 1, 0);
  const [view, setView] = useState<View | null>(null);
  const admitted = useRef<Review | null>(null);
  const draft = useRef<Draft | null>(null);
  const operation = useRef<object | null>(null);
  const originalVersion = useRef<OriginalContext | null>(null);
  const activeReceipt = useRef<RefundReceipt | null>(null);
  const loading = useRef<object | null>(null);
  const form = useRef<HTMLDivElement>(null);
  const { t, Copy, requestedLocale } = refundCopy.useCopy();
  const live = () =>
    lifetime.current.mounted &&
    lifetime.current.context === context &&
    version.current === context &&
    location.href === context.href &&
    context.api.canWrite() &&
    context.userId === pay.authority?.userId &&
    context.authority === signature(pay) &&
    pay.refund.isCurrent(() => true);
  const snapshot: RefundSnapshot = pay.refund.inspect(paymentId, live);
  const previousOriginal = originalVersion.current;
  if (
    previousOriginal?.context !== context ||
    previousOriginal.status !== snapshot.status ||
    previousOriginal.reference !== snapshot.reference
  )
    originalVersion.current = { context, status: snapshot.status, reference: snapshot.reference };
  const original = originalVersion.current!;
  const shown = view?.context === context ? view : null;
  const receipt = live() ? (shown?.receipt ?? snapshot.known) : null;
  activeReceipt.current = receipt;
  const cleanupPending = Boolean(receipt && (shown?.cleanupPending || snapshot.known));
  const recovery = snapshot.status !== 'empty' || cleanupPending;
  const currentReview = live() && shown?.review === admitted.current ? shown?.review : null;
  const backIdentity = currentReview ?? receipt ?? shown?.draft ?? snapshot.reference ?? context;
  function emptyView(): View {
    return {
      context,
      payment: null,
      draft: null,
      review: null,
      receipt: null,
      cleanupPending: false,
      count: null,
      failure: null,
      busy: false,
      loading: false,
    };
  }
  function update(change: Partial<View>) {
    if (live()) setView((value) => ({ ...(value?.context === context ? value : emptyView()), ...change }));
  }
  function clearPrivate() {
    admitted.current = null;
    draft.current = null;
    operation.current = null;
    originalVersion.current = null;
    loading.current = null;
    for (const input of form.current?.querySelectorAll('input') ?? []) input.value = '';
  }
  async function loadPayment() {
    if (!live()) return;
    const attempt = {};
    loading.current = attempt;
    const current = () => live() && loading.current === attempt;
    update({ loading: true, failure: null });
    const restored = await pay.refund.restore(paymentId, current);
    if (!current()) return;
    const saved = pay.refund.inspect(paymentId, current);
    if (!restored.ok || saved.status !== 'empty' || saved.known) {
      update({ loading: false, failure: restored.ok ? null : restored });
      invalidate();
      return;
    }
    const result = await pay.refund.readPayment(paymentId, current);
    if (!current()) return;
    const next = { context, amount: '' };
    draft.current = next;
    update({ loading: false, payment: result.ok ? result.data : null, draft: next, failure: result.ok ? null : result });
  }
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    const departed = () => {
      if (version.current.href === location.href) return;
      const next = { ...version.current, href: location.href, epoch: version.current.epoch + 1 };
      version.current = next;
      lifetime.current.context = next;
      clearPrivate();
      flushSync(() => {
        setView(null);
        invalidate();
      });
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      lifetime.current.mounted = false;
      clearPrivate();
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
    };
  }, []);
  useLayoutEffect(() => {
    clearPrivate();
    setView(emptyView());
    void loadPayment();
    const changed = (event: StorageEvent) => {
      if ((event.key === `pay.unresolved:${userId}:payment:${paymentId}` || event.key === null) && live()) {
        clearPrivate();
        update({ review: null, draft: null, payment: null, count: null });
        void loadPayment();
      }
    };
    const returned = () => {
      if (document.visibilityState === 'visible' && live()) {
        invalidate();
        if (!admitted.current && !operation.current) void loadPayment();
      }
    };
    window.addEventListener('storage', changed);
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => {
      loading.current = null;
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', returned);
    };
  }, [context]);
  /** A refusal this screen writes itself when the confirmation step cannot be completed. Nothing was sent. */
  const stepFailure = (code: 'pay.refund_step_up_required' | 'pay.refund_step_up_expired'): Failure => ({
    ok: false,
    reason: 'error',
    code,
    message: t(code === 'pay.refund_step_up_required' ? 'stepRequired' : 'stepExpired'),
  });
  async function prepare() {
    if (!live() || !shown?.draft || draft.current !== shown.draft || !shown.payment || shown.busy) return;
    const saved = pay.refund.inspect(paymentId, live);
    if (saved.status !== 'empty' || saved.known || saved.problem) {
      invalidate();
      return;
    }
    const started = shown.draft;
    const payment = shown.payment;
    const amount = started.amount.trim();
    if (
      !s.positiveAmount.safeParse(amount).success ||
      parseAmount(amount) > parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount)
    ) {
      update({ failure: { ok: false, reason: 'error', code: 'pay.refund_amount_invalid', message: t('invalidAmount') } });
      return;
    }
    // Money out: confirm it's them first. The review opens once that is done; nothing is reserved or sent before.
    if (!(await payStepUp.ensure('refund'))) {
      if (live() && !payStepUp.canAsk) update({ failure: stepFailure('pay.refund_step_up_required') });
      return;
    }
    if (!live() || draft.current !== started || admitted.current || pay.refund.inspect(paymentId, live).status !== 'empty') return;
    const review = {
      context,
      input: Object.freeze({ paymentId, amount, refundId: `refund:${paymentId}:${crypto.randomUUID()}` }),
      assetId: payment.assetId,
    };
    operation.current = null;
    admitted.current = review;
    update({ review, failure: null });
  }
  function dismiss(review: Review, edit: boolean) {
    if (!live() || admitted.current !== review) return;
    admitted.current = null;
    const saved = pay.refund.inspect(paymentId, live);
    if (saved.status === 'empty') operation.current = null;
    const next = { context, amount: edit && saved.status === 'empty' ? review.input.amount : '' };
    draft.current = next;
    update({ review: null, draft: next, busy: false, failure: null });
    invalidate();
  }
  function publish(result: ApiResult<RefundLookup>, action: object) {
    if (!live() || operation.current !== action) return;
    activeReceipt.current = result.ok ? result.data.receipt : null;
    admitted.current = null;
    draft.current = null;
    operation.current = null;
    update({
      review: null,
      draft: null,
      payment: null,
      busy: false,
      failure: result.ok ? null : result,
      receipt: result.ok ? result.data.receipt : null,
      cleanupPending: result.ok && result.data.cleanupPending,
      count: result.ok ? result.data.count : null,
    });
    if (result.ok && result.data.receipt) onRecorded();
    invalidate();
  }
  async function confirm(review: Review) {
    if (!live() || admitted.current !== review || operation.current) return;
    const action = {};
    operation.current = action;
    update({ busy: true });
    const reviewCurrent = () => live() && admitted.current === review && operation.current === action;
    const originalCurrent = () => live() && operation.current === action;
    // Nothing has been sent when the confirmation is missing or turned away, so the review closes with the amount kept.
    const stopped = (code: 'pay.refund_step_up_required' | 'pay.refund_step_up_expired') => {
      if (!live() || admitted.current !== review || operation.current !== action) return;
      operation.current = null;
      dismiss(review, true);
      update({ failure: stepFailure(code) });
    };
    // The confirmation may have run out while the review was open: confirm again, then send.
    if (!(await payStepUp.ensure('refund'))) return stopped('pay.refund_step_up_required');
    let result = await pay.refund.submit(review.input, reviewCurrent, originalCurrent, live);
    if (!result.ok && result.code === 'pay.refund_step_up_expired') {
      // It ran out between the check and the send. The same review, with the same refund reference, goes out again.
      payStepUp.drop('refund');
      if (!(await payStepUp.ensure('refund', true))) return stopped('pay.refund_step_up_expired');
      result = await pay.refund.submit(review.input, reviewCurrent, originalCurrent, live);
      if (!result.ok && result.code === 'pay.refund_step_up_expired') return stopped('pay.refund_step_up_expired');
    }
    publish(result, action);
  }
  async function check() {
    const originalCurrent = () => {
      if (!live() || originalVersion.current !== original) return false;
      const saved = pay.refund.inspect(paymentId, live);
      return saved.status === original.status && saved.reference === original.reference;
    };
    if (!originalCurrent() || operation.current || snapshot.known) return;
    const action = {};
    operation.current = action;
    update({ busy: true, failure: null });
    const result = await pay.refund.checkOriginal(paymentId, () => originalCurrent() && operation.current === action, live);
    if (!live() || operation.current !== action) return;
    const saved = pay.refund.inspect(paymentId, live);
    // Our exact terminal cleanup may retire the durable original before publication.
    // A replacement original must never receive this retired read's private result.
    const cleanedOriginal = result.ok && result.data.receipt?.refundId === original.reference && saved.status === 'empty';
    if (!originalCurrent() && !cleanedOriginal) {
      operation.current = null;
      update({ busy: false });
      invalidate();
      return;
    }
    publish(result, action);
  }
  async function cleanup(original: RefundReceipt) {
    if (!live() || activeReceipt.current !== original || operation.current) return;
    const action = {};
    operation.current = action;
    update({ busy: true });
    const cleared = await pay.refund.cleanupKnown(paymentId, original, () => live() && operation.current === action);
    if (!live() || operation.current !== action) return;
    operation.current = null;
    update({ busy: false, cleanupPending: !cleared });
    invalidate();
  }
  function newReview(original: RefundReceipt) {
    if (!live() || activeReceipt.current !== original || cleanupPending || operation.current) return;
    const saved = pay.refund.inspect(paymentId, live);
    if (saved.status !== 'empty' || saved.known || saved.problem) {
      invalidate();
      return;
    }
    clearPrivate();
    activeReceipt.current = null;
    update({ receipt: null, cleanupPending: false, count: null, failure: null });
    void loadPayment();
  }
  function back() {
    const currentIdentity =
      admitted.current ?? activeReceipt.current ?? draft.current ?? pay.refund.inspect(paymentId, live).reference ?? context;
    if (live() && currentIdentity === backIdentity) {
      clearPrivate();
      onBack();
    }
  }
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
  const failure = shown?.failure;
  const failureKey = refundFailureKey({
    code: failure?.code,
    busy: snapshot.problem === 'busy',
    referenceHeld: snapshot.status !== 'empty',
  });
  if (!live() || pay.access('pay:read')) return null;
  return (
    <section data-testid="merchant-refund" className="merchant-refund" aria-labelledby={titleId} ref={form} lang={requestedLocale}>
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
          <div data-testid="merchant-refund-actions" className="merchant-refund-actions">
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
                onChange={(event) => {
                  if (!live() || !shown.draft || draft.current !== shown.draft || admitted.current) return;
                  const next = { context, amount: event.target.value };
                  draft.current = next;
                  operation.current = null;
                  update({ draft: next, failure: null });
                }}
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
          <div data-testid="merchant-refund" className="merchant-refund merchant-refund-review">
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
            <div data-testid="merchant-refund-actions" className="merchant-refund-actions">
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
