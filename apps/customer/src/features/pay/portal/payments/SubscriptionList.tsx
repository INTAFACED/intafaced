// volt-room: /pay/subscriptions
// volt-room: /pay/subscriptions/:subscriptionId
// volt-room: portal:subscriptions
// volt-room: portal:subscription
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { Button } from '@intafaced/ui/lit';
import { useSession } from '../../../session';
import { useResource, type Resource } from '../../../../shared/resource';
import type { ApiResult } from '../../../../shared/api';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import { executionSchema, mandateSchema, subscriptionSchema, id } from '../../schemas';
import { useMerchantAccess } from '../access/MerchantAccess';
import {
  CopyReference,
  Details,
  Empty,
  EntityList,
  Failure,
  FilterRow,
  Freshness,
  Gate,
  Grid,
  LinkButton,
  Loading,
  MoneyText,
  Section,
  StatusChip,
  Timeline,
  ToneChip,
} from '../volt/parts';
import { Review } from '../volt/Review';
import { RecordListRoom, type RecordListSlots } from '../volt/RecordListRoom';
import { DateTime } from '../ui/DateTime';
import { formatDateTime } from '../ui/format';
import { uiCopy } from '../ui/copy';
import { dateRange, useListFilters, type DatePreset, type ListFilters } from '../ui/FilterRow';
import { useServerList } from '../ui/useServerList';
import { useNow, useReadAt, useUrlParam, type ListState } from '../hooks';
import { buildCsv, downloadText } from '../csv';
import type { PortalApi } from '../api';
import { SubscriptionPriceFact } from '../catalog/PriceFact';
import { subscriptionPriceLabel } from '../catalog/SubscriptionPrice';
import { extensionCopy as c } from './copy';
import type { Cycle } from './billing-schemas';
import { checkSubscriptionOriginal, pauseOrCancelSubscription } from './subscription-recovery';
import { cadenceLabel, pathLabel } from './subscription-words';
import { definite } from './not-available';
import { PAY_SUBSCRIPTION_RESUME } from '@intafaced/contracts/pay-subscription-procedures';

type Subscription = z.infer<typeof subscriptionSchema>;
type Mandate = z.infer<typeof mandateSchema>;
type Execution = z.infer<typeof executionSchema>;
const statuses = ['active', 'paused', 'cancelled', 'completed'] as const;

/**
 * `/pay/subscriptions` and `/pay/subscriptions/:subscriptionId` on the record-list template: the business's recurring
 * schedules with their filters and export, or one schedule's own page. The owner alone reads them.
 */
export function SubscriptionsRoom({
  portal,
  subscriptionId,
  authority,
}: {
  portal: PortalApi;
  subscriptionId?: string;
  authority: PayBusinessAuthority | null;
}) {
  const { access, can } = useMerchantAccess();
  // Until the business is known (and the person may read schedules), the template draws its own loading, refusal and role states.
  if (access.status !== 'ready' || !can('owner')) return <RecordListRoom need="owner">{() => ({})}</RecordListRoom>;
  return subscriptionId ? (
    <SubscriptionPage portal={portal} merchantId={access.merchantId} subscriptionId={subscriptionId} authority={authority} />
  ) : (
    <SubscriptionsPage portal={portal} merchantId={access.merchantId} />
  );
}

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

const subscriptionTone = { active: 'done', paused: 'action', cancelled: 'progress', completed: 'done' } as const;
function SubscriptionChip({ status }: { status: Subscription['status'] }) {
  return <ToneChip tone={subscriptionTone[status]} label={c.t(status)} tip={c.t(`subscription_${status}`)} />;
}
const cycleTone = { settled: 'done', rejected: 'failed', pending: 'progress', invoiced: 'progress', skipped: 'progress' } as const;
function CycleChip({ status }: { status: Cycle['status'] }) {
  return <ToneChip tone={cycleTone[status]} label={c.t(status)} tip={c.t(`cycle_${status}`)} />;
}

