import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../session/session';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Field } from '../../../shared/ui';
import { PayDetails, PaySection, PayTime, ReviewedAction } from '../components';
import { CreateMandate } from '../MerchantBilling';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../pay-api';
import { executionSchema, mandateSchema, subscriptionSchema, subscriptionPostureSchema, id } from '../schemas';
import { Arrives, CopyReference, PortalBack, ReadStamp, WindowExport } from './ExtensionTools';
import { Gate, Kpi, KpiGrid, Money, SelectField, Timeline } from './components';
import { useReadAt, useUrlParam } from './hooks';
import { useUnsavedForm } from './useUnsavedForm';
import { extensionCopy as c } from './extension-copy';
import type { PortalApi } from './api';
import type { Cycle } from './billing-schemas';
import type { PortalRoute } from './routes';
import type { ApiResult } from '../../../shared/api';
import { checkSubscriptionOriginal, checkSubscriptionCreateOriginal } from './subscription-recovery';

type Subscription = z.infer<typeof subscriptionSchema>;
type Mandate = z.infer<typeof mandateSchema>;
type Execution = z.infer<typeof executionSchema>;
const statuses = ['active', 'paused', 'cancelled', 'completed'] as const;
export function subscriptionHeader(route: PortalRoute) {
  return {
    title: c.t(
      route.room === 'subscription-new' ? 'createSubscription' : route.room === 'subscription' ? 'subscriptionTitle' : 'subscriptionsTitle',
    ),
    purpose: c.t(route.room === 'subscription-new' ? 'createSubscriptionPurpose' : 'subscriptionsPurpose'),
    action: (
      <a className="button button--primary" href={route.room === 'subscription-new' ? '/pay/subscriptions' : '/pay/subscriptions/new'}>
        {c.t(route.room === 'subscription-new' ? 'subscriptionsTitle' : 'createSubscription')}
      </a>
    ),
  };
}
export function SubscriptionChip({ status }: { status: Subscription['status'] }) {
  return (
    <span className={`pp-chip${status === 'active' ? ' pp-chip--good' : ''}`} title={c.t(`subscription_${status}`)}>
      {c.t(status)}
    </span>
  );
}
export function CycleChip({ status }: { status: Cycle['status'] }) {
  return (
    <span
      className={`pp-chip${status === 'settled' ? ' pp-chip--good' : status === 'rejected' ? ' pp-chip--bad' : ''}`}
      title={c.t(`cycle_${status}`)}
    >
      {c.t(status)}
    </span>
  );
}
export function Subscriptions({
  portal,
  merchantId,
  route,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  route: PortalRoute;
  authority: PayBusinessAuthority | null;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => (authority ? createBusinessPayApi(api, userId, authority) : null), [api, userId, authority]);
  return (
    <div className="stack">
      <PortalBack href={route.room === 'subscriptions' ? '/pay/merchant' : '/pay/subscriptions'}>
        {c.t(route.room === 'subscriptions' ? 'backHome' : 'subscriptionsTitle')}
      </PortalBack>
      {route.room === 'subscription-new' ? (
        <CreateSubscription portal={portal} merchantId={merchantId} pay={pay} />
      ) : route.room === 'subscription' ? (
        <SubscriptionPage portal={portal} merchantId={merchantId} subscriptionId={route.param!} pay={pay} />
      ) : (
        <SubscriptionsPage portal={portal} merchantId={merchantId} />
      )}
    </div>
  );
}
function SubscriptionsPage({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const [limitParam, setLimit] = useUrlParam('limit', '50');
  const limit = ['25', '50', '100', '200'].includes(limitParam) ? Number(limitParam) : 50;
  const rows = useResource((signal) => portal.subscriptions(merchantId, limit, signal), `portal:subscriptions:${merchantId}:${limit}`);
  return <SubscriptionsView resource={rows.resource} reload={rows.reload} limit={limit} setLimit={setLimit} />;
}
export function SubscriptionsView({
  resource,
  reload,
  limit,
  setLimit,
}: {
  resource: Resource<Subscription[]>;
  reload: () => void;
  limit: number;
  setLimit: (v: string) => void;
}) {
  const [search, setSearch] = useUrlParam('search');
  const [status, setStatus] = useUrlParam('status');
  const [sort, setSort] = useUrlParam('sort', 'newest');
  const at = useReadAt(resource.status === 'ready', resource);
  return (
    <div className="stack">
      <PaySection
        title={c.t('subscriptionsTitle')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <div className="pp-filter-row" role="search">
          <Field label={c.t('subscriptionSearch')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <SelectField
            label={c.t('status')}
            value={status}
            onChange={setStatus}
            options={[['', c.t('all')], ...statuses.map((v) => [v, c.t(v)] as const)]}
          />
          <SelectField
            label={c.t('sort')}
            value={sort}
            onChange={setSort}
            options={[
              ['newest', c.t('newest')],
              ['oldest', c.t('oldest')],
              ['name', c.t('nameSort')],
            ]}
          />
          <SelectField
            label={c.t('limit')}
            value={String(limit)}
            onChange={setLimit}
            options={['25', '50', '100', '200'].map((v) => [v, v] as const)}
          />
        </div>
        <p className="muted">{c.t('subscriptionWindow')}</p>
        <Gate resource={resource} retry={reload}>
          {(all) => {
            const rows = all
              .filter((s) => (!status || s.status === status) && `${s.id} ${s.customerId}`.toLowerCase().includes(search.toLowerCase()))
              .sort((a, b) =>
                sort === 'name'
                  ? a.customerId.localeCompare(b.customerId)
                  : sort === 'oldest'
                    ? a.createdAt.localeCompare(b.createdAt)
                    : b.createdAt.localeCompare(a.createdAt),
              );
            return (
              <>
                <KpiGrid label={c.t('loadedMetrics')}>
                  {(['activeSubscriptions', 'pausedSubscriptions', 'cancelledSubscriptions', 'completedSubscriptions'] as const).map(
                    (key, i) => (
                      <Kpi
                        key={key}
                        label={c.t(key)}
                        period={c.t('loadedMetrics')}
                        value={all.filter((s) => s.status === statuses[i]).length}
                        href={`/pay/subscriptions?status=${statuses[i]}`}
                      />
                    ),
                  )}
                </KpiGrid>
                <ReadStamp at={at} />
                <p role="status">{c.t('shown', { count: rows.length })}</p>
                {rows.length ? (
                  <DataTable
                    label={c.t('subscriptionsTitle')}
                    headers={[c.t('customer'), c.t('chargePath'), c.t('status'), c.t('nextRun')]}
                  >
                    {rows.map((s) => (
                      <tr key={s.id}>
                        <th scope="row">
                          <a className="text-link" href={`/pay/subscriptions/${encodeURIComponent(s.id)}`}>
                            {s.customerId}
                          </a>
                          <small className="pay-cell-note">{s.id}</small>
                        </th>
                        <td>{s.path}</td>
                        <td>
                          <SubscriptionChip status={s.status} />
                          {s.stallReason && <p className="muted">{c.t(`stall_${s.stallReason}`)}</p>}
                        </td>
                        <td>{s.status === 'active' ? <PayTime value={s.nextRunAt} /> : c.t('noNextRun')}</td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <EmptyState
                    title={c.t('emptySubscriptions')}
                    action={
                      <a className="text-link" href="/pay/subscriptions/new">
                        {c.t('createSubscription')}
                      </a>
                    }
                  >
                    {c.t('emptySubscriptionsBody')}
                  </EmptyState>
                )}
                <WindowExport
                  name="subscriptions"
                  at={at}
                  headers={['subscription_id', 'customer_reference', 'mandate_id', 'status', 'charge_path', 'scheduled_run', 'created_at']}
                  rows={rows.map((s) => [s.id, s.customerId, s.mandateId, s.status, s.path, s.nextRunAt, s.createdAt])}
                />
              </>
            );
          }}
        </Gate>
      </PaySection>
      <Arrives>{c.t('subscriptionMetricsGap')}</Arrives>
    </div>
  );
}
function SubscriptionPage({
  portal,
  merchantId,
  subscriptionId,
  pay,
}: {
  portal: PortalApi;
  merchantId: string;
  subscriptionId: string;
  pay: BusinessPayApi | null;
}) {
  const valid = id.safeParse(subscriptionId).success;
  const record = useResource(
    (signal) =>
      valid
        ? portal.subscription(merchantId, subscriptionId, signal)
        : Promise.resolve({
            ok: false as const,
            reason: 'not_mounted' as const,
            code: 'pay.subscription_not_found',
            message: 'pay.subscription_not_found',
          }),
    `portal:subscription:${merchantId}:${subscriptionId}`,
  );
  return (
    <Gate resource={record.resource} retry={record.reload}>
      {(subscription) => <SubscriptionRelated portal={portal} subscription={subscription} pay={pay} reload={record.reload} />}
    </Gate>
  );
}
function SubscriptionRelated({
  portal,
  subscription,
  pay,
  reload,
}: {
  portal: PortalApi;
  subscription: Subscription;
  pay: BusinessPayApi | null;
  reload: () => void;
}) {
  const mandate = useResource(
    (signal) => portal.mandate(subscription.merchantId, subscription.mandateId, signal),
    `portal:mandate:${subscription.mandateId}`,
  );
  const cycles = useResource((signal) => portal.subscriptionCycles(subscription.id, signal), `portal:cycles:${subscription.id}`);
  const executions = useResource(
    (signal) => portal.subscriptionExecutions(subscription.id, signal),
    `portal:executions:${subscription.id}`,
  );
  return (
    <SubscriptionDetailView
      subscription={subscription}
      mandate={mandate.resource}
      cycles={cycles.resource}
      executions={executions.resource}
      pay={pay}
      reload={() => {
        reload();
        mandate.reload();
        cycles.reload();
        executions.reload();
      }}
    />
  );
}
export function SubscriptionDetailView({
  subscription,
  mandate,
  cycles,
  executions,
  pay,
  reload,
}: {
  subscription: Subscription;
  mandate: Resource<Mandate>;
  cycles: Resource<{ subscriptionId: string; cycles: Cycle[] }>;
  executions: Resource<Execution[]>;
  pay: BusinessPayApi | null;
  reload: () => void;
}) {
  const at = useReadAt(true, subscription);
  const asset = mandate.status === 'ready' ? mandate.data.assetId : null;
  const events = [
    { at: subscription.createdAt, title: c.t('subscriptionCreated') },
    ...(subscription.pausedAt ? [{ at: subscription.pausedAt, title: c.t('subscriptionPaused') }] : []),
    ...(subscription.resumedAt ? [{ at: subscription.resumedAt, title: c.t('subscriptionResumed') }] : []),
    ...(subscription.cancelledAt ? [{ at: subscription.cancelledAt, title: c.t('subscriptionCancelled') }] : []),
    ...(subscription.stalledAt ? [{ at: subscription.stalledAt, title: c.t('subscriptionStalled') }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="stack">
      <PaySection
        title={c.t('keyFacts')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <CopyReference value={subscription.id} />
        <PayDetails
          values={[
            [
              c.t('customer'),
              <a className="text-link" href={`/pay/customers/${encodeURIComponent(subscription.customerId)}`}>
                {subscription.customerId}
              </a>,
            ],
            [c.t('mandate'), <CopyReference value={subscription.mandateId} />],
            [c.t('status'), <SubscriptionChip status={subscription.status} />],
            [c.t('chargePath'), subscription.path],
            [c.t('nextRun'), subscription.status === 'active' ? <PayTime value={subscription.nextRunAt} /> : c.t('noNextRun')],
          ]}
        />
        <ReadStamp at={at} />
        {subscription.stallReason && (
          <p className="pp-callout pp-callout--warn" role="status">
            {c.t(`stall_${subscription.stallReason}`)}
          </p>
        )}
        {pay ? (
          <SubscriptionActions subscription={subscription} pay={pay} reload={reload} />
        ) : (
          <p className="pp-callout" role="status">
            {c.t('subscriptionAuthority')}
          </p>
        )}
      </PaySection>
      <PaySection title={c.t('subscriptionTerms')}>
        <Gate resource={mandate} retry={reload}>
          {(m) => (
            <PayDetails
              values={[
                [c.t('amount'), <Money value={m.amount} asset={m.assetId} />],
                [c.t('status'), m.status],
                [c.t('cadence'), m.cadence],
                [c.t('mandateStart'), <PayTime value={m.startsAt} />],
                [c.t('mandateEnd'), m.endsAt ? <PayTime value={m.endsAt} /> : c.t('openEnded')],
                [c.t('authorizedCeiling'), m.ceiling !== null ? <Money value={m.ceiling} asset={m.assetId} /> : c.t('noCeiling')],
              ]}
            />
          )}
        </Gate>
      </PaySection>
      <PaySection title={c.t('history')}>
        <Timeline items={events} label={c.t('history')} />
        <Arrives>{c.t('subscriptionAuditGap')}</Arrives>
      </PaySection>
      <PaySection title={c.t('cycleHistory')}>
        <p className="muted">{c.t('loadedWindow')}</p>
        <Gate resource={cycles} retry={reload}>
          {(data) =>
            data.cycles.length ? (
              <>
                <DataTable
                  label={c.t('cycleHistory')}
                  headers={[c.t('occurrence'), c.t('amount'), c.t('status'), c.t('attempts'), c.t('cycleKey'), c.t('payment')]}
                >
                  {data.cycles.map((cycle) => (
                    <tr key={cycle.occurrence}>
                      <th scope="row">{cycle.occurrence}</th>
                      <td>{asset ? <Money value={cycle.amount} asset={asset} /> : c.t('assetUnavailable')}</td>
                      <td>
                        <CycleChip status={cycle.status} />
                        {cycle.exhausted && <p className="muted">{c.t('subscriptionRefusal')}</p>}
                      </td>
                      <td>{cycle.attemptCount}</td>
                      <td>{cycle.idempotencyKey ? <CopyReference value={cycle.idempotencyKey} /> : c.t('unavailable')}</td>
                      <td>
                        {cycle.paymentId ? (
                          <a className="text-link" href={`/pay/payments/${encodeURIComponent(cycle.paymentId)}`}>
                            {cycle.paymentId}
                          </a>
                        ) : (
                          c.t('noPayment')
                        )}
                      </td>
                    </tr>
                  ))}
                </DataTable>
                <p role="status">{c.t('shown', { count: data.cycles.length })}</p>
              </>
            ) : (
              <EmptyState title={c.t('emptyCycles')}>{c.t('emptyCyclesBody')}</EmptyState>
            )
          }
        </Gate>
      </PaySection>
      <PaySection title={c.t('executionsTitle')}>
        <p className="pp-callout">{c.t('executionNotice')}</p>
        <Gate resource={executions} retry={reload}>
          {(rows) =>
            rows.length ? (
              <DataTable
                label={c.t('executionsTitle')}
                headers={[c.t('occurrence'), c.t('amount'), c.t('status'), c.t('created'), c.t('payment')]}
              >
                {rows.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.occurrence}</th>
                    <td>{asset ? <Money value={e.amount} asset={asset} /> : c.t('assetUnavailable')}</td>
                    <td>
                      <CycleChip status={e.status} />
                    </td>
                    <td>
                      <PayTime value={e.attemptedAt} />
                    </td>
                    <td>
                      {e.paymentId ? (
                        <a className="text-link" href={`/pay/payments/${encodeURIComponent(e.paymentId)}`}>
                          {e.paymentId}
                        </a>
                      ) : (
                        c.t('noPayment')
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title={c.t('emptyCycles')}>{c.t('emptyCyclesBody')}</EmptyState>
            )
          }
        </Gate>
      </PaySection>
    </div>
  );
}
function SubscriptionRecovery({
  check,
  onKnown,
}: {
  check: (current: () => boolean) => Promise<ApiResult<Subscription>>;
  onKnown: (subscription: Subscription) => void;
}) {
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <div className="stack">
      <p className="pp-callout" role="status">
        {c.t('unresolvedSubscription')}
      </p>
      <Button
        disabled={busy}
        onClick={async () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          try {
            const result = await check(() => mounted.current);
            if (!mounted.current) return;
            if (result.ok) onKnown(result.data);
            else setMessage(c.t('subscriptionStillUnresolved'));
          } finally {
            busyRef.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        {c.t('checkSubscriptionOriginal')}
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
export function SubscriptionTerms({ mandate: m, path }: { mandate: Mandate; path: string }) {
  return (
    <PayDetails
      values={[
        [c.t('customer'), m.customerId],
        [c.t('mandate'), m.id],
        [c.t('chargePath'), path || c.t('unavailable')],
        [c.t('amount'), <Money value={m.amount} asset={m.assetId} />],
        [c.t('cadence'), m.cadence],
        [c.t('mandateStart'), <PayTime value={m.startsAt} />],
        [c.t('mandateEnd'), m.endsAt ? <PayTime value={m.endsAt} /> : c.t('openEnded')],
        [c.t('authorizedCeiling'), m.ceiling !== null ? <Money value={m.ceiling} asset={m.assetId} /> : c.t('noCeiling')],
      ]}
    />
  );
}
function SubscriptionActions({ subscription: s, pay, reload }: { subscription: Subscription; pay: BusinessPayApi; reload: () => void }) {
  const [revision, setRevision] = useState(0);
  // Refresh guard state without remounting an in-flight confirmation.
  const [, refreshLock] = useState(0);
  const [projected, setProjected] = useState<string | null | undefined>();
  const locked = Boolean(pay.guard.status(`${pay.authority!.userId}:subscription:${s.id}`));
  const disabled = locked || Boolean(pay.access('pay:write'));
  return (
    <div className="stack">
      {locked && (
        <SubscriptionRecovery
          key={`${pay.authority!.userId}:${s.id}`}
          check={(current) => checkSubscriptionOriginal(pay, s.id, current)}
          onKnown={() => {
            setRevision((v) => v + 1);
            reload();
          }}
        />
      )}
      <div className="pp-actions">
        {(['pause', 'resume', 'cancel'] as const)
          .filter((action) =>
            action === 'pause'
              ? s.status === 'active'
              : action === 'resume'
                ? s.status === 'paused'
                : s.status === 'active' || s.status === 'paused',
          )
          .map((action) => (
            <span key={action} title={disabled ? c.t(locked ? 'unresolvedSubscription' : 'subscriptionAuthority') : undefined}>
              <ReviewedAction
                key={revision}
                title={c.t(action === 'pause' ? 'pauseSubscription' : action === 'resume' ? 'resumeSubscription' : 'cancelSubscription')}
                description={c.t(action === 'pause' ? 'pauseEffect' : action === 'resume' ? 'resumeEffect' : 'cancelEffect')}
                review={
                  <PayDetails
                    values={[
                      [c.t('subscriptionId'), s.id],
                      [c.t('customer'), s.customerId],
                      [c.t('nextRun'), <PayTime value={s.nextRunAt} />],
                    ]}
                  />
                }
                disabled={disabled}
                perform={async () => {
                  try {
                    if (action === 'resume') {
                      const result = await pay.mutate(
                        'subscription.resume',
                        { subscriptionId: s.id },
                        z.object({ subscription: subscriptionSchema, projectedEnd: z.string().nullable() }),
                        'pay:write',
                        `subscription:${s.id}`,
                        'active',
                      );
                      if (result.ok) setProjected(result.data.projectedEnd);
                      return result.ok ? { ok: true as const, data: result.data.subscription } : result;
                    }
                    return await pay.mutate(
                      `subscription.${action}`,
                      { subscriptionId: s.id },
                      subscriptionSchema,
                      'pay:write',
                      `subscription:${s.id}`,
                      action === 'pause' ? 'paused' : 'cancelled',
                    );
                  } finally {
                    refreshLock((v) => v + 1);
                  }
                }}
                onConfirmed={reload}
              />
            </span>
          ))}
      </div>
      {projected !== undefined && (
        <p role="status">
          {c.t('projectedEnd')}: {projected ? <PayTime value={projected} /> : c.t('openEnded')}
        </p>
      )}
    </div>
  );
}
function CreateSubscription({ portal, merchantId, pay }: { portal: PortalApi; merchantId: string; pay: BusinessPayApi | null }) {
  const mandates = useResource((signal) => portal.mandates(merchantId, signal), `portal:mandates:${merchantId}`);
  const posture = useResource((signal) => portal.subscriptionPosture(signal), 'portal:subscription-posture');
  return (
    <CreateSubscriptionView
      mandates={mandates.resource}
      posture={posture.resource}
      pay={pay}
      reload={() => {
        mandates.reload();
        posture.reload();
      }}
    />
  );
}
export function CreateSubscriptionView({
  mandates,
  posture,
  pay,
  reload,
}: {
  mandates: Resource<Mandate[]>;
  posture: Resource<z.infer<typeof subscriptionPostureSchema>>;
  pay: BusinessPayApi | null;
  reload: () => void;
}) {
  const [revision, setRevision] = useState(0);
  // Refresh guard state without remounting an in-flight confirmation.
  const [, refreshLock] = useState(0);
  const [mandateId, setMandateId] = useState('');
  const [path, setPath] = useState('');
  const [created, setCreated] = useState('');
  useUnsavedForm(Boolean(mandateId || path), c.t('draftWarning'));
  const choices = mandates.status === 'ready' ? mandates.data.filter((m) => m.status === 'active') : [];
  const selected = choices.find((m) => m.id === mandateId);
  const locked = Boolean(pay && mandateId && pay.guard.status(`${pay.authority!.userId}:subscription-create:${mandateId}`));
  const allowed = posture.status === 'ready' && posture.data.paths.some((p) => p.path === path && p.charge !== 'refuse');
  return (
    <div className="stack">
      <PaySection title={c.t('railPosture')}>
        <Gate resource={posture} retry={reload}>
          {() => <p className="pp-callout">{c.t('railPostureBody')}</p>}
        </Gate>
      </PaySection>
      <PaySection title={c.t('createSubscription')}>
        <Gate resource={mandates} retry={reload}>
          {() =>
            choices.length ? (
              <div className="form-stack pp-form">
                <SelectField
                  label={c.t('chooseMandate')}
                  value={mandateId}
                  onChange={setMandateId}
                  hint={c.t('chooseMandateHint')}
                  options={[
                    ['', c.t('selectMandate')],
                    ...choices.map((m) => [m.id, `${m.customerId} · ${m.amount} ${m.assetId} · ${m.cadence}`] as const),
                  ]}
                />
                <SelectField
                  label={c.t('choosePath')}
                  value={path}
                  onChange={setPath}
                  options={[
                    ['', c.t('selectPath')],
                    ...(posture.status === 'ready'
                      ? posture.data.paths
                          .filter((p) => p.charge !== 'refuse')
                          .map((p) => [p.path, p.path === 'crypto_invoice' ? c.t('cryptoInvoice') : p.path] as const)
                      : []),
                  ]}
                />
                {selected && <SubscriptionTerms mandate={selected} path={path} />}
                {pay && locked && (
                  <SubscriptionRecovery
                    key={`${pay.authority!.userId}:${mandateId}`}
                    check={(current) => checkSubscriptionCreateOriginal(pay, mandateId, current)}
                    onKnown={(data) => {
                      setCreated(data.id);
                      setMandateId('');
                      setPath('');
                      setRevision((v) => v + 1);
                      reload();
                    }}
                  />
                )}
                {pay ? (
                  <span
                    title={
                      locked
                        ? c.t('unresolvedSubscription')
                        : !selected || !allowed
                          ? c.t('termsGap')
                          : pay.access('pay:write')
                            ? c.t('subscriptionAuthority')
                            : undefined
                    }
                  >
                    <ReviewedAction
                      key={`${mandateId}:${revision}`}
                      title={c.t('createSubscription')}
                      description={c.t('subscriptionCreateReview')}
                      review={selected && <SubscriptionTerms mandate={selected} path={path} />}
                      disabled={!selected || !allowed || Boolean(pay.access('pay:write')) || locked}
                      perform={async () => {
                        try {
                          return await pay.mutate(
                            'subscription.create',
                            { mandateId, path },
                            subscriptionSchema,
                            'pay:write',
                            `subscription-create:${mandateId}`,
                            JSON.stringify({ path, after: new Date().toISOString() }),
                          );
                        } finally {
                          refreshLock((v) => v + 1);
                        }
                      }}
                      onConfirmed={(data) => {
                        setCreated(data.id);
                        setMandateId('');
                        setPath('');
                        reload();
                      }}
                    />
                  </span>
                ) : (
                  <p className="pp-callout" role="status">
                    {c.t('subscriptionAuthority')}
                  </p>
                )}
              </div>
            ) : (
              <EmptyState title={c.t('chooseMandate')}>{c.t('noMandates')}</EmptyState>
            )
          }
        </Gate>
        {created && (
          <a className="text-link" href={`/pay/subscriptions/${encodeURIComponent(created)}`}>
            {c.t('subscriptionTitle')}: {created}
          </a>
        )}
      </PaySection>
      <Arrives>{c.t('termsGap')}</Arrives>
      {pay && <CreateMandate pay={pay} refresh={reload} />}
    </div>
  );
}
