import { createSubscriptionWithRecovery } from './portal/payments/subscription-recovery';
import { useUnsavedForm } from './portal/useUnsavedForm';
import { SelectField } from './portal/components';
import { DEFAULT_ASSET, useAssetChoices } from './portal/payments/asset-choices';
import type { PortalApi } from './portal/api';
import { extensionCopy } from './portal/extension-copy';
import { payCopy, PayCopy } from './copy';
import { useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, DataTable } from '@intafaced/ui';
import { Field } from './ui-kit';
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
    (signal) =>
      pay
        .query(
          'mandate.list',
          { merchantId, limit },
          z.object({ items: z.array(s.mandateSchema), nextCursor: z.string().nullable() }),
          signal,
        )
        .then((result) => s.listed(result)),
    `pay:mandates:${merchantId}:${limit}`,
  );
  const subscriptions = useResource(
    (signal) =>
      pay
        .query(
          'subscription.list',
          { merchantId, limit },
          z.object({ items: z.array(s.subscriptionSchema), nextCursor: z.string().nullable() }),
          signal,
        )
        .then((result) => s.listed(result)),
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
      <PaySection title={payCopy.t('billingAvailability')}>
        <PayState resource={posture.resource} retry={posture.reload}>
          {(data) => (
            <>
              <PayNotice title={payCopy.t('recurringChargePosture')}>
                {data.paths.map((item) => `${item.path}: ${item.posture}`).join(' · ')}
                <PayCopy k="cardMandateChargingIsRefusedWith" /> {data.card.code}.
              </PayNotice>
              <PayNotice title={payCopy.t('preChargeNoticeIsNotConnected')}>
                {data.preChargeNotify.merchantReadable} <PayCopy k="customersHaveNotBeenNotifiedByThis" />
              </PayNotice>
            </>
          )}
        </PayState>
      </PaySection>
      {invoices ? (
        <PayNotice title={payCopy.t('standaloneInvoicingIsUnavailable')}>
          <PayCopy k="thereIsNoIndependentInvoiceCreateList" />
        </PayNotice>
      ) : (
        <>
          <CreateMandate pay={pay} refresh={refresh} />
          <PaySection title={payCopy.t('startASubscription')} description={payCopy.t('useAnExistingMandateAndAPath')}>
            <div className="form-stack pay-form">
              <label className="field">
                <PayCopy k="activeMandate" />
                <select value={mandateId} onChange={(event) => setMandateId(event.target.value)}>
                  <option value="">{payCopy.t('chooseAMandate')}</option>
                  {mandates.resource.status === 'ready' &&
                    mandates.resource.data
                      .filter((mandate) => mandate.status === 'active')
                      .map((mandate) => (
                        <option key={mandate.id} value={mandate.id}>
                          {mandate.customerId} · {mandate.amount} {mandate.assetId} · {cadenceWord(mandate.cadence)}
                        </option>
                      ))}
                </select>
              </label>
              <label className="field">
                <PayCopy k="subscriptionChargePath" />
                <select value={path} onChange={(event) => setPath(event.target.value)}>
                  <option value="">{payCopy.t('chooseASupportedPath')}</option>
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
                title={payCopy.t('createSubscription')}
                description={payCopy.t('createTheScheduleUnderTheExistingCustomer')}
                review={
                  <PayDetails
                    values={[
                      [payCopy.t('mandate'), mandateId],
                      [payCopy.t('path'), path],
                    ]}
                  />
                }
                perform={() => createSubscriptionWithRecovery(pay, mandateId, path)}
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
        title={invoices ? payCopy.t('subscriptionInvoiceSources') : payCopy.t('subscriptions')}
        action={
          <Button variant="secondary" onClick={refresh}>
            <PayCopy k="refreshBilling" />
          </Button>
        }
      >
        <PayState resource={subscriptions.resource} retry={subscriptions.reload} empty={payCopy.t('noSubscriptionsReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('subscriptions')}
                headers={[payCopy.t('customerSubscription'), payCopy.t('chargePath'), payCopy.t('nextRun'), payCopy.t('stateReason'), '']}
              >
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
                      <small className="pay-cell-note">{subscription.stallReason ?? payCopy.t('noStallReasonReturned')}</small>
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSelected(subscription.id);
                          setProjectedEnd(undefined);
                        }}
                      >
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
        <PaySection title={payCopy.t('customerMandates')}>
          <PayState resource={mandates.resource} retry={mandates.reload} empty={payCopy.t('noMandatesReturned')}>
            {(rows) => (
              <>
                <DataTable
                  label={payCopy.t('mandates')}
                  headers={[
                    payCopy.t('customer'),
                    payCopy.t('authorizedAmount'),
                    payCopy.t('ceiling'),
                    payCopy.t('cadenceWindow'),
                    payCopy.t('status'),
                    '',
                  ]}
                >
                  {rows.map((mandate) => (
                    <tr key={mandate.id}>
                      <td>{mandate.customerId}</td>
                      <td className="numeric">
                        {displayAmount(mandate.amount)} {mandate.assetId}
                      </td>
                      <td className="numeric">
                        {mandate.ceiling === null ? payCopy.t('noCeilingSupplied') : `${displayAmount(mandate.ceiling)} ${mandate.assetId}`}
                      </td>
                      <td>
                        {cadenceWord(mandate.cadence)}
                        <small className="pay-cell-note">
                          {mandate.startsAt} → {mandate.endsAt ?? payCopy.t('openEnded')}
                        </small>
                      </td>
                      <td>
                        <Status value={mandate.status} />
                      </td>
                      <td>
                        {mandate.status === 'active' && (
                          <ReviewedAction
                            title={payCopy.t('cancelMandate')}
                            description={payCopy.t('cancelThisMandateImmediatelyAndCascadeCancellation')}
                            review={
                              <PayDetails
                                values={[
                                  [payCopy.t('customer'), mandate.customerId],
                                  [payCopy.t('mandate'), mandate.id],
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
/** A billing cadence in words, never the service's raw value. An unknown one is shown as it came rather than guessed. */
export function cadenceWord(cadence: string): string {
  return cadence === 'daily' ? payCopy.t('daily') : cadence === 'weekly' ? payCopy.t('weekly') : cadence === 'monthly' ? payCopy.t('monthly') : cadence;
}
export function CreateMandate({ pay, refresh, portal }: { pay: BusinessPayApi; refresh: () => void; portal?: PortalApi }) {
  const [expanded, setExpanded] = useState(false);
  const [customer, setCustomer] = useState('');
  const [asset, setAsset] = useState(DEFAULT_ASSET);
  const assets = useAssetChoices(portal, pay.authority?.merchantId, asset);
  const [amount, setAmount] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [cadence, setCadence] = useState('monthly');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [rail, setRail] = useState('');
  const [reference, setReference] = useState('');
  const [created, setCreated] = useState('');
  useUnsavedForm(
    expanded && Boolean(customer || asset || amount || ceiling || starts || ends || rail || reference),
    extensionCopy.t('draftWarning'),
  );
  return (
    <PaySection
      title={payCopy.t('recordACustomerMandate')}
      description={payCopy.t('recordExistingCustomerAuthorizationThisFormDoes')}
      action={
        <Button variant="secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {expanded ? payCopy.t('hideForm') : payCopy.t('newMandate')}
        </Button>
      }
    >
      {expanded && (
        <div className="form-stack pay-form">
          <Field
            label={payCopy.t('authorizedCustomerId')}
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
            maxLength={128}
          />
          <div className="form-row">
            <Field
              label={payCopy.t('authorizedAmount')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <SelectField label={payCopy.t('asset')} value={asset} onChange={setAsset} options={assets.map((a) => [a, a] as const)} />
          </div>
          <Field
            label={payCopy.t('authorizedCeilingOptional')}
            inputMode="decimal"
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
          />
          <label className="field">
            <PayCopy k="cadence" />
            <select value={cadence} onChange={(event) => setCadence(event.target.value)}>
              <option value="daily">{payCopy.t('daily')}</option>
              <option value="weekly">{payCopy.t('weekly')}</option>
              <option value="monthly">{payCopy.t('monthly')}</option>
            </select>
          </label>
          <div className="form-row">
            <Field
              label={payCopy.t('authorizationStarts')}
              type="datetime-local"
              value={starts}
              onChange={(event) => setStarts(event.target.value)}
            />
            <Field
              label={payCopy.t('authorizationEndsOptional')}
              type="datetime-local"
              value={ends}
              onChange={(event) => setEnds(event.target.value)}
            />
          </div>
          <Field
            label={payCopy.t('existingMandateRailOptional')}
            value={rail}
            onChange={(event) => setRail(event.target.value)}
            maxLength={64}
          />
          <Field
            label={payCopy.t('existingRailMandateReferenceOptional')}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={256}
          />
          <ReviewedAction
            title={payCopy.t('recordMandate')}
            description={payCopy.t('storeTheSuppliedAuthorizedTermsChangingAmount')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('customer'), customer],
                  [payCopy.t('amountCeiling'), `${amount} / ${ceiling || payCopy.t('notSupplied')} ${asset}`],
                  [payCopy.t('cadence'), cadenceWord(cadence)],
                  [payCopy.t('authorizationWindow'), `${starts} → ${ends || payCopy.t('openEnded')}`],
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
              setCustomer('');
              setAsset('');
              setAmount('');
              setCeiling('');
              setStarts('');
              setEnds('');
              setRail('');
              setReference('');
              refresh();
              setExpanded(false);
            }}
          />
        </div>
      )}
      {created && (
        <p className="pay-confirmed" role="status">
          <PayCopy k="mandateRecorded" /> {created}
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
      title={payCopy.t('subscriptionAndInvoiceHistory')}
      action={
        <Button variant="secondary" onClick={reload}>
          <PayCopy k="refreshSubscription" />
        </Button>
      }
    >
      <PayState resource={record.resource} retry={record.reload}>
        {(subscription) => (
          <div className="form-stack">
            <PayDetails
              values={[
                [payCopy.t('subscription'), subscription.id],
                [payCopy.t('mandate'), subscription.mandateId],
                [payCopy.t('state'), subscription.status],
                [payCopy.t('nextRun'), subscription.nextRunAt],
                [payCopy.t('paused'), subscription.pausedAt ?? payCopy.t('noRecordedPause')],
                [payCopy.t('resumed'), subscription.resumedAt ?? payCopy.t('noRecordedResume')],
                [payCopy.t('stallReason'), subscription.stallReason ?? payCopy.t('noneReturned')],
              ]}
            />
            {projectedEnd !== undefined && (
              <p role="status">
                <PayCopy k="theServiceProjectedTheResumedEndAs" /> {projectedEnd ?? payCopy.t('openEnded2')}.
              </p>
            )}
            {locked && (
              <PayNotice title={payCopy.t('originalSubscriptionActionIsUnresolved')}>
                <PayCopy k="refreshTheScheduleAndStatusNoNew" />
              </PayNotice>
            )}
            <div className="actions">
              {subscription.status === 'active' && (
                <ReviewedAction
                  title={payCopy.t('pauseSubscription')}
                  description={payCopy.t('pauseTheSubscriptionWithoutReversingSettledInvoices')}
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
                  title={payCopy.t('resumeSubscription')}
                  description={payCopy.t('theServiceReSpacesTheScheduleAnd')}
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
                  title={payCopy.t('cancelSubscription')}
                  description={payCopy.t('cancelThisSubscriptionImmediatelySettledInvoiceExecutions')}
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
            <PayState resource={executions.resource} retry={executions.reload} empty={payCopy.t('noExecutionsRecordedForThisSubscription')}>
              {(rows) => (
                <>
                  <DataTable
                    label={payCopy.t('subscriptionInvoiceExecutions')}
                    headers={[
                      payCopy.t('periodAttempted'),
                      payCopy.t('exactAmount'),
                      payCopy.t('outcome'),
                      payCopy.t('paymentReference'),
                      payCopy.t('notice'),
                    ]}
                  >
                    {rows.map((execution) => (
                      <tr key={execution.id}>
                        <td>
                          {execution.occurrence}
                          <small className="pay-cell-note">{execution.attemptedAt}</small>
                        </td>
                        <td className="numeric">
                          {displayAmount(execution.amount)}
                          <small className="pay-cell-note">
                            <PayCopy k="assetDefinedByTheMandate" />
                          </small>
                        </td>
                        <td>
                          <Status value={execution.status} />
                          <small className="pay-cell-note">{execution.rejectionCode ?? ''}</small>
                        </td>
                        <td>{execution.paymentId ?? payCopy.t('noPaymentCreated')}</td>
                        <td>
                          {execution.notifyStatus ?? payCopy.t('notSupplied')}
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