/** When the figures were read, and a calm warning once they are more than five minutes old. */
function ReadStamp({ at }: { at: string | null }) {
  const now = useNow();
  if (!at) return null;
  return (
    <div className="lt-stack" role="status">
      <p className="lt-hint">
        {c.t('readAt')} <DateTime value={at} />
      </p>
      {now - Date.parse(at) > 300_000 && <p className="lt-stale">{c.t('staleRead')}</p>}
    </div>
  );
}

/** The records shown, as a CSV file stamped with when they were read. */
function WindowExport({ headers, rows, at, name }: { headers: string[]; rows: unknown[][]; at: string | null; name: string }) {
  return (
    <Button
      tone="secondary"
      disabled={!at || !rows.length}
      onClick={() => {
        if (at) downloadText(`${name}.csv`, buildCsv(headers, rows, { generatedAt: new Date().toISOString(), asOf: at }));
      }}
    >
      {c.t('exportShown')}
    </Button>
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
  const slots = useSubscriptionSlots({
    list: list.state,
    mandates: mandates.resource,
    filters,
    mandateId: mandateFilter,
    loadMore: list.loadMore,
    reload: () => list.reload(),
  });
  return <RecordListRoom need="owner">{() => slots}</RecordListRoom>;
}

type SubscriptionsViewProps = {
  list: ListState<Subscription>;
  /** The mandates the subscriptions run on. While they are not read, the amount and cadence columns say so. */
  mandates?: Resource<Mandate[]>;
  filters: ListFilters;
  mandateId?: string;
  loadMore: () => void;
  reload: () => void;
};

/** The subscriptions page, every region in one column: the same parts the room hands its template. */
export function SubscriptionsView(props: SubscriptionsViewProps) {
  const slots = useSubscriptionSlots(props);
  return (
    <div className="lt-stack">
      {slots.tools}
      {slots.filters}
      {slots.summary}
      {slots.list}
      {slots.export}
    </div>
  );
}

/** The regions of the subscriptions list for the record-list template. */
function useSubscriptionSlots({ list, mandates, filters, mandateId, loadMore, reload }: SubscriptionsViewProps): RecordListSlots {
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
    return m ? <MoneyText value={m.amount} asset={m.assetId} /> : m === undefined ? '…' : c.t('termsNotShown');
  };
  const cadenceCell = (s: Subscription) => {
    const m = terms(s);
    return m ? cadenceLabel(m.cadence) : m === undefined ? '…' : c.t('termsNotShown');
  };
  return {
    tools: (
      <a className="lt-link" href="/pay/merchant">
        {c.t('backHome')}
      </a>
    ),
    filters: (
      <FilterRow
        label={c.t('subscriptionsTitle')}
        filters={filters}
        statuses={statuses.map((v) => [v, c.t(v)] as const)}
        {...(list.status === 'ready' ? { shown: rows.length, hasMore: list.hasMore } : {})}
      />
    ),
    summary: <Freshness asOf={at} />,
    export:
      list.status === 'ready' && rows.length > 0 ? (
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
      ) : undefined,
    list:
      list.status === 'loading' ? (
        <Loading />
      ) : list.status === 'failed' ? (
        <Failure result={list.failure} retry={reload} />
      ) : rows.length === 0 ? (
        <Empty
          title={filtered ? c.t('noSubscriptionsMatch') : c.t('emptySubscriptions')}
          action={
            filtered ? undefined : (
              <LinkButton href="/pay/subscriptions/new" tone="primary">
                {c.t('createSubscription')}
              </LinkButton>
            )
          }
        >
          {filtered ? c.t('noSubscriptionsMatchBody') : c.t('emptySubscriptionsBody')}
        </Empty>
      ) : (
        <div className="lt-stack">
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
                    {s.stallReason && (
                      <>
                        {' '}
                        <small className="lt-hint">{c.t(`stall_${s.stallReason}`)}</small>
                      </>
                    )}
                  </>
                ),
              },
              { header: c.t('amountPerCycle'), cell: amountCell },
              { header: c.t('cadence'), cell: cadenceCell },
              { header: c.t('chargePath'), cell: (s) => pathLabel(s.path) },
              { header: c.t('status'), cell: (s) => <StatusChip entity="subscription" value={s.status} /> },
              { header: c.t('nextRun'), cell: (s) => <NextRun status={s.status} nextRunAt={s.nextRunAt} /> },
            ]}
          />
          {list.hasMore && (
            <div className="lt-actions">
              <Button tone="secondary" onClick={loadMore} disabled={list.more === 'loading'}>
                {list.more === 'loading' ? c.t('pay_loadingMore') : c.t('pay_loadMore')}
              </Button>
            </div>
          )}
        </div>
      ),
  };
}

