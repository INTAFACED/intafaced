import { useMemo, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { EmptyState, Field } from '../../ui-kit';
import { useSession } from '../../../session';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { createBusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { MerchantRefund } from '../../MerchantRefund';
import { Facts, Gate, PortalFailure, PortalLoading } from '../components';
import type { PortalApi } from '../api';
import { useUrlParam } from '../hooks';
import { isUuid } from '../model';
import type { paymentSchema } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { ExactMoneyScope } from '../ui/ExactMoneyScope';
import { MoneyText } from '../ui/MoneyText';
import { uiCopy } from '../ui/copy';
import { LinkButton, shortDay, TestBanner, useTestMode } from './common';
import { mc } from './copy';
import { useMoneyReason } from '../access/MoneyAction';
import { refundableAmount } from './model';
import type { z } from 'zod';

type Payment = z.infer<typeof paymentSchema>;

/** `/pay/refunds/new`: choose the payment, see what can still go back, then refund it. `?payment=` starts at step two. */
export function RefundNew({
  portal,
  merchantId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  authority: PayBusinessAuthority | null;
}) {
  const { t } = mc.useCopy();
  const [paymentId, setPaymentId] = useUrlParam('payment', '');
  return (
    <div className="lt-stack">
      <a className="lt-link" href="/pay/refunds">
        {t('backRefunds')}
      </a>
      <TestBanner />
      {isUuid(paymentId) ? (
        <RefundStep key={paymentId} portal={portal} paymentId={paymentId} authority={authority} onChange={() => setPaymentId('')} />
      ) : (
        <PickPayment portal={portal} merchantId={merchantId} onPick={setPaymentId} />
      )}
    </div>
  );
}

function PickPayment({ portal, merchantId, onPick }: { portal: PortalApi; merchantId: string; onPick: (id: string) => void }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const found = useResource((s) => portal.refundablePayments(merchantId, search, s), `money:refundable:${merchantId}:${search}`);
  const off = useMoneyReason('refund');
  const refundable = (p: Payment) =>
    ['captured', 'settled', 'refunded'].includes(p.status) && refundableAmount(p.capturedAmount, p.refundedAmount) !== '0';
  return (
    <PaySection title={t('rnStep1')} description={t('rnStep1Body')}>
      <form
        className="pp-filter-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(typed.trim());
        }}
      >
        <Field label={t('rnSearch')} value={typed} onChange={(e) => setTyped(e.target.value)} hint={t('rnSearchHint')} />
        <Button type="submit" tone="secondary">
          {t('rnFind')}
        </Button>
      </form>
      {off && (
        <p className="pp-callout pp-callout--warn" role="note">
          {off}
        </p>
      )}
      {found.resource.status === 'loading' ? (
        <PortalLoading rows={3} />
      ) : found.resource.status === 'failed' ? (
        <PortalFailure result={found.resource.failure} retry={found.reload} />
      ) : found.resource.data.items.filter(refundable).length === 0 ? (
        <EmptyState title={t('rnNoneTitle')} action={<LinkButton href="/pay/payments">{t('rnNoneAction')}</LinkButton>}>
          {t('rnNoneBody')}
        </EmptyState>
      ) : (
        <ul className="pp-approvals" aria-label={t('rnStep1')}>
          {found.resource.data.items.filter(refundable).map((p) => (
            <li key={p.id} className="pp-approval">
              <div className="pp-approval-head">
                <strong>
                  {p.customerRef?.trim() || p.description?.trim() || t('paymentName', { when: shortDay(p.createdAt, locale) })}
                </strong>
                <MoneyText value={p.capturedAmount} asset={p.assetId} test={test} />
                <small className="lt-muted">
                  {t('rnRefundable')}{' '}
                  <MoneyText value={refundableAmount(p.capturedAmount, p.refundedAmount)} asset={p.assetId} test={test} />
                </small>
                <DateTime value={p.createdAt} />
              </div>
              <Button tone="secondary" disabled={off !== null} onClick={() => onPick(p.id)}>
                {t('rnChoose')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </PaySection>
  );
}

function RefundStep({
  portal,
  paymentId,
  authority,
  onChange,
}: {
  portal: PortalApi;
  paymentId: string;
  authority: PayBusinessAuthority | null;
  onChange: () => void;
}) {
  const { t } = mc.useCopy();
  const test = useTestMode();
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const payment = useResource((s) => portal.payment(paymentId, s), `money:refund-payment:${paymentId}`);
  return (
    <>
      <PaySection title={t('rnStep2')} description={t('rnStep2Body')}>
        <Gate resource={payment.resource} retry={payment.reload} rows={3}>
          {(p) => {
            const left = refundableAmount(p.capturedAmount, p.refundedAmount);
            const source = p.status === 'captured' ? t('rfSource_clearing') : t('rfSource_settled');
            return (
              <>
                <Facts
                  items={[
                    [
                      t('mnColPayment'),
                      <a className="lt-link" href={`/pay/payments/${encodeURIComponent(p.id)}`}>
                        {p.customerRef?.trim() || p.description?.trim() || t('rnOpenPayment')}
                      </a>,
                    ],
                    [t('rnCaptured'), <MoneyText value={p.capturedAmount} asset={p.assetId} test={test} />],
                    [t('rnAlready'), <MoneyText value={p.refundedAmount} asset={p.assetId} test={test} />],
                    [t('rnRefundable'), <MoneyText value={left} asset={p.assetId} test={test} />],
                    [t('rfFrom'), source],
                  ]}
                />
                <p className="muted pp-note">{t('rnReasonNote')}</p>
                <Button tone="quiet" onClick={onChange}>
                  {t('rnChangePayment')}
                </Button>
              </>
            );
          }}
        </Gate>
      </PaySection>
      <PaySection title={t('rnStep3')} description={t('rnStep3Body')}>
        {authority ? (
          <ExactMoneyScope>
            <MerchantRefund
              pay={pay}
              paymentId={paymentId}
              onRecorded={payment.reload}
              onBack={() => {
                window.location.href = `/pay/refunds?payment=${encodeURIComponent(paymentId)}`;
              }}
            />
          </ExactMoneyScope>
        ) : (
          <p className="pp-callout" role="note">
            {t('rnOwnerOnly')}
          </p>
        )}
      </PaySection>
    </>
  );
}
