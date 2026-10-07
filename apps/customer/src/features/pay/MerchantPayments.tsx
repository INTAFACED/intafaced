import { useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { displayAmount, parseAmount, formatAmount } from '../../shared/money';
import { Button, DataTable, Field } from '../../shared/ui';
import type { BusinessPayApi } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status } from './components';
import { validatedMutation, railHealthSchema } from './BusinessPay';
import * as s from './schemas';

export function MerchantPayments({ pay, room }: { pay: BusinessPayApi; room: 'payments' | 'disputes' | 'reports' }) {
  const merchantId = pay.authority!.merchantId;
  const [limit, setLimit] = useState(50);
  const [status, setStatus] = useState('');
  const [openedId, setOpenedId] = useState('');
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
        <PayNotice title="Disputed payment records">
          This list reads payments marked disputed. Case opening and adjudication are treasury procedures, so they are not merchant
          controls. A merchant evidence submission or case-status read is not published.
        </PayNotice>
      )}
      {room === 'reports' && (
        <PayNotice title="Accounting export scope">
          Export the exact payment rows loaded below. This is an activity extract, not a complete accounting report. The service has no
          continuation cursor, tax report or accounting pack endpoint.
        </PayNotice>
      )}
      <PaySection
        title={room === 'disputes' ? 'Disputed payments' : room === 'reports' ? 'Payment activity extract' : 'Payments'}
        action={
          <Button variant="secondary" onClick={payments.reload}>
            Refresh payments
          </Button>
        }
      >
        {room !== 'disputes' && (
          <label className="field pay-filter-select">
            Payment status
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setOpenedId('');
              }}
            >
              <option value="">All returned states</option>
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
          empty={room === 'disputes' ? 'No disputed payments returned' : 'No payments returned'}
        >
          {(rows) => (
            <>
              {room === 'reports' && (
                <Button variant="secondary" onClick={() => downloadPayments(rows)}>
                  Export these {rows.length} records as CSV
                </Button>
              )}
              <DataTable label="Merchant payments" headers={['Payment / created', 'Amount', 'Captured', 'Refunded', 'Status', '']}>
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
                        Open
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
      {openedId && <PaymentDetail key={openedId} pay={pay} paymentId={openedId} refreshList={payments.reload} />}
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
      title="Create a payment"
      description="Create an intent on a connected live rail, then authorize and capture its actual record."
      action={
        <Button variant="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Hide form' : 'New payment'}
        </Button>
      }
    >
      {expanded && (
        <div className="form-stack pay-form">
          <div className="form-row">
            <Field label="Amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            <Field
              label="Asset"
              value={assetId}
              onChange={(event) => setAssetId(event.target.value.toUpperCase())}
              maxLength={16}
              required
            />
          </div>
          <Field
            label="Processor method identifier"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            hint="Use the method supplied by your connected processor. The service validates method support; no instrument is invented."
            required
          />
          <label className="field">
            Live payment rail
            <select value={railAdapter} onChange={(event) => setRailAdapter(event.target.value)}>
              <option value="">Choose a connected live rail</option>
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
                <PayNotice title="No live payment rail available">
                  A sandbox rail cannot be used to create a live payment. The server has not returned an eligible live authorizing rail.
                </PayNotice>
              ) : null
            }
          </PayState>
          <Field
            label="Customer reference (optional)"
            value={customerRef}
            onChange={(event) => setCustomerRef(event.target.value)}
            maxLength={128}
          />
          <ReviewedAction
            title="Create payment intent"
            variant="primary"
            description="Create a payment record for this exact amount. This does not claim the payment is captured. The server checks business eligibility and live rail posture."
            review={
              <PayDetails
                values={[
                  ['Amount', `${amount} ${assetId}`],
                  ['Method', method],
                  ['Rail', railAdapter],
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
                : Promise.resolve({
                    ok: false as const,
                    reason: 'not_supported' as const,
                    message: 'No eligible live payment rail was verified.',
                  })
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
function PaymentDetail({ pay, paymentId, refreshList }: { pay: BusinessPayApi; paymentId: string; refreshList: () => void }) {
  const [limit, setLimit] = useState(50);
  const [refund, setRefund] = useState('');
  const [refundId, setRefundId] = useState(() => `refund:${paymentId}:${crypto.randomUUID()}`);
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
      title="Payment details"
      action={
        <Button variant="secondary" onClick={refresh}>
          Refresh payment status
        </Button>
      }
    >
      <PayState resource={current.resource} retry={current.reload}>
        {(payment) => (
          <div className="form-stack">
            <PayDetails
              values={[
                ['Payment', payment.id],
                ['Amount', `${displayAmount(payment.amount)} ${payment.assetId}`],
                ['Status', <Status value={payment.status} />],
                ['Rail', payment.railAdapter],
                ['Rail reference', payment.railRef ?? 'Not confirmed'],
                [
                  'Refundable captured amount',
                  `${displayAmount(formatAmount(parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount)))} ${payment.assetId}`,
                ],
              ]}
            />
            {locked && (
              <PayNotice title="Original payment action is unresolved">
                Refresh payment status and inspect the history. No new financial action can start on this payment while the original outcome
                is unknown.
              </PayNotice>
            )}
            <div className="actions">
              {payment.status === 'created' && (
                <ReviewedAction
                  title="Authorize payment"
                  description="Ask the connected rail to authorize this exact payment. An authorization alone is not capture."
                  perform={() => pay.mutate('payment.authorize', { paymentId }, s.paymentSchema, 'pay:write', `payment:${paymentId}`)}
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={refresh}
                />
              )}
              {payment.status === 'authorized' && (
                <ReviewedAction
                  title="Capture full amount"
                  variant="primary"
                  description="Capture the full authorized amount. Partial capture is unsupported by the current payment service."
                  review={<PayDetails values={[['Capture', `${displayAmount(payment.amount)} ${payment.assetId}`]]} />}
                  perform={() => pay.mutate('payment.capture', { paymentId }, s.paymentSchema, 'pay:write', `payment:${paymentId}`)}
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={refresh}
                />
              )}
            </div>
            {['captured', 'settled', 'refunded'].includes(payment.status) &&
              parseAmount(payment.capturedAmount) > parseAmount(payment.refundedAmount) && (
                <>
                  <Field
                    label={`Refund amount · ${payment.assetId}`}
                    value={refund}
                    inputMode="decimal"
                    onChange={(event) => setRefund(event.target.value)}
                  />
                  <ReviewedAction
                    title="Refund payment"
                    description="Refund the reviewed captured quantity through the original payment. The stable refund reference is retained if the response is lost."
                    review={
                      <PayDetails
                        values={[
                          ['Refund', `${refund} ${payment.assetId}`],
                          ['Refund identity', refundId],
                        ]}
                      />
                    }
                    perform={() => {
                      const parsed = s.positiveAmount.safeParse(refund);
                      if (
                        !parsed.success ||
                        parseAmount(refund) > parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount)
                      )
                        return Promise.resolve({
                          ok: false as const,
                          reason: 'error' as const,
                          message: 'Enter an exact positive amount no greater than the remaining captured amount.',
                        });
                      return pay.mutate(
                        'payment.refund',
                        { paymentId, amount: refund, refundId },
                        s.paymentSchema,
                        'pay:refund',
                        `payment:${paymentId}`,
                      );
                    }}
                    disabled={!refund || locked || Boolean(pay.access('pay:refund'))}
                    onConfirmed={() => {
                      setRefund('');
                      setRefundId(`refund:${paymentId}:${crypto.randomUUID()}`);
                      refresh();
                    }}
                  />
                </>
              )}
            <PaySection title="Recorded payment history">
              <PayState resource={history.resource} retry={history.reload} empty="No payment history returned">
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
    </PaySection>
  );
}
