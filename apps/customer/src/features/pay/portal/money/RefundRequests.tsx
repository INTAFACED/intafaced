import { useState } from 'react';
import { Button, ReviewDialog as Dialog } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import type { ApiResult } from '../../../../shared/api';
import { PaySection } from '../../components';
import { Facts, Gate, PortalFailure, PortalLoading } from '../components';
import type { PortalApi } from '../api';
import { useMemberNames } from '../hooks';
import { isUuid } from '../model';
import { payStepUp } from '../access/step-up-store';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { MoneyText } from '../ui/MoneyText';
import { RelatedLinks } from '../ui/RelatedLinks';
import { ToneChip, type StatusTone } from '../ui/StatusChip';
import { localRefusal, TestBanner, useTestMode, whoIs } from './common';
import { mc } from './copy';
import { refundRequestsCopy } from './refund-requests-copy';
import type { RefundRequest } from './schemas';

/**
 * J-merchant-06 #4/#5: refunds that wait for a second person. Nothing is posted while one waits; the person who asked
 * may cancel it once, and a teammate who did not ask approves (the refund then runs once) or rejects it.
 */
export const refundRequestHref = (id: string) => `/pay/refunds/requests/${encodeURIComponent(id)}`;

const TONE: Record<RefundRequest['status'], StatusTone> = {
  queued: 'action',
  approved: 'progress',
  refunded: 'done',
  failed: 'failed',
  rejected: 'failed',
  cancelled: 'failed',
  voided: 'failed',
};

export function RefundRequestChip({ status }: { status: RefundRequest['status'] }) {
  const { t } = refundRequestsCopy.useCopy();
  return (
    <span data-testid="status-chip">
      <ToneChip tone={TONE[status]} label={t(`rqStatus_${status}`)} tip={t(`rqTip_${status}`)} />
    </span>
  );
}

/** `/pay/refunds/requests/:id`: one refund request, and Cancel while it still waits. */
export function RefundRequestDetail({ portal, requestId }: { portal: PortalApi; requestId: string }) {
  const { t } = refundRequestsCopy.useCopy();
  const test = useTestMode();
  const valid = isUuid(requestId);
  const request = useResource(
    (s) => (valid ? portal.refundRequestGet(requestId, s) : Promise.resolve(localRefusal(t('rqNotFound')))),
    `money:refund-request:${requestId}`,
  );
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  async function cancel() {
    setBusy(true);
    setFailure(null);
    const result = await portal.refundRequestCancel(requestId);
    setBusy(false);
    setAsking(false);
    if (!result.ok) setFailure(result.code === 'pay.refund_request_closed' ? { ...result, message: t('rqClosed') } : result);
    request.reload();
  }
  return (
    <div className="stack">
      <Gate resource={request.resource} retry={request.reload} rows={4}>
        {(r) => (
          <>
            <DetailHeader
              back={{ href: '/pay/refunds', label: t('rqBack') }}
              title={<MoneyText value={r.amount} asset={r.assetId} test={test} />}
              status={<RefundRequestChip status={r.status} />}
              subtitle={t('rqTitle')}
              action={
                r.status === 'queued' ? (
                  <Button variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
                    {t('rqCancel')}
                  </Button>
                ) : undefined
              }
            />
            <TestBanner />
            {r.status === 'queued' && (
              <p className="pp-callout" role="note">
                {t('rqNothingYet')}
              </p>
            )}
            {failure && <PortalFailure result={failure} />}
            <PaySection title={t('rqFacts')}>
              <Facts
                items={[
                  [t('rqAmount'), <MoneyText value={r.amount} asset={r.assetId} test={test} />],
                  [t('rqAsked'), <DateTime value={r.createdAt} />],
                  ...(r.decidedAt ? ([[t('rqDecided'), <DateTime value={r.decidedAt} />]] as const) : []),
                  [t('rqReference'), <CopyReference value={r.refundId} what={t('rqReference')} />],
                ]}
              />
            </PaySection>
            <RelatedLinks links={[{ href: `/pay/payments/${encodeURIComponent(r.paymentId)}`, label: t('rqOpenPayment') }]} />
            {asking && (
              <Dialog closeLabel={t('rqClose')} title={t('rqCancelTitle')} onClose={() => setAsking(false)}>
                <div className="stack">
                  <p className="muted">{t('rqCancelBody')}</p>
                  <div className="pp-actions">
                    <Button variant="primary" disabled={busy} onClick={() => void cancel()}>
                      {t('rqCancel')}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
                      {t('rqKeep')}
                    </Button>
                  </div>
                </div>
              </Dialog>
            )}
          </>
        )}
      </Gate>
    </div>
  );
}

