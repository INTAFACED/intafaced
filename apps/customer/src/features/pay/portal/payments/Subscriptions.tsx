import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useSession } from '../../../session/session';
import { useResource, type Resource } from '../../../../shared/resource';
import { StatusTag, Button, DataTable } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { PayDetails, PaySection, PayTime } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { CreateMandate } from '../../MerchantBilling';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { executionSchema, mandateSchema, subscriptionSchema, subscriptionPostureSchema, id } from '../../schemas';
import { CopyReference, PortalBack, ReadStamp, WindowExport } from '../ExtensionTools';
import { Gate, Money, PortalFailure, PortalLoading, SelectField, Timeline } from '../components';
import { DateTime } from '../ui/DateTime';
import { EntityList } from '../ui/EntityList';
import { dateRange, FilterRow, useListFilters, type DatePreset, type ListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { StatusChip } from '../ui/StatusChip';
import { useServerList } from '../ui/useServerList';
import { useReadAt, useUrlParam, type ListState } from '../hooks';
import { useUnsavedForm } from '../useUnsavedForm';
import { extensionCopy as c } from './copy';
import type { PortalApi } from '../api';
import type { Cycle } from './billing-schemas';
import type { PortalRoute } from '../routes';
import type { ApiResult } from '../../../../shared/api';
import { checkSubscriptionOriginal, createSubscriptionWithRecovery, replaySubscriptionCreate } from './subscription-recovery';

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
      <Button
        variant="primary"
        nativeButton={false}
        role="link"
        render={<a href={route.room === 'subscription-new' ? '/pay/subscriptions' : '/pay/subscriptions/new'} />}
      >
        {c.t(route.room === 'subscription-new' ? 'subscriptionsTitle' : 'createSubscription')}
      </Button>
    ),
  };
}
export function SubscriptionChip({ status }: { status: Subscription['status'] }) {
  return <StatusTag status={status === 'active' ? 'filled' : 'working'} title={c.t(`subscription_${status}`)} label={c.t(status)} />;
}
export function CycleChip({ status }: { status: Cycle['status'] }) {
  return (
    <StatusTag
      status={status === 'settled' ? 'filled' : status === 'rejected' ? 'failed' : 'working'}
      title={c.t(`cycle_${status}`)}
      label={c.t(status)}
    />
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
  const filters = useListFilters();
  const [mandateFilter] = useUrlParam('mandateId');
  const range = dateRange(filters.date as DatePreset, Date.now(), { from: filters.from, to: filters.to });
  const query = { status: filters.status, search: filters.search.trim(), from: range.from ?? '', to: range.to ?? '' };
  const list = useServerList(
    (f, cursor, signal) => portal.subscriptionPage(merchantId, f, cursor, signal),
    query,
    (s: Subscription) => s.id,
  );
  return (
    <SubscriptionsView
      list={list.state}
      filters={filters}
      mandateId={mandateFilter}
      loadMore={list.loadMore}
      reload={() => list.reload()}
    />
  );
}
export function SubscriptionsView({
  list,
  filters,
  mandateId,
  loadMore,
  reload,
}: {
  list: ListState<Subscription>;
  filters: ListFilters;
  mandateId?: string;
  loadMore: () => void;
  reload: () => void;
}) {
  const at = useReadAt(list.status === 'ready', list);
  const rows = list.status === 'ready' ? list.items.filter((s) => !mandateId || s.mandateId === mandateId) : [];
  const filtered = Boolean(filters.status || filters.search || filters.date || mandateId);
  return (
    <div className="stack">
      <Freshness asOf={at} />
      <FilterRow
        label={c.t('subscriptionsTitle')}
        filters={filters}
        statuses={statuses.map((v) => [v, c.t(v)] as const)}
        {...(list.status === 'ready' ? { shown: rows.length, hasMore: list.hasMore } : {})}
      />
      {list.status === 'loading' && <PortalLoading />}
      {list.status === 'failed' && <PortalFailure result={list.failure} retry={reload} />}
      {list.status === 'ready' &&
        (rows.length === 0 ? (
          <EmptyState
            title={filtered ? c.t('noSubscriptionsMatch') : c.t('emptySubscriptions')}
            action={
              filtered ? undefined : (
                <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/subscriptions/new" />}>
                  {c.t('createSubscription')}
                </Button>
              )
            }
          >
            {filtered ? c.t('noSubscriptionsMatchBody') : c.t('emptySubscriptionsBody')}
          </EmptyState>
        ) : (
          <>
            <EntityList
              label={c.t('subscriptionsTitle')}
              rows={rows}
              rowKey={(s) => s.id}
              href={(s) => `/pay/subscriptions/${encodeURIComponent(s.id)}`}
              columns={[
                {
                  header: c.t('customer'),
                  cell: (s) => (
                    <>
                      <strong>{s.customerId}</strong>
                      {s.stallReason && <small className="pay-cell-note">{c.t(`stall_${s.stallReason}`)}</small>}
                    </>
                  ),
                },
                { header: c.t('chargePath'), cell: (s) => s.path },
                { header: c.t('status'), cell: (s) => <StatusChip entity="subscription" value={s.status} /> },
                { header: c.t('nextRun'), cell: (s) => (s.status === 'active' ? <DateTime value={s.nextRunAt} /> : c.t('noNextRun')) },
              ]}
              card={(s) => ({
                title: s.customerId,
                time: s.status === 'active' ? <DateTime value={s.nextRunAt} /> : c.t('noNextRun'),
                status: <StatusChip entity="subscription" value={s.status} />,
              })}
            />
            <div className="pp-actions">
              {list.hasMore && (
                <Button variant="secondary" onClick={loadMore} disabled={list.more === 'loading'}>
                  {list.more === 'loading' ? c.t('pay_loadingMore') : c.t('pay_loadMore')}
                </Button>
              )}
              <WindowExport
                name="subscriptions"
                at={at}
                headers={['subscription_id', 'customer_reference', 'mandate_id', 'status', 'charge_path', 'scheduled_run', 'created_at']}
                rows={rows.map((s) => [s.id, s.customerId, s.mandateId, s.status, s.path, s.nextRunAt, s.createdAt])}
              />
            </div>
          </>
        ))}
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
          <SubscriptionActions
            subscription={subscription}
            pay={pay}
            reload={reload}
            terms={mandate.status === 'ready' ? mandate.data : null}
          />
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
  onSettled,
}: {
  check: (current: () => boolean) => Promise<ApiResult<Subscription>>;
  onKnown: (subscription: Subscription) => void;
  onSettled?: (result: ApiResult<Subscription>) => void;
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
            else
              setMessage(
                result.reason === 'uncertain' || result.reason === 'aborted' ? c.t('subscriptionStillUnresolved') : result.message,
              );
            onSettled?.(result);
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
function SubscriptionActions({
  subscription: s,
  pay,
  reload,
  terms,
}: {
  subscription: Subscription;
  pay: BusinessPayApi;
  reload: () => void;
  terms: Mandate | null;
}) {
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
              <PortalReview
                key={revision}
                title={c.t(action === 'pause' ? 'pauseSubscription' : action === 'resume' ? 'resumeSubscription' : 'cancelSubscription')}
                description={c.t(action === 'pause' ? 'pauseEffect' : action === 'resume' ? 'resumeEffect' : 'cancelEffect')}
                review={
                  <PayDetails
                    values={[
                      [c.t('subscriptionId'), s.id],
                      [c.t('customer'), s.customerId],
                      ...(terms ? [[c.t('amount'), <Money value={terms.amount} asset={terms.assetId} />] as [string, ReactNode]] : []),
                      [c.t('nextRun'), <PayTime value={s.nextRunAt} />],
                      ...(action === 'cancel'
                        ? [
                            [c.t('cancelNextCycle'), s.status === 'active' ? c.t('cancelNextCycleBody') : c.t('cancelPausedBody')] as [
                              string,
                              ReactNode,
                            ],
                          ]
                        : []),
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
  const [mandateId, setMandateId] = useUrlParam('mandateId');
  const [draftPath, setPath] = useState('');
  const recoveredPath =
    pay && mandateId ? pay.guard.original(`${pay.authority!.userId}:subscription-create:${mandateId}`)?.value.path : undefined;
  const path = recoveredPath ?? draftPath;
  const [created, setCreated] = useState('');
  const [createNotice, setCreateNotice] = useState('');
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
                  disabled={Boolean(recoveredPath)}
                  value={path}
                  onChange={setPath}
                  options={[
                    ['', c.t('selectPath')],
                    ...(recoveredPath
                      ? [[recoveredPath, recoveredPath === 'crypto_invoice' ? c.t('cryptoInvoice') : recoveredPath] as const]
                      : posture.status === 'ready'
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
                    check={(current) => replaySubscriptionCreate(pay, mandateId, path, current)}
                    onKnown={(data) => {
                      setCreateNotice('');
                      setCreated(data.id);
                      setMandateId('');
                      setPath('');
                      setRevision((v) => v + 1);
                      reload();
                    }}
                    onSettled={(result) => {
                      if (!result.ok) {
                        setPath(path);
                        setCreateNotice(result.message);
                      }
                      refreshLock((v) => v + 1);
                    }}
                  />
                )}
                {createNotice && <p role="status">{createNotice}</p>}
                {mandateId && (
                  <a className="text-link" href={`/pay/subscriptions?mandateId=${encodeURIComponent(mandateId)}`}>
                    {c.t('subscriptionsTitle')}
                  </a>
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
                    <PortalReview
                      key={`${mandateId}:${revision}`}
                      title={c.t('createSubscription')}
                      description={c.t('subscriptionCreateReview')}
                      review={selected && <SubscriptionTerms mandate={selected} path={path} />}
                      disabled={!selected || !allowed || Boolean(pay.access('pay:write')) || locked}
                      perform={async () => {
                        try {
                          const result = await createSubscriptionWithRecovery(pay, mandateId, path);
                          if (!result.ok) setCreateNotice(result.message);
                          return result;
                        } finally {
                          refreshLock((v) => v + 1);
                        }
                      }}
                      onConfirmed={(data) => {
                        setCreateNotice('');
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
      {pay && <CreateMandate pay={pay} refresh={reload} />}
    </div>
  );
}
