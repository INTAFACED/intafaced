import { useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, Field } from '../../shared/ui';
import type { BusinessPayApi } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status } from './components';
import { validatedMutation } from './BusinessPay';
import * as s from './schemas';

export function MerchantBilling({ pay, invoices }: { pay: BusinessPayApi; invoices: boolean }) {
  const merchantId = pay.authority!.merchantId;
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState('');
  const [mandateId, setMandateId] = useState('');
  const [path, setPath] = useState('');
  const [projectedEnd, setProjectedEnd] = useState<string | null | undefined>();
  const mandates = useResource(
    (signal) => pay.query('mandate.list', { merchantId, limit }, z.array(s.mandateSchema), signal),
    `pay:mandates:${merchantId}:${limit}`,
  );
  const subscriptions = useResource(
    (signal) => pay.query('subscription.list', { merchantId, limit }, z.array(s.subscriptionSchema), signal),
    `pay:subscriptions:${merchantId}:${limit}`,
  );
  const posture = useResource(
    (signal) => pay.query('subscription.productReady', undefined, s.subscriptionPostureSchema, signal),
    `pay:subscription-posture:${merchantId}`,
  );
  function refresh() {
    mandates.reload();
    subscriptions.reload();
  }
  return (
    <div className="stack">
      <PaySection title="Billing availability">
        <PayState resource={posture.resource} retry={posture.reload}>
          {(data) => (
            <>
              <PayNotice title="Recurring charge posture">
                {data.paths.map((item) => `${item.path}: ${item.posture}`).join(' · ')}. Card mandate charging is refused with{' '}
                {data.card.code}.
              </PayNotice>
              <PayNotice title="Pre-charge notice is not connected">
                {data.preChargeNotify.merchantReadable} Customers have not been notified by this service.
              </PayNotice>
            </>
          )}
        </PayState>
      </PaySection>
      {invoices ? (
        <PayNotice title="Standalone invoicing is unavailable">
          There is no independent invoice create, list or delivery contract. The recorded subscription executions below show actual
          generated payment references and their outcomes. Internal invoice runners are not customer controls.
        </PayNotice>
      ) : (
        <>
          <CreateMandate pay={pay} refresh={refresh} />
          <PaySection title="Start a subscription" description="Use an existing mandate and a path reported by the service.">
            <div className="form-stack pay-form">
              <label className="field">
                Active mandate
                <select value={mandateId} onChange={(event) => setMandateId(event.target.value)}>
                  <option value="">Choose a mandate</option>
                  {mandates.resource.status === 'ready' &&
                    mandates.resource.data
                      .filter((mandate) => mandate.status === 'active')
                      .map((mandate) => (
                        <option key={mandate.id} value={mandate.id}>
                          {mandate.customerId} · {mandate.amount} {mandate.assetId} · {mandate.cadence}
                        </option>
                      ))}
                </select>
              </label>
              <label className="field">
                Subscription charge path
                <select value={path} onChange={(event) => setPath(event.target.value)}>
                  <option value="">Choose a supported path</option>
                  {posture.resource.status === 'ready' &&
                    posture.resource.data.paths
                      .filter((row) => row.charge !== 'refuse')
                      .map((row) => (
                        <option value={row.path} key={row.path}>
                          {row.path} · {row.posture}
                        </option>
                      ))}
                </select>
              </label>
              <ReviewedAction
                title="Create subscription"
                description="Create the schedule under the existing customer mandate. This does not fire a charge. A missing rail, fee, notification or mandate permission will remain a named service refusal."
                review={
                  <PayDetails
                    values={[
                      ['Mandate', mandateId],
                      ['Path', path],
                    ]}
                  />
                }
                perform={() =>
                  validatedMutation(
                    pay,
                    'subscription.create',
                    { mandateId, path },
                    z.object({ mandateId: s.id, path: z.enum(['crypto_invoice', 'card', 'card_mandate']) }),
                    s.subscriptionSchema,
                    'pay:write',
                    'subscription-create',
                  )
                }
                disabled={!mandateId || !path || Boolean(pay.access('pay:write'))}
                onConfirmed={(data) => {
                  setSelected(data.id);
                  refresh();
                }}
              />
            </div>
          </PaySection>
        </>
      )}
      <PaySection
        title={invoices ? 'Subscription invoice sources' : 'Subscriptions'}
        action={
          <Button variant="secondary" onClick={refresh}>
            Refresh billing
          </Button>
        }
      >
        <PayState resource={subscriptions.resource} retry={subscriptions.reload} empty="No subscriptions returned">
          {(rows) => (
            <>
              <DataTable label="Subscriptions" headers={['Customer / subscription', 'Charge path', 'Next run', 'State / reason', '']}>
                {rows.map((subscription) => (
                  <tr key={subscription.id}>
                    <td>
                      {subscription.customerId}
                      <small className="pay-cell-note">{subscription.id}</small>
                    </td>
                    <td>{subscription.path}</td>
                    <td>{subscription.nextRunAt}</td>
                    <td>
                      <Status value={subscription.status} />
                      <small className="pay-cell-note">{subscription.stallReason ?? 'No stall reason returned'}</small>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSelected(subscription.id);
                          setProjectedEnd(undefined);
                        }}
                      >
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
      {selected && (
        <SubscriptionDetail
          key={selected}
          pay={pay}
          subscriptionId={selected}
          refresh={refresh}
          projectedEnd={projectedEnd}
          setProjectedEnd={setProjectedEnd}
        />
      )}
      {!invoices && (
        <PaySection title="Customer mandates">
          <PayState resource={mandates.resource} retry={mandates.reload} empty="No mandates returned">
            {(rows) => (
              <>
                <DataTable label="Mandates" headers={['Customer', 'Authorized amount', 'Ceiling', 'Cadence / window', 'Status', '']}>
                  {rows.map((mandate) => (
                    <tr key={mandate.id}>
                      <td>{mandate.customerId}</td>
                      <td className="numeric">
                        {displayAmount(mandate.amount)} {mandate.assetId}
                      </td>
                      <td className="numeric">
                        {mandate.ceiling === null ? 'No ceiling supplied' : `${displayAmount(mandate.ceiling)} ${mandate.assetId}`}
                      </td>
                      <td>
                        {mandate.cadence}
                        <small className="pay-cell-note">
                          {mandate.startsAt} → {mandate.endsAt ?? 'Open ended'}
                        </small>
                      </td>
                      <td>
                        <Status value={mandate.status} />
                      </td>
                      <td>
                        {mandate.status === 'active' && (
                          <ReviewedAction
                            title="Cancel mandate"
                            description="Cancel this mandate immediately and cascade cancellation to its active subscriptions. Settled executions are not reversed."
                            review={
                              <PayDetails
                                values={[
                                  ['Customer', mandate.customerId],
                                  ['Mandate', mandate.id],
                                ]}
                              />
                            }
                            perform={() =>
                              pay.mutate('mandate.cancel', { mandateId: mandate.id }, s.mandateSchema, 'pay:write', `mandate:${mandate.id}`)
                            }
                            onConfirmed={refresh}
                            disabled={Boolean(pay.access('pay:write'))}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </DataTable>
                <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
              </>
            )}
          </PayState>
        </PaySection>
      )}
    </div>
  );
}
function CreateMandate({ pay, refresh }: { pay: BusinessPayApi; refresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [customer, setCustomer] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [cadence, setCadence] = useState('monthly');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [rail, setRail] = useState('');
  const [reference, setReference] = useState('');
  const [created, setCreated] = useState('');
  return (
    <PaySection
      title="Record a customer mandate"
      description="Record existing customer authorization. This form does not collect or prove consent and does not charge."
      action={
        <Button variant="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? 'Hide form' : 'New mandate'}
        </Button>
      }
    >
      {expanded && (
        <div className="form-stack pay-form">
          <Field label="Authorized customer ID" value={customer} onChange={(event) => setCustomer(event.target.value)} maxLength={128} />
          <div className="form-row">
            <Field label="Authorized amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            <Field label="Asset" value={asset} onChange={(event) => setAsset(event.target.value.toUpperCase())} maxLength={16} />
          </div>
          <Field
            label="Authorized ceiling (optional)"
            inputMode="decimal"
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
          />
          <label className="field">
            Cadence
            <select value={cadence} onChange={(event) => setCadence(event.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <div className="form-row">
            <Field label="Authorization starts" type="datetime-local" value={starts} onChange={(event) => setStarts(event.target.value)} />
            <Field
              label="Authorization ends (optional)"
              type="datetime-local"
              value={ends}
              onChange={(event) => setEnds(event.target.value)}
            />
          </div>
          <Field label="Existing mandate rail (optional)" value={rail} onChange={(event) => setRail(event.target.value)} maxLength={64} />
          <Field
            label="Existing rail mandate reference (optional)"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={256}
          />
          <ReviewedAction
            title="Record mandate"
            description="Store the supplied authorized terms. Changing amount or ceiling later requires a newly consented mandate. Recording terms does not activate an absent charging rail."
            review={
              <PayDetails
                values={[
                  ['Customer', customer],
                  ['Amount / ceiling', `${amount} / ${ceiling || 'Not supplied'} ${asset}`],
                  ['Cadence', cadence],
                  ['Authorization window', `${starts} → ${ends || 'Open ended'}`],
                ]}
              />
            }
            perform={() =>
              validatedMutation(
                pay,
                'mandate.create',
                {
                  merchantId: pay.authority!.merchantId,
                  customerId: customer,
                  assetId: asset,
                  amount,
                  cadence,
                  startsAt: starts ? new Date(starts).toISOString() : '',
                  ...(ends ? { endsAt: new Date(ends).toISOString() } : {}),
                  ...(ceiling ? { ceiling } : {}),
                  ...(rail ? { railAdapter: rail } : {}),
                  ...(reference ? { railMandateRef: reference } : {}),
                },
                z.object({
                  merchantId: s.id,
                  customerId: z.string().min(1).max(128),
                  assetId: s.asset,
                  amount: s.positiveAmount,
                  ceiling: s.amount.optional(),
                  cadence: z.enum(['daily', 'weekly', 'monthly']),
                  startsAt: z.string().datetime({ offset: true }),
                  endsAt: z.string().datetime({ offset: true }).optional(),
                  railAdapter: z.string().max(64).optional(),
                  railMandateRef: z.string().max(256).optional(),
                }),
                s.mandateSchema,
                'pay:write',
                'mandate-create',
              )
            }
            disabled={!customer || !amount || !asset || !starts || Boolean(pay.access('pay:write'))}
            onConfirmed={(data) => {
              setCreated(data.id);
              refresh();
              setExpanded(false);
            }}
          />
        </div>
      )}
      {created && (
        <p className="pay-confirmed" role="status">
          Mandate recorded: {created}
        </p>
      )}
    </PaySection>
  );
}
function SubscriptionDetail({
  pay,
  subscriptionId,
  refresh,
  projectedEnd,
  setProjectedEnd,
}: {
  pay: BusinessPayApi;
  subscriptionId: string;
  refresh: () => void;
  projectedEnd: string | null | undefined;
  setProjectedEnd: (value: string | null) => void;
}) {
  const [limit, setLimit] = useState(50);
  const record = useResource(
    (signal) => pay.query('subscription.get', { subscriptionId }, s.subscriptionSchema, signal),
    `pay:subscription:${pay.authority!.merchantId}:${subscriptionId}`,
  );
  const executions = useResource(
    (signal) => pay.query('subscription.listExecutions', { subscriptionId, limit }, z.array(s.executionSchema), signal),
    `pay:subscription-executions:${pay.authority!.merchantId}:${subscriptionId}:${limit}`,
  );
  function reload() {
    record.reload();
    executions.reload();
    refresh();
  }
  const locked = Boolean(pay.guard.status(`${pay.authority!.userId}:subscription:${subscriptionId}`));
  return (
    <PaySection
      title="Subscription and invoice history"
      action={
        <Button variant="secondary" onClick={reload}>
          Refresh subscription
        </Button>
      }
    >
      <PayState resource={record.resource} retry={record.reload}>
        {(subscription) => (
          <div className="form-stack">
            <PayDetails
              values={[
                ['Subscription', subscription.id],
                ['Mandate', subscription.mandateId],
                ['State', subscription.status],
                ['Next run', subscription.nextRunAt],
                ['Paused', subscription.pausedAt ?? 'No recorded pause'],
                ['Resumed', subscription.resumedAt ?? 'No recorded resume'],
                ['Stall reason', subscription.stallReason ?? 'None returned'],
              ]}
            />
            {projectedEnd !== undefined && <p role="status">The service projected the resumed end as {projectedEnd ?? 'open ended'}.</p>}
            {locked && (
              <PayNotice title="Original subscription action is unresolved">
                Refresh the schedule and status. No new action starts while the original outcome remains unknown.
              </PayNotice>
            )}
            <div className="actions">
              {subscription.status === 'active' && (
                <ReviewedAction
                  title="Pause subscription"
                  description="Pause the subscription without reversing settled invoices. The service records an operator pause."
                  perform={() =>
                    pay.mutate(
                      'subscription.pause',
                      { subscriptionId },
                      s.subscriptionSchema,
                      'pay:write',
                      `subscription:${subscriptionId}`,
                    )
                  }
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={reload}
                />
              )}
              {subscription.status === 'paused' && (
                <ReviewedAction
                  title="Resume subscription"
                  description="The service re-spaces the schedule and returns a projected end. A resume past the customer’s mandate window refuses; missed periods are not compressed."
                  perform={() =>
                    pay.mutate(
                      'subscription.resume',
                      { subscriptionId },
                      z.object({ subscription: s.subscriptionSchema, projectedEnd: z.string().nullable() }),
                      'pay:write',
                      `subscription:${subscriptionId}`,
                    )
                  }
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={(data) => {
                    setProjectedEnd(data.projectedEnd);
                    reload();
                  }}
                />
              )}
              {['active', 'paused'].includes(subscription.status) && (
                <ReviewedAction
                  title="Cancel subscription"
                  description="Cancel this subscription immediately. Settled invoice executions remain recorded and are not refunded."
                  perform={() =>
                    pay.mutate(
                      'subscription.cancel',
                      { subscriptionId },
                      s.subscriptionSchema,
                      'pay:write',
                      `subscription:${subscriptionId}`,
                    )
                  }
                  disabled={locked || Boolean(pay.access('pay:write'))}
                  onConfirmed={reload}
                />
              )}
            </div>
            <PayState resource={executions.resource} retry={executions.reload} empty="No executions recorded for this subscription">
              {(rows) => (
                <>
                  <DataTable
                    label="Subscription invoice executions"
                    headers={['Period / attempted', 'Exact amount', 'Outcome', 'Payment reference', 'Notice']}
                  >
                    {rows.map((execution) => (
                      <tr key={execution.id}>
                        <td>
                          {execution.occurrence}
                          <small className="pay-cell-note">{execution.attemptedAt}</small>
                        </td>
                        <td className="numeric">
                          {displayAmount(execution.amount)}
                          <small className="pay-cell-note">Asset defined by the mandate</small>
                        </td>
                        <td>
                          <Status value={execution.status} />
                          <small className="pay-cell-note">{execution.rejectionCode ?? ''}</small>
                        </td>
                        <td>{execution.paymentId ?? 'No payment created'}</td>
                        <td>
                          {execution.notifyStatus ?? 'Not supplied'}
                          <small className="pay-cell-note">{execution.notifyCode ?? ''}</small>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                  <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
                </>
              )}
            </PayState>
          </div>
        )}
      </PayState>
    </PaySection>
  );
}
