// volt-room: /pay/refunds/new
// volt-room: portal:refund-new
import { useMemo, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { useSession } from '../../../session';
import { useResource } from '../../../../shared/resource';
import { createBusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { MerchantRefund } from '../../MerchantRefund';
import type { PortalApi } from '../api';
import { useUrlParam } from '../hooks';
import { isUuid } from '../model';
import type { paymentSchema } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { ExactMoneyScope } from '../ui/ExactMoneyScope';
import { uiCopy } from '../ui/copy';
import { FlowRoom } from '../volt/FlowRoom';
import { Empty, Facts, Failure, Gate, LinkButton, Loading, MoneyText, Section } from '../volt/parts';
import { TestBanner } from './kit-parts';
import { shortDay } from './money-words';
import { useTestMode } from './test-mode';
import { mc } from './copy';
import { useMoneyReason } from '../access/MoneyAction';
import { refundableAmount } from './model';
import type { z } from 'zod';
import { leaveTo } from '../../../../app/location';

type Payment = z.infer<typeof paymentSchema>;

/** `/pay/refunds/new` on the flow template: the owner alone issues refunds. */
export function RefundNewRoom({ portal, authority }: { portal: PortalApi; authority: PayBusinessAuthority | null }) {
  return (
    <FlowRoom need="owner">{({ merchantId }) => <RefundNew portal={portal} merchantId={merchantId} authority={authority} />}</FlowRoom>
  );
}

/** `/pay/refunds/new`: choose the payment, see what can still go back, then refund it. `?payment=` starts at step two. */
function RefundNew({ portal, merchantId, authority }: { portal: PortalApi; merchantId: string; authority: PayBusinessAuthority | null }) {
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
    <Section title={t('rnStep1')} description={t('rnStep1Body')}>
      <form
        className="lt-field-row"
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
        <p className="lt-callout lt-callout-warn" role="note">
          {off}
        </p>
      )}
      {found.resource.status === 'loading' ? (
        <Loading rows={3} />
      ) : found.resource.status === 'failed' ? (
        <Failure result={found.resource.failure} retry={found.reload} />
      ) : found.resource.data.items.filter(refundable).length === 0 ? (
        <Empty title={t('rnNoneTitle')} action={<LinkButton href="/pay/payments">{t('rnNoneAction')}</LinkButton>}>
          {t('rnNoneBody')}
        </Empty>
      ) : (
        <ul className="lt-list" aria-label={t('rnStep1')}>
          {found.resource.data.items.filter(refundable).map((p) => (
            <li key={p.id} className="lt-row lt-row-between">
              <div className="lt-stack-tight">
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
    </Section>
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
      <Section title={t('rnStep2')} description={t('rnStep2Body')}>
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
                <p className="lt-hint">{t('rnReasonNote')}</p>
                <Button tone="quiet" onClick={onChange}>
                  {t('rnChangePayment')}
                </Button>
              </>
            );
          }}
        </Gate>
      </Section>
      <Section title={t('rnStep3')} description={t('rnStep3Body')}>
        {authority ? (
          <ExactMoneyScope>
            <MerchantRefund
              pay={pay}
              paymentId={paymentId}
              onRecorded={payment.reload}
              onBack={() => {
                leaveTo(`/pay/refunds?payment=${encodeURIComponent(paymentId)}`);
              }}
            />
          </ExactMoneyScope>
        ) : (
          <p className="lt-callout" role="note">
            {t('rnOwnerOnly')}
          </p>
        )}
      </Section>
    </>
  );
}
