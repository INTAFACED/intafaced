import { payCopy, PayCopy, payRefusal } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { displayAmount, parseAmount, formatAmount } from '../../shared/money';
import { Button, DataTable, Field } from '../../shared/ui';
import type { BusinessPayApi } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status } from './components';
import { validatedMutation, railHealthSchema } from './BusinessPay';
import * as s from './schemas';
import { MerchantRefund } from './MerchantRefund';

export function MerchantPayments({ pay, room }: { pay: BusinessPayApi; room: 'payments' | 'disputes' | 'reports' }) {
  const merchantId = pay.authority!.merchantId;
  const [limit, setLimit] = useState(50);
  const [status, setStatus] = useState('');
  // The portal's payment page links here with ?payment=<id> to refund or capture that payment.
  const [openedId, setOpenedId] = useState(() => {
    try {
      return room === 'payments' ? (new URLSearchParams(location.search).get('payment') ?? '') : '';
    } catch {
      return '';
    }
  });
  const payments = useResource(
    (signal) =>
      pay.query(
        'payment.list',
        { merchantId, limit, ...(room === 'disputes' ? { status: 'disputed' } : status ? { status } : {}) },
        z.array(s.paymentSchema),
        signal,
      ),
    `pay:payments:${merchantId}:${room}:${status}:${limit}`,
  );
  return (
    <div className="stack">
      {room === 'payments' && (
        <CreatePayment
          pay={pay}
          onCreated={(data) => {
            setOpenedId(data.id);
            payments.reload();
          }}
        />
      )}
      {room === 'disputes' && (
        <PayNotice title={payCopy.t('disputedPaymentRecords')}>
          <PayCopy k="thisListReadsPaymentsMarkedDisputedCase" />
        </PayNotice>
      )}
      {room === 'reports' && (
        <PayNotice title={payCopy.t('accountingExportScope')}>
          <PayCopy k="exportTheExactPaymentRowsLoadedBelow" />
        </PayNotice>
      )}
      <PaySection
        title={
          room === 'disputes'
            ? payCopy.t('disputedPayments')
            : room === 'reports'
              ? payCopy.t('paymentActivityExtract')
              : payCopy.t('payments')
        }
        action={
          <Button variant="secondary" onClick={payments.reload}>
            <PayCopy k="refreshPayments" />
          </Button>
        }
      >
        {room !== 'disputes' && (
          <label className="field pay-filter-select">
            <PayCopy k="paymentStatus" />
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setOpenedId('');
              }}
            >
              <option value="">{payCopy.t('allReturnedStates')}</option>
              {s.paymentSchema.shape.status.options.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
        )}
        <PayState
          resource={payments.resource}
          retry={payments.reload}
          empty={room === 'disputes' ? payCopy.t('noDisputedPaymentsReturned') : payCopy.t('noPaymentsReturned')}
        >
          {(rows) => (
            <>
              {room === 'reports' && (
                <Button variant="secondary" onClick={() => downloadPayments(rows)}>
                  <PayCopy k="exportRecords" params={{ count: rows.length }} />
                </Button>
              )}
              <DataTable
                label={payCopy.t('merchantPayments')}
                headers={[
                  payCopy.t('paymentCreated'),
                  payCopy.t('amount'),
                  payCopy.t('captured'),
                  payCopy.t('refunded'),
                  payCopy.t('status'),
                  '',
                ]}
              >
                {rows.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      {payment.id.slice(0, 8)}
                      <small className="pay-cell-note">{payment.createdAt}</small>
                    </td>
                    <td className="numeric">
                      {displayAmount(payment.amount)} {payment.assetId}
                    </td>
                    <td className="numeric">
                      {displayAmount(payment.capturedAmount)} {payment.assetId}
                    </td>
                    <td className="numeric">
                      {displayAmount(payment.refundedAmount)} {payment.assetId}
                    </td>
                    <td>
                      <Status value={payment.status} />
                      <small className="pay-cell-note">{payment.railAdapter}</small>
                    </td>
                    <td>
                      <Button variant="ghost" onClick={() => setOpenedId(payment.id)}>
                        <PayCopy k="open" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
      {openedId && (
        <PaymentDetail key={openedId} pay={pay} paymentId={openedId} refreshList={payments.reload} onBack={() => setOpenedId('')} />
      )}
    </div>
  );
}
function downloadPayments(rows: s.Payment[]) {
  const columns: (keyof s.Payment)[] = [
    'id',
    'merchantId',
    'amount',
    'assetId',
    'method',
    'railAdapter',
    'status',
    'capturedAmount',
    'refundedAmount',
    'createdAt',
  ];
  const cell = (value: unknown) =>
    `"${String(value ?? '')
      .replaceAll('"', '""')
      .replace(/^[=+@-]/, "'$&")}"`;
  const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => cell(row[key])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'merchant-payment-activity.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function CreatePayment({ pay, onCreated }: { pay: BusinessPayApi; onCreated: (payment: s.Payment) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState('');
  const [assetId, setAssetId] = useState('');
  const [method, setMethod] = useState('');
  const [railAdapter, setRailAdapter] = useState('');
  const [customerRef, setCustomerRef] = useState('');
  const merchantId = pay.authority!.merchantId;
  const rails = useResource(
    (signal) => pay.query('railHealth', undefined, railHealthSchema, signal),
    `pay:payment-create-rails:${merchantId}`,
  );
  const rail =
    rails.resource.status === 'ready'
      ? rails.resource.data.find(
          (row) => row.id === railAdapter && row.mode === 'live' && row.healthy && row.usable && row.capabilities.includes('authorize'),
        )
      : undefined;
  return (
    <PaySection
      title={payCopy.t('createAPayment')}
      description={payCopy.t('createAnIntentOnAConnectedLive')}
      action={
        <Button variant="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? payCopy.t('hideForm') : payCopy.t('newPayment')}
        </Button>
      }
    >
      {expanded && (
        <div className="form-stack pay-form">
          <div className="form-row">
            <Field
              label={payCopy.t('amount')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
            <Field
              label={payCopy.t('asset')}
              value={assetId}
              onChange={(event) => setAssetId(event.target.value.toUpperCase())}
              maxLength={16}
              required
            />
          </div>
          <Field
            label={payCopy.t('processorMethodIdentifier')}
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            hint={payCopy.t('useTheMethodSuppliedByYourConnected')}
            required
          />
          <label className="field">
            <PayCopy k="livePaymentRail" />
            <select value={railAdapter} onChange={(event) => setRailAdapter(event.target.value)}>
              <option value="">{payCopy.t('chooseAConnectedLiveRail')}</option>
              {rails.resource.status === 'ready' &&
                rails.resource.data
                  .filter((row) => row.mode === 'live' && row.healthy && row.usable && row.capabilities.includes('authorize'))
                  .map((row) => (
                    <option value={row.id} key={row.id}>
                      {row.id}
                    </option>
                  ))}
            </select>
          </label>
          <PayState resource={rails.resource} retry={rails.reload}>
            {(rows) =>
              !rows.some((row) => row.mode === 'live' && row.healthy && row.usable && row.capabilities.includes('authorize')) ? (
                <PayNotice title={payCopy.t('noLivePaymentRailAvailable')}>
                  <PayCopy k="aSandboxRailCannotBeUsedTo" />
                </PayNotice>
              ) : null
            }
          </PayState>
          <Field
            label={payCopy.t('customerReferenceOptional')}
            value={customerRef}
            onChange={(event) => setCustomerRef(event.target.value)}
            maxLength={128}
          />
          <ReviewedAction
            title={payCopy.t('createPaymentIntent')}
            variant="primary"
            description={payCopy.t('createAPaymentRecordForThisExact')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('amount'), `${amount} ${assetId}`],
                  [payCopy.t('method'), method],
                  [payCopy.t('rail'), railAdapter],
                ]}
              />
            }
            perform={() =>
              rail
                ? validatedMutation(
                    pay,
                    'payment.create',
                    { merchantId, amount, assetId, method, railAdapter, ...(customerRef ? { customerRef } : {}) },
                    z.object({
                      merchantId: s.id,
                      amount: s.positiveAmount,
                      assetId: s.asset,
                      method: z.string().min(1),
                      railAdapter: z.string().min(1),
                      customerRef: z.string().optional(),
                    }),
                    s.paymentSchema,
                    'pay:write',
                    'payment-create',
                  )
                : Promise.resolve(payRefusal('noEligibleLivePaymentRailWasVerified', { reason: 'not_supported' }))
            }
            onConfirmed={(data) => {
              onCreated(data);
              setExpanded(false);
            }}
            disabled={
              !amount ||
              !assetId ||
              !method ||
              !rail ||
              Boolean(pay.access('pay:write')) ||
              Boolean(pay.guard.status(`${pay.authority!.userId}:payment-create`))
            }
          />
        </div>
      )}
    </PaySection>
  );
}
function PaymentDetail({
  pay,
  paymentId,
  refreshList,
  onBack,
}: {
  pay: BusinessPayApi;
  paymentId: string;
  refreshList: () => void;
  onBack: () => void;
}) {
  const [limit, setLimit] = useState(50);
  const current = useResource(
    (signal) => pay.query('payment.get', { paymentId }, s.paymentSchema, signal),
    `pay:payment:${pay.authority!.merchantId}:${paymentId}`,
  );
  const history = useResource(
    (signal) => pay.query('payment.history', { paymentId, limit }, z.array(s.paymentEventSchema), signal),
    `pay:payment-history:${pay.authority!.merchantId}:${paymentId}:${limit}`,
  );
  function refresh() {
    current.reload();
    history.reload();
    refreshList();
  }
  const locked = Boolean(pay.guard.status(`${pay.authority!.userId}:payment:${paymentId}`));
  return (
    <PaySection
      title={payCopy.t('paymentDetails')}
      action={
        <Button variant="secondary" onClick={refresh}>
          <PayCopy k="refreshPaymentStatus" />
        </Button>
      }
    >
      <PayState resource={current.resource} retry={current.reload}>
        {(payment) => (
          <div className="form-stack">
            <PayDetails
              values={[
                [payCopy.t('payment'), payment.id],
                [payCopy.t('amount'), `${displayAmount(payment.amount)} ${payment.assetId}`],
                [payCopy.t('status'), <Status value={payment.status} />],
                [payCopy.t('rail'), payment.railAdapter],
                [payCopy.t('railReference'), payment.railRef ?? payCopy.t('notConfirmed')],
                [
                  payCopy.t('refundableCapturedAmount'),
                  `${displayAmount(formatAmount(parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount)))} ${payment.assetId}`,
                ],
              ]}
            />
            {locked && (
              <PayNotice title={payCopy.t('originalPaymentActionIsUnresolved')}>
                <PayCopy k="refreshPaymentStatusAndInspectTheHistory" />
              </PayNotice>
            )}
            <div className="actions">
              {payment.status === 'created' && (
                <ReviewedAction
                  title={payCopy.t('authorizePayment')}
                  description={payCopy.t('askTheConnectedRailToAuthorizeThis')}
                  perform={() => pay.mutate('payment.authorize', { paymentId }, s.paymentSchema, 'pay:write', `payment:${paymentId}`)}
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={refresh}
                />
              )}
              {payment.status === 'authorized' && (
                <ReviewedAction
                  title={payCopy.t('captureFullAmount')}
                  variant="primary"
                  description={payCopy.t('captureTheFullAuthorizedAmountPartialCapture')}
                  review={<PayDetails values={[[payCopy.t('capture'), `${displayAmount(payment.amount)} ${payment.assetId}`]]} />}
                  perform={() => pay.mutate('payment.capture', { paymentId }, s.paymentSchema, 'pay:write', `payment:${paymentId}`)}
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={refresh}
                />
              )}
            </div>
            <PaySection title={payCopy.t('recordedPaymentHistory')}>
              <PayState resource={history.resource} retry={history.reload} empty={payCopy.t('noPaymentHistoryReturned')}>
                {(events) => (
                  <>
                    <div className="pay-timeline">
                      {events.map((event) => (
                        <div key={event.id}>
                          <span>{event.event}</span>
                          <small className="muted">{event.ts}</small>
                        </div>
                      ))}
                    </div>
                    <PayPagination count={events.length} limit={limit} setLimit={setLimit} />
                  </>
                )}
              </PayState>
            </PaySection>
          </div>
        )}
      </PayState>
      <MerchantRefund pay={pay} paymentId={paymentId} onRecorded={refresh} onBack={onBack} />
    </PaySection>
  );
}