function SubscriptionPage({
  portal,
  merchantId,
  subscriptionId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  subscriptionId: string;
  authority: PayBusinessAuthority | null;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => (authority ? createBusinessPayApi(api, userId, authority) : null), [api, userId, authority]);
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
  const detail = (
    <div className="lt-stack">
      <a className="lt-link" href="/pay/subscriptions">
        {c.t('subscriptionsTitle')}
      </a>
      <Gate resource={record.resource} retry={record.reload}>
        {(subscription) => <SubscriptionRelated portal={portal} subscription={subscription} pay={pay} reload={record.reload} />}
      </Gate>
    </div>
  );
  return <RecordListRoom need="owner">{() => ({ detail })}</RecordListRoom>;
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
    <div className="lt-stack">
      <Section
        title={c.t('keyFacts')}
        action={
          <Button tone="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <CopyReference value={subscription.id} />
        <Details
          values={[
            [
              c.t('customer'),
              <a className="lt-link" href={`/pay/customers/${encodeURIComponent(subscription.customerId)}`}>
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
          <p className="lt-stale" role="status">
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
          <p className="lt-hint" role="status">
            {c.t('subscriptionAuthority')}
          </p>
        )}
      </Section>
      <Section title={c.t('subscriptionTerms')}>
        <Gate resource={mandate} retry={reload}>
          {(m) => (
            <Details
              values={[
                [c.t('amount'), <MoneyText value={m.amount} asset={m.assetId} />],
                [c.t('mandateStatusLabel'), c.t(`mandate_${m.status}`)],
                [c.t('cadence'), cadenceLabel(m.cadence)],
                [c.t('mandateStart'), <DateTime value={m.startsAt} />],
                [c.t('mandateEnd'), m.endsAt ? <DateTime value={m.endsAt} /> : c.t('openEnded')],
                [c.t('authorizedCeiling'), m.ceiling !== null ? <MoneyText value={m.ceiling} asset={m.assetId} /> : c.t('noCeiling')],
              ]}
            />
          )}
        </Gate>
      </Section>
      <Section title={c.t('history')}>
        <Timeline items={events} label={c.t('history')} />
      </Section>
      <Section title={c.t('cycleHistory')}>
        <p className="lt-muted">{c.t('loadedWindow')}</p>
        <Gate resource={cycles} retry={reload}>
          {(data) =>
            data.cycles.length ? (
              <>
                <Grid
                  label={c.t('cycleHistory')}
                  headers={[c.t('occurrence'), c.t('amount'), c.t('status'), c.t('attempts'), c.t('payment')]}
                >
                  {data.cycles.map((cycle) => (
                    <tr key={cycle.occurrence}>
                      <th scope="row">{cycle.occurrence}</th>
                      <td>{asset ? <MoneyText value={cycle.amount} asset={asset} /> : c.t('assetUnavailable')}</td>
                      <td>
                        <CycleChip status={cycle.status} />
                        {cycle.exhausted && <p className="lt-muted">{c.t('subscriptionRefusal')}</p>}
                      </td>
                      <td>{cycle.attemptCount}</td>
                      <td>
                        {cycle.paymentId ? (
                          <a className="lt-link" href={`/pay/payments/${encodeURIComponent(cycle.paymentId)}`}>
                            {c.t('openPayment')}
                          </a>
                        ) : (
                          c.t('noPayment')
                        )}
                      </td>
                    </tr>
                  ))}
                </Grid>
                <p role="status">{data.cycles.length === 1 ? c.t('cyclesShownOne') : c.t('cyclesShown', { count: data.cycles.length })}</p>
              </>
            ) : (
              <Empty title={c.t('emptyCycles')}>{c.t('emptyCyclesBody')}</Empty>
            )
          }
        </Gate>
      </Section>
      <Section title={c.t('executionsTitle')}>
        <p className="lt-hint">{c.t('executionNotice')}</p>
        <Gate resource={executions} retry={reload}>
          {(rows) =>
            rows.length ? (
              <Grid
                label={c.t('executionsTitle')}
                headers={[c.t('occurrence'), c.t('amount'), c.t('status'), c.t('created'), c.t('payment')]}
              >
                {rows.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.occurrence}</th>
                    <td>{asset ? <MoneyText value={e.amount} asset={asset} /> : c.t('assetUnavailable')}</td>
                    <td>
                      <CycleChip status={e.status} />
                    </td>
                    <td>
                      <DateTime value={e.attemptedAt} />
                    </td>
                    <td>
                      {e.paymentId ? (
                        <a className="lt-link" href={`/pay/payments/${encodeURIComponent(e.paymentId)}`}>
                          {e.paymentId}
                        </a>
                      ) : (
                        c.t('noPayment')
                      )}
                    </td>
                  </tr>
                ))}
              </Grid>
            ) : (
              <Empty title={c.t('emptyExecutions')}>{c.t('emptyExecutionsBody')}</Empty>
            )
          }
        </Gate>
      </Section>
    </div>
  );
}