/** The refunds waiting for approval, on Approvals. Each is decided with the checker's own "Confirm it's you". */
export function RefundApprovals({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = refundRequestsCopy.useCopy();
  const money = mc.useCopy().t;
  const test = useTestMode();
  const names = useMemberNames(portal);
  const me = portal.userId;
  const waiting = useResource((s) => portal.refundRequests(merchantId, { status: 'queued' }, s), `money:refund-requests:${merchantId}`);
  // Items decided here stay on the page with their new status, so the checker sees what their decision did.
  const [decided, setDecided] = useState<ReadonlyMap<string, RefundRequest>>(new Map());
  const [open, setOpen] = useState<{ request: RefundRequest; decision: 'approve' | 'reject' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(new Map());
  const note = (id: string, words: string | null) =>
    setNotes((prev) => {
      const next = new Map(prev);
      if (words) next.set(id, words);
      else next.delete(id);
      return next;
    });

  async function start(request: RefundRequest, decision: 'approve' | 'reject') {
    note(request.id, null);
    if (me !== null && request.makerUserId === me) {
      note(request.id, t('rqSelf'));
      return;
    }
    // Money out: confirm it's them first. The decision dialog opens once that is done; nothing is sent before.
    if (!(await payStepUp.ensure('refund'))) {
      if (!payStepUp.canAsk) note(request.id, t('rqConfirmNeeded'));
      return;
    }
    setOpen({ request, decision });
  }
  async function decide() {
    if (!open) return;
    setBusy(true);
    const { request, decision } = open;
    let result = await portal.refundRequestDecide({ requestId: request.id, decision });
    if (!result.ok && result.code === 'pay.refund_step_up_expired') {
      payStepUp.drop('refund');
      if (await payStepUp.ensure('refund', true)) result = await portal.refundRequestDecide({ requestId: request.id, decision });
    }
    setBusy(false);
    setOpen(null);
    if (result.ok) {
      setDecided((prev) => new Map(prev).set(request.id, result.data));
      return;
    }
    note(
      request.id,
      result.code === 'pay.refund_approval_self'
        ? t('rqSelf')
        : result.code === 'pay.refund_request_closed'
          ? t('rqClosed')
          : result.message,
    );
  }

  const r = waiting.resource;
  const items =
    r.status === 'ready'
      ? [...decided.values()]
          .filter((d) => !r.data.items.some((i) => i.id === d.id))
          .concat(r.data.items.map((i) => decided.get(i.id) ?? i))
      : [];
  return (
    <PaySection title={t('rqSectionTitle')} description={t('rqSectionBody')}>
      {r.status === 'loading' ? (
        <PortalLoading rows={2} />
      ) : r.status === 'failed' ? (
        <PortalFailure result={r.failure} retry={waiting.reload} />
      ) : items.length === 0 ? (
        <p className="muted">{t('rqSectionEmpty')}</p>
      ) : (
        <ul className="pp-approvals" aria-label={t('rqSectionTitle')}>
          {items.map((item) => (
            <li key={item.id} className="pp-approval">
              <div className="pp-approval-head">
                <strong>{t('rqItem')}</strong>
                <MoneyText value={item.amount} asset={item.assetId} test={test} />
                <RefundRequestChip status={item.status} />
                <small className="muted">{t('rqAskedBy', { who: whoIs(item.makerUserId, me, names, money('mnMe')) })}</small>
                <DateTime value={item.createdAt} />
                <a className="text-link" href={refundRequestHref(item.id)}>
                  {t('rqTitle')}
                </a>
              </div>
              {item.status === 'queued' && (
                <div className="pp-actions">
                  <Button variant="primary" disabled={busy} onClick={() => void start(item, 'approve')}>
                    {t('rqApprove')}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void start(item, 'reject')}>
                    {t('rqReject')}
                  </Button>
                </div>
              )}
              {notes.get(item.id) && (
                <p role="alert" className="pp-callout pp-callout--warn">
                  {notes.get(item.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Dialog
          closeLabel={t('rqClose')}
          title={open.decision === 'approve' ? t('rqApproveTitle') : t('rqRejectTitle')}
          onClose={() => setOpen(null)}
        >
          <div className="stack">
            <MoneyText value={open.request.amount} asset={open.request.assetId} test={test} />
            <p className="muted">{open.decision === 'approve' ? t('rqApproveBody') : t('rqRejectBody')}</p>
            <div className="pp-actions">
              <Button variant="primary" disabled={busy} onClick={() => void decide()}>
                {open.decision === 'approve' ? t('rqApprove') : t('rqReject')}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(null)}>
                {t('rqClose')}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </PaySection>
  );
}
