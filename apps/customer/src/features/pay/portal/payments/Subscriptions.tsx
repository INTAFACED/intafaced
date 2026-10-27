import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useSession } from '../../../session/session';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button, DataTable } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { PayDetails, PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { CreateMandate } from '../../MerchantBilling';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { executionSchema, mandateSchema, subscriptionSchema, subscriptionPostureSchema, id } from '../../schemas';
import { CopyReference, PortalBack, ReadStamp, WindowExport } from '../ExtensionTools';
import { Gate, Money, PortalFailure, PortalLoading, SelectField, Timeline } from '../components';
import { DateTime } from '../ui/DateTime';
import { formatDateTime } from '../ui/format';
import { uiCopy } from '../ui/copy';
import { EntityList } from '../ui/EntityList';
import { dateRange, FilterRow, useListFilters, type DatePreset, type ListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { StatusChip, ToneChip } from '../ui/StatusChip';
import { useServerList } from '../ui/useServerList';
import { useNow, useReadAt, useUrlParam, type ListState } from '../hooks';
import { useUnsavedForm } from '../useUnsavedForm';
import { extensionCopy as c } from './copy';
import type { PortalApi } from '../api';
import type { Cycle } from './billing-schemas';
import type { PortalRoute } from '../routes';
import type { ApiResult } from '../../../../shared/api';
import { checkSubscriptionOriginal, createSubscriptionWithRecovery, replaySubscriptionCreate } from './subscription-recovery';
import { definite } from './not-available';
import { SubscriptionPriceFact, SubscriptionPricePicker, subscriptionPriceLabel } from '../catalog/SubscriptionPrice';

type Subscription = z.infer<typeof subscriptionSchema>;
type Mandate = z.infer<typeof mandateSchema>;
type Execution = z.infer<typeof executionSchema>;
const statuses = ['active', 'paused', 'cancelled', 'completed'] as const;
/**
 * When the next run is due. An active schedule whose next run is already in the past has not had that run recorded
 * (the service moves the date forward as each run is recorded), so it says so instead of naming a time that has gone.
 */
export function NextRun({ status, nextRunAt }: { status: string; nextRunAt: string }) {
  const now = useNow();
  const { requestedLocale } = uiCopy.useCopy();
  if (status !== 'active') return <>{c.t('noNextRun')}</>;
  const due = Date.parse(nextRunAt);
  if (!Number.isFinite(due) || due > now) return <DateTime value={nextRunAt} />;
  const time = formatDateTime(nextRunAt, requestedLocale)?.short ?? nextRunAt;
  return <>{c.t('nextRunOverdue', { time })}</>;
}

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
/** Plain words for a charge path and a billing cadence, so no raw service value reaches the screen. */
export const pathLabel = (path: string) =>
  path === 'crypto_invoice'
    ? c.t('cryptoInvoice')
    : path === 'card'
      ? c.t('pathCard')
      : path === 'card_mandate'
        ? c.t('pathCardMandate')
        : path;
export const cadenceLabel = (cadence: Mandate['cadence']) => c.t(`cadence_${cadence}`);
const subscriptionTone = { active: 'done', paused: 'action', cancelled: 'progress', completed: 'done' } as const;
export function SubscriptionChip({ status }: { status: Subscription['status'] }) {
  return <ToneChip tone={subscriptionTone[status]} label={c.t(status)} tip={c.t(`subscription_${status}`)} />;
}
const cycleTone = { settled: 'done', rejected: 'failed', pending: 'progress', invoiced: 'progress', skipped: 'progress' } as const;
export function CycleChip({ status }: { status: Cycle['status'] }) {
  return <ToneChip tone={cycleTone[status]} label={c.t(status)} tip={c.t(`cycle_${status}`)} />;
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
  // The amount and cadence belong to the mandate each subscription runs on, so they are read once and joined by mandate.
  const mandates = useResource((signal) => portal.mandates(merchantId, signal), `portal:mandates:${merchantId}`);
  return (
    <SubscriptionsView
      list={list.state}
      mandates={mandates.resource}
      filters={filters}
      mandateId={mandateFilter}
      loadMore={list.loadMore}
      reload={() => list.reload()}
    />
  );
}
export function SubscriptionsView({
  list,
  mandates,
  filters,
  mandateId,
  loadMore,
  reload,
}: {
  list: ListState<Subscription>;
  /** The mandates the subscriptions run on. While they are not read, the amount and cadence columns say so. */
  mandates?: Resource<Mandate[]>;
  filters: ListFilters;
  mandateId?: string;
  loadMore: () => void;
  reload: () => void;
}) {
  const at = useReadAt(list.status === 'ready', list);
  const rows = list.status === 'ready' ? list.items.filter((s) => !mandateId || s.mandateId === mandateId) : [];
  const filtered = Boolean(filters.status || filters.search || filters.date || mandateId);
  const terms = (s: Subscription) =>
    mandates?.status === 'ready'
      ? (mandates.data.find((m) => m.id === s.mandateId) ?? null)
      : mandates?.status === 'loading'
        ? undefined
        : null;
  const amountCell = (s: Subscription) => {
    const m = terms(s);
    return m ? <Money value={m.amount} asset={m.assetId} /> : m === undefined ? '…' : c.t('termsNotShown');
  };
  const cadenceCell = (s: Subscription) => {
    const m = terms(s);
    return m ? cadenceLabel(m.cadence) : m === undefined ? '…' : c.t('termsNotShown');
  };
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
                { header: c.t('amountPerCycle'), cell: amountCell },
                { header: c.t('cadence'), cell: cadenceCell },
                { header: c.t('chargePath'), cell: (s) => pathLabel(s.path) },
                { header: c.t('status'), cell: (s) => <StatusChip entity="subscription" value={s.status} /> },
                { header: c.t('nextRun'), cell: (s) => <NextRun status={s.status} nextRunAt={s.nextRunAt} /> },
              ]}
              card={(s) => ({
                title: s.customerId,
                time: <NextRun status={s.status} nextRunAt={s.nextRunAt} />,
                amount: (
                  <>
                    {amountCell(s)}
                    {terms(s) ? ` · ${cadenceCell(s)}` : ''}
                  </>
                ),
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
                headers={[
                  'subscription_id',
                  'customer_reference',
                  'mandate_id',
                  'amount',
                  'asset',
                  'cadence',
                  'status',
                  'charge_path',
                  'scheduled_run',
                  'created_at',
                ]}
                rows={rows.map((s) => {
                  const m = terms(s);
                  return [
                    s.id,
                    s.customerId,
                    s.mandateId,
                    m?.amount ?? '',
                    m?.assetId ?? '',
                    m?.cadence ?? '',
                    s.status,
                    s.path,
                    s.nextRunAt,
                    s.createdAt,
                  ];
                })}
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
      price={<SubscriptionPriceFact portal={portal} priceId={subscription.priceId} />}
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
  price,
  reload,
}: {
  subscription: Subscription;
  mandate: Resource<Mandate>;
  cycles: Resource<{ subscriptionId: string; cycles: Cycle[] }>;
  executions: Resource<Execution[]>;
  pay: BusinessPayApi | null;
  /** The catalogue price it runs on, read in the catalogue's words. */
  price?: ReactNode;
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
            [c.t('status'), <SubscriptionChip status={subscription.status} />],
            [c.t('chargePath'), pathLabel(subscription.path)],
            [c.t('nextRun'), <NextRun status={subscription.status} nextRunAt={subscription.nextRunAt} />],
            ...(price ? [[subscriptionPriceLabel(), price] as [string, ReactNode]] : []),
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
                [c.t('mandateStatusLabel'), c.t(`mandate_${m.status}`)],
                [c.t('cadence'), cadenceLabel(m.cadence)],
                [c.t('mandateStart'), <DateTime value={m.startsAt} />],
                [c.t('mandateEnd'), m.endsAt ? <DateTime value={m.endsAt} /> : c.t('openEnded')],
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
                  headers={[c.t('occurrence'), c.t('amount'), c.t('status'), c.t('attempts'), c.t('payment')]}
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
                      <td>
                        {cycle.paymentId ? (
                          <a className="text-link" href={`/pay/payments/${encodeURIComponent(cycle.paymentId)}`}>
                            {c.t('openPayment')}
                          </a>
                        ) : (
                          c.t('noPayment')
                        )}
                      </td>
                    </tr>
                  ))}
                </DataTable>
                <p role="status">{data.cycles.length === 1 ? c.t('cyclesShownOne') : c.t('cyclesShown', { count: data.cycles.length })}</p>
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
                      <DateTime value={e.attemptedAt} />
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
              <EmptyState title={c.t('emptyExecutions')}>{c.t('emptyExecutionsBody')}</EmptyState>
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
  outcomeShown = false,
}: {
  /** True when the review above already says the outcome is not confirmed: the general notice is then left out. */
  outcomeShown?: boolean;
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
      {/* One message about the unconfirmed request: the latest check's answer replaces the general notice. */}
      {(message || !outcomeShown) && (
        <p className="pp-callout" role="status">
          {message || c.t('unresolvedSubscription')}
        </p>
      )}
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
    </div>
  );
}
export function SubscriptionTerms({ mandate: m, path }: { mandate: Mandate; path: string }) {
  return (
    <PayDetails
      values={[
        [c.t('customer'), m.customerId],
        [c.t('chargePath'), path ? pathLabel(path) : c.t('unavailable')],
        [c.t('amount'), <Money value={m.amount} asset={m.assetId} />],
        [c.t('cadence'), cadenceLabel(m.cadence)],
        [c.t('mandateStart'), <DateTime value={m.startsAt} />],
        [c.t('mandateEnd'), m.endsAt ? <DateTime value={m.endsAt} /> : c.t('openEnded')],
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
                      [c.t('nextRun'), <DateTime value={s.nextRunAt} />],
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
                      return definite(result.ok ? { ok: true as const, data: result.data.subscription } : result);
                    }
                    return definite(
                      await pay.mutate(
                        `subscription.${action}`,
                        { subscriptionId: s.id },
                        subscriptionSchema,
                        'pay:write',
                        `subscription:${s.id}`,
                        action === 'pause' ? 'paused' : 'cancelled',
                      ),
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
          {c.t('projectedEnd')}: {projected ? <DateTime value={projected} /> : c.t('openEnded')}
        </p>
      )}
    </div>
  );
}
function CreateSubscription({ portal, merchantId, pay }: { portal: PortalApi; merchantId: string; pay: BusinessPayApi | null }) {
  const mandates = useResource((signal) => portal.mandates(merchantId, signal), `portal:mandates:${merchantId}`);
  const posture = useResource((signal) => portal.subscriptionPosture(signal), 'portal:subscription-posture');
  const open = useResource((signal) => portal.subscriptions(merchantId, 200, signal), `portal:subscriptions-open:${merchantId}`);
  return (
    <CreateSubscriptionView
      mandates={mandates.resource}
      subscriptions={open.resource}
      posture={posture.resource}
      pay={pay}
      portal={portal}
      reload={() => {
        mandates.reload();
        posture.reload();
        // the list of open subscriptions decides which mandates are still offered
        open.reload();
      }}
    />
  );
}
export function CreateSubscriptionView({
  mandates,
  subscriptions,
  posture,
  pay,
  portal,
  reload,
}: {
  mandates: Resource<Mandate[]>;
  /** The subscriptions already running, so a mandate that has an open one is not offered again. */
  subscriptions?: Resource<Subscription[]>;
  posture: Resource<z.infer<typeof subscriptionPostureSchema>>;
  pay: BusinessPayApi | null;
  portal?: PortalApi;
  reload: () => void;
}) {
  const [revision, setRevision] = useState(0);
  // Refresh guard state without remounting an in-flight confirmation.
  const [, refreshLock] = useState(0);
  const [mandateId, setMandateId] = useUrlParam('mandateId');
  const [draftPath, setPath] = useState('');
  const recovered = pay && mandateId ? pay.guard.original(`${pay.authority!.userId}:subscription-create:${mandateId}`)?.value : undefined;
  const recoveredPath = recovered?.path;
  const path = recoveredPath ?? draftPath;
  // The catalogue price chosen for this mandate; a create being recovered keeps the one it was sent with.
  const [draftPrice, setPrice] = useState('');
  useEffect(() => setPrice(''), [mandateId]);
  const recoveredPrice = recovered ? (recovered.priceId ?? '') : undefined;
  const priceId = recoveredPrice ?? draftPrice;
  const [created, setCreated] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  useUnsavedForm(Boolean(mandateId || path), c.t('draftWarning'));
  const taken = new Set(
    subscriptions?.status === 'ready'
      ? subscriptions.data.filter((x) => x.status === 'active' || x.status === 'paused').map((x) => x.mandateId)
      : [],
  );
  // A mandate that already has an open subscription cannot start a second one; the one being recovered stays listed.
  const choices =
    mandates.status === 'ready' ? mandates.data.filter((m) => m.status === 'active' && (!taken.has(m.id) || m.id === mandateId)) : [];
  const selected = choices.find((m) => m.id === mandateId);
  const locked = Boolean(pay && mandateId && pay.guard.status(`${pay.authority!.userId}:subscription-create:${mandateId}`));
  // The mandate whose create reply was lost and is said so by the review itself (it is forgotten when the choice changes).
  const [uncertainShown, setUncertainShown] = useState('');
  useEffect(() => setUncertainShown(''), [mandateId]);
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
              <div data-testid="form-stack" className="form-stack pp-form">
                <SelectField
                  label={c.t('chooseMandate')}
                  value={mandateId}
                  onChange={setMandateId}
                  hint={c.t('chooseMandateHint')}
                  options={[
                    ['', c.t('selectMandate')],
                    ...choices.map((m) => [m.id, `${m.customerId} · ${m.amount} ${m.assetId} · ${cadenceLabel(m.cadence)}`] as const),
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
                      ? [[recoveredPath, pathLabel(recoveredPath)] as const]
                      : posture.status === 'ready'
                        ? posture.data.paths.filter((p) => p.charge !== 'refuse').map((p) => [p.path, pathLabel(p.path)] as const)
                        : []),
                  ]}
                />
                {selected && portal && (
                  <SubscriptionPricePicker
                    portal={portal}
                    mandate={selected}
                    value={priceId}
                    onChange={setPrice}
                    disabled={recoveredPrice !== undefined}
                  />
                )}
                {selected && <SubscriptionTerms mandate={selected} path={path} />}
                {pay && locked && (
                  <SubscriptionRecovery
                    key={`${pay.authority!.userId}:${mandateId}`}
                    outcomeShown={uncertainShown === mandateId}
                    check={(current) => replaySubscriptionCreate(pay, mandateId, path, current, priceId || undefined)}
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
                        // "Still not confirmed" is already said by the check itself; only a real refusal is added.
                        if (result.reason !== 'uncertain' && result.reason !== 'aborted') setCreateNotice(result.message);
                      }
                      refreshLock((v) => v + 1);
                    }}
                  />
                )}
                {createNotice && <p role="status">{createNotice}</p>}
                {mandateId && (
                  <a className="text-link" href={`/pay/subscriptions?mandateId=${encodeURIComponent(mandateId)}`}>
                    {taken.has(mandateId) ? c.t('openExisting') : c.t('subscriptionsTitle')}
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
                      review={
                        selected && (
                          <>
                            <SubscriptionTerms mandate={selected} path={path} />
                            {priceId && portal && (
                              <p>
                                {subscriptionPriceLabel()}: <SubscriptionPriceFact portal={portal} priceId={priceId} />
                              </p>
                            )}
                          </>
                        )
                      }
                      disabled={!selected || !allowed || Boolean(pay.access('pay:write')) || locked}
                      perform={async () => {
                        try {
                          const result = await createSubscriptionWithRecovery(pay, mandateId, path, priceId || undefined);
                          setUncertainShown(!result.ok && result.reason === 'uncertain' ? mandateId : '');
                          // An unconfirmed reply is shown once, by the review and the check below it.
                          if (!result.ok && result.reason !== 'uncertain') setCreateNotice(result.message);
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
                        setPrice('');
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
              <EmptyState title={c.t('chooseMandate')}>
                {mandates.status === 'ready' && mandates.data.some((m) => m.status === 'active')
                  ? c.t('allMandatesTaken')
                  : c.t('noMandates')}
              </EmptyState>
            )
          }
        </Gate>
        {created && (
          <a className="text-link" href={`/pay/subscriptions/${encodeURIComponent(created)}`}>
            {c.t('openNewSubscription')}
          </a>
        )}
      </PaySection>
      {pay && <CreateMandate pay={pay} refresh={reload} portal={portal} />}
    </div>
  );
}
