import { useMemo, useState } from 'react';
import { useSession } from '../../../session/session';
import { reason } from '../chrome/copy';
import { useResource, type Resource } from '../../../../shared/resource';
import { StatusTag, Button, DataTable, EmptyState, Field } from '@intafaced/ui';
import { PaySection, PayTime } from '../../components';
import { MerchantRefund } from '../../MerchantRefund';
import { ExactMoneyScope } from '../ui/ExactMoneyScope';
import { createBusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { BackLink, NotLive, Facts, Gate, Kpi, KpiGrid, Money, ReadAt, SelectField, Timeline } from '../components';
import { buildCsv, downloadText } from '../csv';
import { useNow, useReadAt, useUrlParam } from '../hooks';
import { isUuid, paymentRefunds, type PaymentRefund } from '../model';
import { parseAmount, formatAmount } from '../../../../shared/money';
import type { PortalApi } from '../api';
import type { Payment, PaymentEvent } from '../schemas';
import { w3cCopy } from './copy';

type RefundData = { payment: Payment; history: PaymentEvent[] };
export const refundHref = (paymentId: string, refundId: string) =>
  `/pay/refunds/${encodeURIComponent(refundId)}?payment=${encodeURIComponent(paymentId)}`;

function useRefundData(portal: PortalApi, paymentId: string) {
  const query = useResource(async (signal) => {
    const payment = await portal.payment(paymentId, signal);
    if (!payment.ok) return payment;
    const history = await portal.paymentHistory(paymentId, signal);
    if (!history.ok) return history;
    return { ok: true as const, data: { payment: payment.data, history: history.data } };
  }, `portal:refund-history:${paymentId}`);
  return query;
}

/** Account-wide reads do not exist yet. An exact original payment is the only authoritative lookup. */
export function Refunds({
  portal,
  refundId,
  create = false,
  authority,
}: {
  portal: PortalApi;
  refundId?: string;
  create?: boolean;
  authority: PayBusinessAuthority | null;
}) {
  const { t } = w3cCopy.useCopy();
  const [paymentId, setPaymentId] = useUrlParam('payment', '');
  const [input, setInput] = useState(paymentId);
  const [tried, setTried] = useState(false);
  return (
    <div className="stack">
      <BackLink href={refundId || create ? '/pay/refunds' : '/pay/merchant'}>
        {t(refundId || create ? 'backRefunds' : 'backMerchant')}
      </BackLink>
      {!create && !refundId && <NotLive reason={reason('reasonLists')}>{t('refundListGap')}</NotLive>}
      {refundId && !paymentId && <NotLive reason={reason('reasonLists')}>{t('refundIdGap')}</NotLive>}
      <PaySection title={t('choosePayment')}>
        <form
          className="form-stack pp-form"
          onSubmit={(event) => {
            event.preventDefault();
            setTried(true);
            if (isUuid(input.trim())) setPaymentId(input.trim());
          }}
          noValidate
        >
          <Field
            label={`${t('paymentId')} *`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            hint={t('paymentHint')}
            error={tried && !isUuid(input.trim()) ? t('paymentInvalid') : undefined}
            required
          />
          <Button type="submit" variant="secondary">
            {t('lookup')}
          </Button>
        </form>
        <a className="text-link" href="/pay/payments">
          {t('openPayments')}
        </a>
      </PaySection>
      {isUuid(paymentId) ? (
        <RefundResults key={paymentId} portal={portal} paymentId={paymentId} refundId={refundId} create={create} authority={authority} />
      ) : (
        !refundId && <EmptyState title={t('choosePayment')}>{t('chooseBody')}</EmptyState>
      )}
    </div>
  );
}

function RefundResults({
  portal,
  paymentId,
  refundId,
  create,
  authority,
}: {
  portal: PortalApi;
  paymentId: string;
  refundId?: string;
  create: boolean;
  authority: PayBusinessAuthority | null;
}) {
  const { t } = w3cCopy.useCopy();
  const query = useRefundData(portal, paymentId);
  const readAt = useReadAt(query.resource.status === 'ready', query.resource);
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  if (create)
    return (
      <Gate resource={query.resource} retry={query.reload}>
        {(data) => (
          <div className="stack">
            <Facts
              items={[
                [
                  t('paymentId'),
                  <a className="pp-mono pp-copy" href={`/pay/payments/${encodeURIComponent(paymentId)}`}>
                    {paymentId}
                  </a>,
                ],
                [t('amount'), <Money value={data.payment.capturedAmount} asset={data.payment.assetId} />],
              ]}
            />
            <NotLive reason={reason('reasonHistory')}>{t('refundAuditGap')}</NotLive>
            {authority ? (
              <ExactMoneyScope>
                <MerchantRefund
                  pay={pay}
                  paymentId={paymentId}
                  onRecorded={query.reload}
                  onBack={() => {
                    window.location.href = `/pay/refunds?payment=${encodeURIComponent(paymentId)}`;
                  }}
                />
              </ExactMoneyScope>
            ) : (
              <NotLive reason={reason('reasonOwner')}>{t('refundAuthorityGap')}</NotLive>
            )}
          </div>
        )}
      </Gate>
    );
  return <RefundHistoryView resource={query.resource} retry={query.reload} loadedAt={readAt} refundId={refundId} />;
}

export function RefundHistoryView({
  resource,
  retry,
  loadedAt,
  refundId,
}: {
  resource: Resource<RefundData>;
  retry: () => void;
  loadedAt: string | null;
  refundId?: string;
}) {
  const { t } = w3cCopy.useCopy();
  const [status, setStatus] = useUrlParam('status', '');
  const [sort, setSort] = useUrlParam('sort', 'newest');
  const now = useNow();
  return (
    <Gate resource={resource} retry={retry}>
      {({ payment, history }) => {
        const refunds = paymentRefunds(history);
        const one = refunds.find((row) => row.refundId === refundId);
        if (refundId && !one) return <EmptyState title={t('notFound')}>{t('notFoundBody')}</EmptyState>;
        const rows = refunds
          .filter((row) => !status || row.state === status)
          .sort((a, b) => (sort === 'oldest' ? 1 : -1) * (Date.parse(a.at) - Date.parse(b.at)));
        const sum = refunds
          .filter((r) => r.state === 'completed')
          .reduce((total, row) => total + (row.amount === null ? 0n : parseAmount(row.amount)), 0n);
        const completeAmounts = refunds.filter((r) => r.state === 'completed').every((r) => r.amount !== null);
        return (
          <div className="stack">
            <ReadAt at={loadedAt} />
            {loadedAt && now - Date.parse(loadedAt) > 300_000 && (
              <p className="pp-callout" role="status">
                {t('staleRecords')}
              </p>
            )}
            <p className="pp-callout">{t('limitedHistory')}</p>
            <div className="pp-actions">
              <a className="text-link" href={`/pay/payments/${encodeURIComponent(payment.id)}`}>
                {t('originalPayment')}
              </a>
              <a className="text-link" href={`/pay/refunds/new?payment=${encodeURIComponent(payment.id)}`}>
                {t('issueRefund')}
              </a>
              <Button variant="secondary" onClick={retry}>
                {t('lookup')}
              </Button>
            </div>
            {one ? (
              <>
                <Facts
                  items={[
                    [t('refundId'), <span className="pp-mono pp-copy">{one.refundId}</span>],
                    [t('status'), <RefundChip state={one.state} />],
                    [t('amount'), one.amount === null ? '—' : <Money value={one.amount} asset={payment.assetId} />],
                    [t('recorded'), <PayTime value={one.at} />],
                  ]}
                />
                <PaySection title={t('refundHistory')}>
                  <Timeline
                    label={t('refundHistory')}
                    items={history
                      .filter(
                        (e) =>
                          ['refund.posted', 'refunded', 'refund.reversed'].includes(e.event) &&
                          'payload' in e &&
                          e.payload.refundId === refundId,
                      )
                      .map((e) => ({
                        at: e.ts,
                        title: t(
                          e.event === 'refund.posted' ? 'refundPosted' : e.event === 'refunded' ? 'refundConfirmed' : 'refundReversed',
                        ),
                      }))}
                  />
                </PaySection>
                <NotLive reason={reason('reasonHistory')}>{t('refundAuditGap')}</NotLive>
              </>
            ) : (
              <>
                <KpiGrid label={t('refundsTitle')}>
                  <Kpi label={t('count')} period={t('historyPeriod')} value={refunds.length} href={`?payment=${payment.id}`} />
                  <Kpi
                    label={t('returned')}
                    period={t('historyPeriod')}
                    value={completeAmounts ? <Money value={formatAmount(sum)} asset={payment.assetId} /> : '—'}
                    href={`?payment=${payment.id}&status=completed`}
                  />
                  <Kpi
                    label={t('pending')}
                    period={t('historyPeriod')}
                    value={refunds.filter((r) => r.state === 'in_progress').length}
                    href={`?payment=${payment.id}&status=in_progress`}
                  />
                  <Kpi
                    label={t('reversedCount')}
                    period={t('historyPeriod')}
                    value={refunds.filter((r) => r.state === 'reversed').length}
                    href={`?payment=${payment.id}&status=reversed`}
                  />
                </KpiGrid>
                <div className="pp-filter-row">
                  <SelectField
                    label={t('filterStatus')}
                    value={status}
                    onChange={setStatus}
                    options={['', 'completed', 'in_progress', 'reversed'].map(
                      (value) => [value, value ? t(value as PaymentRefund['state']) : t('allStatuses')] as const,
                    )}
                  />
                  <SelectField
                    label={t('sort')}
                    value={sort}
                    onChange={setSort}
                    options={[
                      ['newest', t('newest')],
                      ['oldest', t('oldest')],
                    ]}
                  />
                </div>
                <p>{t('countShown', { count: rows.length })}</p>
                {rows.length ? (
                  <>
                    <DataTable label={t('refundsTitle')} headers={[t('refundId'), t('amount'), t('status'), t('recorded')]}>
                      {rows.map((row) => (
                        <tr key={row.refundId}>
                          <td>
                            <a className="text-link pp-mono" href={refundHref(payment.id, row.refundId)}>
                              {row.refundId}
                            </a>
                          </td>
                          <td>{row.amount === null ? '—' : <Money value={row.amount} asset={payment.assetId} />}</td>
                          <td>
                            <RefundChip state={row.state} />
                          </td>
                          <td>
                            <PayTime value={row.at} />
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        downloadText(
                          'payment-refunds.csv',
                          buildCsv(
                            ['payment_id', 'refund_id', 'amount', 'asset', 'status', 'first_recorded'],
                            rows.map((r) => [payment.id, r.refundId, r.amount ?? '', payment.assetId, r.state, r.at]),
                            { generatedAt: new Date().toISOString(), asOf: loadedAt ?? '' },
                          ),
                        )
                      }
                    >
                      {t('downloadRefunds')}
                    </Button>
                  </>
                ) : (
                  <EmptyState title={t('noRefunds')}>{refunds.length ? t('noMatches') : t('noRefundsBody')}</EmptyState>
                )}
              </>
            )}
          </div>
        );
      }}
    </Gate>
  );
}
function RefundChip({ state }: { state: PaymentRefund['state'] }) {
  const { t } = w3cCopy.useCopy();
  return (
    <StatusTag
      status={state === 'completed' ? 'filled' : state === 'reversed' ? 'failed' : 'pending'}
      title={t(state === 'completed' ? 'completedTip' : state === 'reversed' ? 'reversedTip' : 'in_progressTip')}
      label={t(state)}
    />
  );
}
