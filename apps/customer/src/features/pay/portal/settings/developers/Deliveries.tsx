import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { Facts, ListShell, MoreFooter, SelectField } from '../../components';
import { EntityList } from '../../ui/EntityList';
import { DateTime } from '../../ui/DateTime';
import { dateRange, type DatePreset } from '../../ui/FilterRow';
import { PortalReview } from '../../ui/PortalReview';
import { ToneChip, type StatusTone } from '../../ui/StatusChip';
import { Timeline } from '../../ui/Timeline';
import { useUrlParam } from '../../hooks';
import { newRequestId } from '../../model';
import { useServerList } from '../../ui/useServerList';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { canRetry, shownEndpointUrl } from './model';
import { deliveryStatuses, type Delivery, type Endpoint, type Policy } from './schemas';
import type { ApiResult } from '../../../../../shared/api';
import type { Page } from '../../schemas';

const noEndpoints: ApiResult<Page<Endpoint>> = { ok: true, data: { items: [], nextCursor: null } };
const tone: Record<Delivery['status'], StatusTone> = {
  delivered: 'done',
  pending: 'progress',
  failed: 'failed',
  dead: 'failed',
  unknown: 'action',
};

/** A `datetime-local` value read in the browser's time zone, as an ISO instant; null when it is not a time. */
export function localInstant(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function DeliveryChip({ status }: { status: Delivery['status'] }) {
  const { t } = c.useCopy();
  return <ToneChip tone={tone[status]} label={t(`delivery_${status}`)} tip={t(`deliveryTip_${status}`)} />;
}

/** Deliveries for every endpoint, or for one (`endpointId`). Filters are the service's own and live in the address. */
export function DeliveryList({
  api,
  canManage,
  endpointId,
  now = Date.now(),
}: {
  api: SettingsBApi;
  canManage: boolean;
  endpointId?: string;
  now?: number;
}) {
  const { t } = c.useCopy();
  const [status, setStatus] = useUrlParam('status');
  const [date, setDate] = useUrlParam('date');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [endpointParam, setEndpoint] = useUrlParam('endpoint');
  const [open, setOpen] = useUrlParam('delivery');
  // What the last "Send again" did, said in words, because the row it was pressed on may change or leave the list.
  const [queued, setQueued] = useState<string | null>(null);
  const endpoint = endpointId ?? endpointParam;
  const range = dateRange(date as DatePreset, now, { from, to });
  const endpoints = useResource(
    (signal) => (endpointId ? Promise.resolve(noEndpoints) : api.endpointsList(undefined, '', '', signal)),
    `dev:deliveries:endpoints:${endpointId ?? ''}`,
  );
  const list = useServerList<Delivery, Record<string, string>>(
    (f, cursor, signal) =>
      api.deliveriesList(
        cursor,
        { endpointId: f.endpoint || undefined, status: f.status || undefined, from: f.from || undefined, to: f.to || undefined },
        signal,
      ),
    { endpoint, status, from: range.from ?? '', to: range.to ?? '' },
    (d) => d.id,
  );
  const shown = list.state.status === 'ready' ? list.state.items : [];
  const detail = open ? shown.find((d) => d.id === open) : undefined;
  const filtered = Boolean(status || date || (!endpointId && endpoint));
  const policy = useResource((signal) => api.webhookPolicy(signal), 'dev:policy');
  return (
    <div className="stack">
      {!endpointId && <PolicyNotice resource={policy.resource} />}
      <div className="pp-filterbar" role="search" aria-label={t('deliveriesTitle')}>
        <div className="pp-filter-row">
          <SelectField
            label={t('colStatus')}
            value={status}
            onChange={setStatus}
            options={[['', t('allStatuses')], ...deliveryStatuses.map((s) => [s, t(`delivery_${s}`)] as const)]}
          />
          <SelectField
            label={t('colWhen')}
            value={date}
            onChange={setDate}
            options={[
              ['', t('anyDate')],
              ['today', t('today')],
              ['7d', t('last7')],
              ['30d', t('last30')],
              ['custom', t('custom')],
            ]}
          />
          {!endpointId && endpoints.resource.status === 'ready' && endpoints.resource.data.items.length > 0 && (
            <SelectField
              label={t('colEndpoint')}
              value={endpoint}
              onChange={setEndpoint}
              options={[['', t('allEndpoints')], ...endpoints.resource.data.items.map((e) => [e.id, shownEndpointUrl(e.url)] as const)]}
            />
          )}
        </div>
        {date === 'custom' && (
          <div className="pp-filter-row">
            <Field label={t('from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Field label={t('to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        <p className="muted pp-count" role="status">
          {list.state.status === 'ready'
            ? list.state.hasMore
              ? t('newestMore', { n: shown.length })
              : t('newestAll', { n: shown.length })
            : ''}
          {filtered && (
            <>
              {' '}
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setStatus('');
                  setDate('');
                  setFrom('');
                  setTo('');
                  if (!endpointId) setEndpoint('');
                }}
              >
                {t('clearFilters')}
              </button>
            </>
          )}
        </p>
      </div>
      {queued && (
        <p className="pay-confirmed" role="status" data-testid="delivery-notice">
          {queued}
        </p>
      )}
      <ListShell
        state={list.state}
        retry={list.reload}
        empty={{
          title: filtered ? t('noDeliveriesMatch') : t('noDeliveriesTitle'),
          body: filtered ? t('noDeliveriesMatchBody') : t('noDeliveriesBody'),
        }}
      >
        {(rows) => (
          <>
            <EntityList
              label={t('deliveriesTitle')}
              rows={rows}
              rowKey={(d) => d.id}
              columns={[
                {
                  header: t('colEvent'),
                  cell: (d) => (
                    <>
                      <strong>{d.eventType}</strong>
                      {!endpointId && (
                        <small className="pay-cell-note">
                          <a className="text-link" href={`/pay/developer/webhooks/${encodeURIComponent(d.endpointId)}`}>
                            {t('viewEndpoint')}
                          </a>
                        </small>
                      )}
                    </>
                  ),
                },
                { header: t('colStatus'), cell: (d) => <DeliveryChip status={d.status} /> },
                { header: t('colAttempts'), cell: (d) => d.attempts },
                {
                  header: t('colReply'),
                  cell: (d) => (d.lastStatusCode === null ? <span className="muted">{t('noReply')}</span> : d.lastStatusCode),
                },
                { header: t('colWhen'), cell: (d) => <DateTime value={d.createdAt} /> },
                {
                  header: <span className="pp-sr">{t('colActions')}</span>,
                  cell: (d) => (
                    <div className="pp-actions">
                      <Button variant="ghost" onClick={() => setOpen(d.id)} aria-label={t('openDelivery', { event: d.eventType })}>
                        {t('details')}
                      </Button>
                      <RetryButton
                        api={api}
                        delivery={d}
                        canManage={canManage}
                        onDone={(again) => {
                          setQueued(again ? t('retryAlready') : t('retryQueued', { event: d.eventType }));
                          list.reload();
                        }}
                      />
                    </div>
                  ),
                },
              ]}
              card={(d) => ({
                title: d.eventType,
                time: <DateTime value={d.createdAt} />,
                status: <DeliveryChip status={d.status} />,
              })}
            />
            {list.state.status === 'ready' && <MoreFooter state={list.state} onMore={list.loadMore} />}
          </>
        )}
      </ListShell>
      {open && (
        <PaySection
          title={t('deliveryFacts')}
          action={
            <Button variant="ghost" onClick={() => setOpen('')}>
              {t('close')}
            </Button>
          }
        >
          {detail ? <DeliveryDetail delivery={detail} api={api} /> : <p className="muted">{t('deliveryNotInList')}</p>}
        </PaySection>
      )}
      {!endpointId && endpoints.resource.status === 'ready' && (
        <RecoverMissed
          api={api}
          canManage={canManage}
          endpoints={endpoints.resource.data.items.filter((e) => e.status === 'active')}
          onDone={(words) => {
            setQueued(words);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

/** The owner's retry policy and resend window, in words; a blank one says what that means. */
export function PolicyNotice({ resource }: { resource: Resource<Policy> }) {
  const { t } = c.useCopy();
  if (resource.status === 'loading') return null;
  if (resource.status === 'failed')
    return (
      <p className="muted" role="status">
        {t('policyUnavailable')}
      </p>
    );
  const p = resource.data;
  const window = p.resendWindowSeconds;
  return (
    <PaySection title={t('policyTitle')}>
      <div data-testid="webhook-policy">
        {p.retryScheduleSeconds ? (
          <p>{t('policyRetries', { waits: p.retryScheduleSeconds.join(', ') })}</p>
        ) : (
          <p className="pp-callout pp-callout--warn" role="status" data-testid="webhook-policy-unset">
            {t('policyUnset')}
          </p>
        )}
        {window === null ? (
          <p className="pp-callout" role="status">
            {t('policyWindowUnset')}
          </p>
        ) : window % 86_400 === 0 ? (
          <p>{t('policyWindow', { days: window / 86_400 })}</p>
        ) : (
          <p>{t('policyWindowSeconds', { n: window })}</p>
        )}
      </div>
    </PaySection>
  );
}

/** Every event since a time that one endpoint did not accept, queued again: one new attempt each, idempotent per review. */
export function RecoverMissed({
  api,
  canManage,
  endpoints,
  onDone,
}: {
  api: Pick<SettingsBApi, 'deliveriesRecover'>;
  canManage: boolean;
  endpoints: readonly Endpoint[];
  onDone: (words: string) => void;
}) {
  const { t } = c.useCopy();
  const [endpointId, setEndpointId] = useState('');
  const [since, setSince] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const at = localInstant(since);
  const chosen = endpoints.find((e) => e.id === endpointId);
  return (
    <PaySection title={t('recoverTitle')} description={t('recoverBody')}>
      <div data-testid="form-stack" className="form-stack pp-form">
        <SelectField
          label={t('recoverEndpoint')}
          value={endpointId}
          onChange={setEndpointId}
          options={[['', t('recoverPickEndpoint')], ...endpoints.map((e) => [e.id, shownEndpointUrl(e.url)] as const)]}
        />
        <Field label={t('recoverSince')} type="datetime-local" step={1} value={since} onChange={(e) => setSince(e.target.value)} />
        <PortalReview
          title={t('recoverAction')}
          description={t('recoverReview')}
          disabled={!canManage || !chosen || !at}
          disabledReason={!canManage ? t('readOnlyRole') : !chosen ? t('recoverPickEndpoint') : t('recoverPickSince')}
          review={
            <dl className="pay-details">
              <div>
                <dt>{t('recoverEndpoint')}</dt>
                <dd className="pp-wrap">{chosen ? shownEndpointUrl(chosen.url) : ''}</dd>
              </div>
              <div>
                <dt>{t('recoverSince')}</dt>
                <dd>{at ? <DateTime value={at} /> : ''}</dd>
              </div>
            </dl>
          }
          perform={() => api.deliveriesRecover(endpointId, at ?? '', requestId)}
          onConfirmed={(result) => {
            setRequestId(newRequestId());
            onDone(
              !result.recovered
                ? t('recoverAgain', { n: result.queued })
                : result.queued === 0
                  ? t('recoverNone')
                  : t('recoverDone', { n: result.queued }),
            );
          }}
        />
      </div>
    </PaySection>
  );
}

export function DeliveryDetail({ delivery, api }: { delivery: Delivery; api?: Pick<SettingsBApi, 'deliveryAttempts'> }) {
  const { t } = c.useCopy();
  return (
    <>
      <Facts
        items={[
          [t('colEvent'), delivery.eventType],
          ...(delivery.eventId ? ([[t('colEventId'), <code key="e">{delivery.eventId}</code>]] as const) : []),
          [t('colStatus'), <DeliveryChip key="s" status={delivery.status} />],
          [t('colAttempts'), String(delivery.attempts)],
          [t('colReply'), delivery.lastStatusCode === null ? t('noReply') : String(delivery.lastStatusCode)],
          [t('colSpeed'), delivery.latencyMs == null ? '—' : t('milliseconds', { n: Math.round(delivery.latencyMs) })],
          [t('colReference'), <code key="r">{delivery.id}</code>],
        ]}
      />
      <Timeline
        label={t('history')}
        items={[
          { at: delivery.createdAt, title: t('deliveryQueued') },
          ...(delivery.deliveredAt ? [{ at: delivery.deliveredAt, title: t('deliveryAccepted') }] : []),
        ]}
      />
      {api && <AttemptList api={api} delivery={delivery} />}
      <p className="muted">{t('bodiesNotShown')}</p>
    </>
  );
}

/** Each attempt at one delivery, oldest first: its result, the response it got, how long it took, and who asked for it. */
export function AttemptList({ api, delivery }: { api: Pick<SettingsBApi, 'deliveryAttempts'>; delivery: Delivery }) {
  const { t } = c.useCopy();
  // Keyed on what changes with each attempt, so a new one shows once the list reloads.
  const attempts = useResource(
    (signal) => api.deliveryAttempts(delivery.id, signal),
    `dev:attempts:${delivery.id}:${delivery.attempts}:${delivery.status}`,
  );
  const r = attempts.resource;
  return (
    <section aria-label={t('attemptsTitle')} data-testid="delivery-attempts">
      <h4>{t('attemptsTitle')}</h4>
      {r.status === 'loading' ? (
        <p className="muted">{t('attemptsLoading')}</p>
      ) : r.status === 'failed' ? (
        <p className="muted" role="status">
          {t('attemptsUnavailable')}
        </p>
      ) : r.data.attempts.length === 0 ? (
        <p className="muted">{t('attemptsEmpty')}</p>
      ) : (
        <table className="pp-table">
          <thead>
            <tr>
              <th scope="col">{t('colAttemptNo')}</th>
              <th scope="col">{t('colWhen')}</th>
              <th scope="col">{t('colOutcome')}</th>
              <th scope="col">{t('colResponse')}</th>
              <th scope="col">{t('colTook')}</th>
              <th scope="col">{t('colResend')}</th>
            </tr>
          </thead>
          <tbody>
            {r.data.attempts.map((a) => (
              <tr key={a.attemptNo} data-testid="delivery-attempt">
                <td>{a.attemptNo}</td>
                <td>
                  <DateTime value={a.at} />
                </td>
                <td>{t(`attempt_${a.outcome}`)}</td>
                <td>{a.statusCode === null ? t('responseNone', { why: a.error ?? '—' }) : t('responseHttp', { code: a.statusCode })}</td>
                <td>{t('milliseconds', { n: Math.round(a.durationMs) })}</td>
                <td>{a.resend ? t('resendYes') : t('resendNo')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function RetryButton({
  api,
  delivery,
  canManage,
  onDone,
}: {
  api: Pick<SettingsBApi, 'deliveryRetry'>;
  delivery: Delivery;
  canManage: boolean;
  /** `again`: the service had already taken this request id; nothing more was queued. */
  onDone: (again: boolean) => void;
}) {
  const { t } = c.useCopy();
  // One request id per review: sending it twice (a double click, a lost reply) cannot send the event twice.
  const [requestId, setRequestId] = useState(newRequestId);
  if (!canRetry(delivery)) return null;
  return (
    <PortalReview
      title={t('retryAction')}
      description={t('retryReview')}
      disabled={!canManage}
      disabledReason={t('readOnlyRole')}
      review={
        <dl className="pay-details">
          <div>
            <dt>{t('colEvent')}</dt>
            <dd>{delivery.eventType}</dd>
          </div>
          <div>
            <dt>{t('colAttempts')}</dt>
            <dd>{delivery.attempts}</dd>
          </div>
          <div>
            <dt>{t('colReply')}</dt>
            <dd>{delivery.lastStatusCode ?? t('noReply')}</dd>
          </div>
        </dl>
      }
      perform={() => api.deliveryRetry(delivery.id, requestId)}
      onConfirmed={(result) => {
        setRequestId(newRequestId());
        onDone(!result.retried);
      }}
    />
  );
}