/**
 * A pause, resume or cancel whose answer was lost: one button reads the schedule and settles it. While the page is gone
 * nothing is sent (`current`).
 */
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
  // The view is on screen while its node is attached: the ref's cleanup marks it gone, so a late answer changes nothing.
  const attach = (node: HTMLDivElement | null) => {
    mounted.current = node !== null;
    if (!node) return;
    return () => {
      mounted.current = false;
    };
  };
  return (
    <div className="lt-stack" ref={attach}>
      <p className="lt-stale" role="status">
        {message || c.t('unresolvedSubscription')}
      </p>
      <Button
        tone="primary"
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
    <div className="lt-stack">
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
      <div className="lt-actions">
        {(['pause', 'resume', 'cancel'] as const)
          .filter((action) =>
            action === 'pause'
              ? s.status === 'active'
              : action === 'resume'
                ? s.status === 'paused'
                : s.status === 'active' || s.status === 'paused',
          )
          .map((action) => (
            <Review
              key={`${action}:${revision}`}
              title={c.t(action === 'pause' ? 'pauseSubscription' : action === 'resume' ? 'resumeSubscription' : 'cancelSubscription')}
              description={c.t(action === 'pause' ? 'pauseEffect' : action === 'resume' ? 'resumeEffect' : 'cancelEffect')}
              review={
                <Details
                  values={[
                    [c.t('subscriptionId'), s.id],
                    [c.t('customer'), s.customerId],
                    ...(terms ? [[c.t('amount'), <MoneyText value={terms.amount} asset={terms.assetId} />] as [string, ReactNode]] : []),
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
              disabledReason={disabled ? c.t(locked ? 'unresolvedSubscription' : 'subscriptionAuthority') : undefined}
              perform={async () => {
                try {
                  if (action === 'resume') {
                    const result = await pay.mutateRecord(
                      PAY_SUBSCRIPTION_RESUME,
                      { subscriptionId: s.id },
                      'pay:write',
                      `subscription:${s.id}`,
                      'active',
                    );
                    if (result.ok) setProjected(result.data.projectedEnd);
                    return definite(result.ok ? { ok: true as const, data: result.data.subscription } : result);
                  }
                  return await pauseOrCancelSubscription(pay, s, action);
                } finally {
                  refreshLock((v) => v + 1);
                }
              }}
              onConfirmed={reload}
            />
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
