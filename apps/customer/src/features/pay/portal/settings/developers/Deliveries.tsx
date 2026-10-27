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
import { useResource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { canRetry, shownEndpointUrl } from './model';
import { deliveryStatuses, type Delivery, type Endpoint } from './schemas';
import type { ApiResult } from '../../../../../shared/api';
import type { Page } from '../../schemas';

const noEndpoints: ApiResult<Page<Endpoint>> = { ok: true, data: { items: [], nextCursor: null } };
const tone: Record<Delivery['status'], StatusTone> = { delivered: 'done', pending: 'progress', failed: 'failed', dead: 'failed' };

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
  return (
    <div className="stack">
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
        <p className="pay-confirmed" role="status">
          {t('retryQueued', { event: queued })}
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
                        onDone={() => {
                          setQueued(d.eventType);
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
          {detail ? <DeliveryDetail delivery={detail} /> : <p className="muted">{t('deliveryNotInList')}</p>}
        </PaySection>
      )}
    </div>
  );
}

export function DeliveryDetail({ delivery }: { delivery: Delivery }) {
  const { t } = c.useCopy();
  return (
    <>
      <Facts
        items={[
          [t('colEvent'), delivery.eventType],
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
      <p className="muted">{t('bodiesNotShown')}</p>
    </>
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
  onDone: () => void;
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
        <dl data-testid="pay-details" className="pay-details">
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
      onConfirmed={() => {
        setRequestId(newRequestId());
        onDone();
      }}
    />
  );
}
