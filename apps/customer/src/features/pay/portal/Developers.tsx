import { useMemo } from 'react';
import type { z } from 'zod';
import { useSession } from '../../session/session';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState } from '../../../shared/ui';
import { PayDetails, PaySection, PayTime, ReviewedAction } from '../components';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from '../pay-api';
import { CreateWebhook, SandboxKeys, WebhookToggle } from '../MerchantNetwork';
import * as s from '../schemas';
import { Gate, Kpi, KpiGrid, Timeline } from './components';
import { useReadAt, useUrlParam } from './hooks';
import {
  Arrives,
  CopyReference,
  PortalBack,
  ReadStamp,
  RecordChip,
  safeEndpointUrl,
  useWindowFilters,
  WindowExport,
  WindowFilters,
} from './ExtensionTools';
import { extensionCopy as c } from './extension-copy';
import type { PortalRoute } from './routes';

type Key = z.infer<typeof s.keySchema>;
type Endpoint = z.infer<typeof s.webhookSchema>;
type Delivery = z.infer<typeof s.webhookDeliverySchema>;
const developerLinks = [
  ['/pay/developer/keys', 'keysTitle'],
  ['/pay/developer/signing', 'signingTitle'],
  ['/pay/developer/webhooks', 'endpointsTitle'],
  ['/pay/developer/deliveries', 'deliveriesTitle'],
] as const;
export function developerHeader(route: PortalRoute) {
  const title =
    route.room === 'developer-signing'
      ? 'signingTitle'
      : route.room === 'developer-endpoint'
        ? 'endpointTitle'
        : route.room === 'developer-webhooks'
          ? 'endpointsTitle'
          : route.room === 'developer-deliveries'
            ? 'deliveriesTitle'
            : 'keysTitle';
  return {
    title: c.t(title),
    purpose: c.t('developerPurpose'),
    action: (
      <a className="button button--secondary" href="/pay/developer/webhooks">
        {c.t('endpointsTitle')}
      </a>
    ),
  };
}
export function DeveloperNav({ room }: { room: string }) {
  return (
    <nav className="pp-filters" aria-label={c.t('developerTitle')}>
      {developerLinks.map(([href, key]) => (
        <a className="text-link" href={href} key={href} aria-current={room === `developer-${href.split('/').at(-1)}` ? 'page' : undefined}>
          {c.t(key)}
        </a>
      ))}
    </nav>
  );
}
export function Developers({ route, authority }: { route: PortalRoute; authority: PayBusinessAuthority | null }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  return (
    <div className="stack">
      <PortalBack />
      <DeveloperNav room={route.room} />
      {route.room === 'developer-signing' ? (
        <Arrives>{c.t('signingGap')}</Arrives>
      ) : !authority ? (
        <DeveloperUnavailable room={route.room} />
      ) : route.room === 'developer-webhooks' || route.room === 'developer-endpoint' ? (
        <EndpointsPage pay={pay} endpointId={route.param} />
      ) : route.room === 'developer-deliveries' ? (
        <DeliveriesPage pay={pay} />
      ) : (
        <KeysPage pay={pay} />
      )}
    </div>
  );
}
export function DeveloperUnavailable({ room }: { room: string }) {
  return (
    <div className="stack">
      <PaySection title={c.t('credentialsTitle')}>
        <p className="pp-callout" role="status">
          {c.t('authorityGap')}
        </p>
      </PaySection>
      <Arrives>
        {c.t(
          room === 'developer-deliveries'
            ? 'deliveryGap'
            : room === 'developer-webhooks' || room === 'developer-endpoint'
              ? 'endpointGap'
              : 'keysGap',
        )}
      </Arrives>
    </div>
  );
}
function KeysPage({ pay }: { pay: BusinessPayApi }) {
  const keys = useResource((signal) => pay.keys(signal), 'portal:developer-keys');
  return <KeysView resource={keys.resource} pay={pay} reload={keys.reload} />;
}
export function KeysView({ resource, pay, reload }: { resource: Resource<Key[]>; pay: BusinessPayApi; reload: () => void }) {
  const filters = useWindowFilters();
  const at = useReadAt(resource.status === 'ready', resource);
  return (
    <div className="stack">
      <p className="pp-callout">
        <strong>{c.t('sandboxOnly')}</strong> {c.t('sandboxOnlyBody')}
      </p>
      <PaySection
        title={c.t('keysTitle')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <WindowFilters filters={filters} statuses={['active', 'revoked']} />
        <p className="muted">{c.t('loadedWindow')}</p>
        <Gate resource={resource} retry={reload}>
          {(all) => {
            const keys = all.filter((k) => k.mode === 'sandbox' && k.scopes.some((scope) => scope.startsWith('pay:')));
            const rows = keys.filter(
              (k) =>
                (!filters.status || (k.revoked ? 'revoked' : 'active') === filters.status) &&
                `${k.name} ${k.prefix} ${k.scopes.join(' ')}`.toLowerCase().includes(filters.search.toLowerCase()),
            );
            if (filters.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
            else if (filters.sort === 'oldest') rows.reverse();
            return (
              <>
                <KpiGrid label={c.t('loadedMetrics')}>
                  {(['totalKeys', 'activeKeys', 'revokedKeys', 'usedKeys'] as const).map((key, i) => (
                    <Kpi
                      key={key}
                      label={c.t(key)}
                      period={c.t('loadedMetrics')}
                      value={
                        [
                          keys.length,
                          keys.filter((k) => !k.revoked).length,
                          keys.filter((k) => k.revoked).length,
                          keys.filter((k) => k.lastUsedAt).length,
                        ][i]
                      }
                      href={`/pay/developer/keys${i === 1 ? '?status=active' : i === 2 ? '?status=revoked' : ''}`}
                    />
                  ))}
                </KpiGrid>
                <ReadStamp at={at} />
                <p role="status">{c.t('shown', { count: rows.length })}</p>
                {rows.length ? (
                  <DataTable
                    label={c.t('keysTitle')}
                    headers={[c.t('keysHeader'), c.t('scopes'), c.t('lastUsed'), c.t('status'), c.t('details')]}
                  >
                    {rows.map((key) => (
                      <tr key={key.id}>
                        <th scope="row">
                          {key.name}
                          <small className="pay-cell-note">{key.prefix}</small>
                        </th>
                        <td>{key.scopes.join(', ')}</td>
                        <td>{key.lastUsedAt ? <PayTime value={key.lastUsedAt} /> : c.t('neverUsed')}</td>
                        <td>
                          <RecordChip status={key.revoked ? 'revoked' : 'active'} />
                        </td>
                        <td>
                          {!key.revoked && (
                            <ReviewedAction
                              title={c.t('revokeKey')}
                              description={c.t('revokeEffect')}
                              review={
                                <PayDetails
                                  values={[
                                    [c.t('keysHeader'), `${key.name} · ${key.prefix}`],
                                    [c.t('scopes'), key.scopes.join(', ')],
                                  ]}
                                />
                              }
                              perform={() => pay.revokeKey(key.id)}
                              onConfirmed={reload}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <EmptyState
                    title={c.t('emptyKeys')}
                    action={
                      <a className="text-link" href="#key-create">
                        {c.t('keysTitle')}
                      </a>
                    }
                  >
                    {c.t('emptyKeysBody')}
                  </EmptyState>
                )}
                <WindowExport
                  name="sandbox-key-metadata"
                  at={at}
                  headers={['name', 'prefix', 'scopes', 'last_used', 'status']}
                  rows={rows.map((k) => [k.name, k.prefix, k.scopes.join(' '), k.lastUsedAt, k.revoked ? 'revoked' : 'active'])}
                />
              </>
            );
          }}
        </Gate>
      </PaySection>
      <Arrives>{c.t('keysGap')}</Arrives>
      <div id="key-create">
        <SandboxKeys pay={pay} formOnly />
      </div>
    </div>
  );
}
function EndpointsPage({ pay, endpointId }: { pay: BusinessPayApi; endpointId?: string }) {
  const endpoints = useResource((signal) => pay.webhookEndpoints(signal), 'portal:endpoints');
  const deliveries = useResource((signal) => pay.webhookDeliveries(signal), 'portal:deliveries');
  return (
    <EndpointsView
      resource={endpoints.resource}
      deliveries={deliveries.resource}
      pay={pay}
      endpointId={endpointId}
      reload={() => {
        endpoints.reload();
        deliveries.reload();
      }}
    />
  );
}
export function EndpointsView({
  resource,
  deliveries,
  pay,
  endpointId,
  reload,
}: {
  resource: Resource<Endpoint[]>;
  deliveries: Resource<Delivery[]>;
  pay: BusinessPayApi;
  endpointId?: string;
  reload: () => void;
}) {
  const filters = useWindowFilters();
  const at = useReadAt(resource.status === 'ready', resource);
  return (
    <div className="stack">
      <PaySection
        title={c.t(endpointId ? 'endpointTitle' : 'endpointsTitle')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        {!endpointId && (
          <>
            <WindowFilters filters={filters} statuses={['active', 'disabled']} />
            <p className="muted">{c.t('loadedWindow')}</p>
          </>
        )}
        <Gate resource={resource} retry={reload}>
          {(all) => {
            if (endpointId) {
              const row = all.find((e) => e.id === endpointId);
              return row ? (
                <>
                  <PortalBack href="/pay/developer/webhooks">{c.t('endpointsTitle')}</PortalBack>
                  <CopyReference value={row.id} />
                  <PayDetails
                    values={[
                      [c.t('endpoint'), safeEndpointUrl(row.url)],
                      [c.t('status'), <RecordChip status={row.status} />],
                      [c.t('failures'), String(row.consecutiveFailures)],
                    ]}
                  />
                  <ReadStamp at={at} />
                  <Timeline
                    label={c.t('history')}
                    items={[
                      { at: row.createdAt, title: c.t('created') },
                      { at: row.updatedAt, title: c.t('updated') },
                    ]}
                  />
                  <WebhookToggle endpoint={row} pay={pay} reload={reload} />
                  <Arrives>
                    {c.t('endpointGap')} {c.t('signatureGap')}
                  </Arrives>
                  <PaySection title={c.t('deliveriesTitle')}>
                    <DeliveryRows resource={deliveries} reload={reload} endpointId={endpointId} />
                  </PaySection>
                </>
              ) : (
                <EmptyState
                  title={c.t('missingRecord')}
                  action={
                    <a className="text-link" href="/pay/developer/webhooks">
                      {c.t('endpointsTitle')}
                    </a>
                  }
                >
                  {c.t('missingBody')}
                </EmptyState>
              );
            }
            const rows = all
              .filter(
                (e) =>
                  (!filters.status || e.status === filters.status) &&
                  `${safeEndpointUrl(e.url)} ${e.id}`.toLowerCase().includes(filters.search.toLowerCase()),
              )
              .sort((a, b) =>
                filters.sort === 'name'
                  ? safeEndpointUrl(a.url).localeCompare(safeEndpointUrl(b.url))
                  : filters.sort === 'oldest'
                    ? a.createdAt.localeCompare(b.createdAt)
                    : b.createdAt.localeCompare(a.createdAt),
              );
            return (
              <>
                <KpiGrid label={c.t('loadedMetrics')}>
                  {(['endpointsLoaded', 'endpointsActive', 'endpointsDisabled', 'endpointsFailing'] as const).map((key, i) => (
                    <Kpi
                      key={key}
                      label={c.t(key)}
                      value={
                        [
                          all.length,
                          all.filter((e) => e.status === 'active').length,
                          all.filter((e) => e.status === 'disabled').length,
                          all.filter((e) => e.consecutiveFailures > 0).length,
                        ][i]
                      }
                      period={c.t('loadedMetrics')}
                      href={`/pay/developer/webhooks${i === 1 ? '?status=active' : i === 2 ? '?status=disabled' : ''}`}
                    />
                  ))}
                </KpiGrid>
                <ReadStamp at={at} />
                <p role="status">{c.t('shown', { count: rows.length })}</p>
                {rows.length ? (
                  <DataTable label={c.t('endpointsTitle')} headers={[c.t('endpoint'), c.t('status'), c.t('failures'), c.t('updated')]}>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <th scope="row">
                          <a className="text-link pp-wrap" href={`/pay/developer/webhooks/${encodeURIComponent(e.id)}`}>
                            {safeEndpointUrl(e.url)}
                          </a>
                        </th>
                        <td>
                          <RecordChip status={e.status} />
                        </td>
                        <td>{e.consecutiveFailures}</td>
                        <td>
                          <PayTime value={e.updatedAt} />
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <EmptyState
                    title={c.t('emptyEndpoints')}
                    action={
                      <a className="text-link" href="#endpoint-create">
                        {c.t('endpointsTitle')}
                      </a>
                    }
                  >
                    {c.t('emptyEndpointsBody')}
                  </EmptyState>
                )}
                <WindowExport
                  name="webhook-endpoints"
                  at={at}
                  headers={['endpoint_id', 'url_redacted', 'status', 'consecutive_failures', 'updated_at']}
                  rows={rows.map((e) => [e.id, safeEndpointUrl(e.url), e.status, e.consecutiveFailures, e.updatedAt])}
                />
              </>
            );
          }}
        </Gate>
      </PaySection>
      <Arrives>
        {c.t('endpointGap')} {c.t('secretGap')}
      </Arrives>
      {!endpointId && (
        <div id="endpoint-create">
          <CreateWebhook pay={pay} reload={reload} />
        </div>
      )}
    </div>
  );
}
function DeliveriesPage({ pay }: { pay: BusinessPayApi }) {
  const deliveries = useResource((signal) => pay.webhookDeliveries(signal), 'portal:deliveries');
  return (
    <PaySection
      title={c.t('deliveriesTitle')}
      action={
        <Button variant="secondary" onClick={deliveries.reload}>
          {c.t('refresh')}
        </Button>
      }
    >
      <DeliveryRows resource={deliveries.resource} reload={deliveries.reload} />
    </PaySection>
  );
}
export function DeliveryRows({
  resource,
  reload,
  endpointId,
}: {
  resource: Resource<Delivery[]>;
  reload: () => void;
  endpointId?: string;
}) {
  const filters = useWindowFilters();
  const [selected, setSelected] = useUrlParam('delivery');
  const at = useReadAt(resource.status === 'ready', resource);
  return (
    <div className="stack">
      <WindowFilters filters={filters} statuses={['pending', 'delivered', 'failed', 'dead']} />
      <p className="muted">{c.t('loadedWindow')}</p>
      <Gate resource={resource} retry={reload}>
        {(all) => {
          const scoped = all.filter((d) => !endpointId || d.endpointId === endpointId);
          const rows = scoped
            .filter(
              (d) =>
                (!filters.status || d.status === filters.status) &&
                `${d.id} ${d.eventId} ${d.eventType} ${d.endpointId}`.toLowerCase().includes(filters.search.toLowerCase()),
            )
            .sort((a, b) =>
              filters.sort === 'name'
                ? a.eventType.localeCompare(b.eventType)
                : filters.sort === 'oldest'
                  ? a.createdAt.localeCompare(b.createdAt)
                  : b.createdAt.localeCompare(a.createdAt),
            );
          const detail = selected ? scoped.find((d) => d.id === selected) : undefined;
          return (
            <>
              <KpiGrid label={c.t('loadedMetrics')}>
                {(['deliveriesLoaded', 'delivered', 'pending', 'failed'] as const).map((key, i) => (
                  <Kpi
                    key={key}
                    label={c.t(key)}
                    period={c.t('loadedMetrics')}
                    value={i === 0 ? scoped.length : scoped.filter((d) => d.status === key).length}
                    href={`/pay/developer/deliveries${i ? `?status=${key}` : ''}`}
                  />
                ))}
              </KpiGrid>
              <ReadStamp at={at} />
              <p role="status">{c.t('shown', { count: rows.length })}</p>
              {rows.length ? (
                <DataTable
                  label={c.t('deliveriesTitle')}
                  headers={[c.t('event'), c.t('status'), c.t('attempts'), c.t('response'), c.t('details')]}
                >
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <th scope="row">
                        {d.eventType}
                        <small className="pay-cell-note">
                          <a className="text-link" href={`/pay/developer/webhooks/${encodeURIComponent(d.endpointId)}`}>
                            {d.endpointId}
                          </a>
                        </small>
                      </th>
                      <td>
                        <RecordChip status={d.status} />
                      </td>
                      <td>{d.attempts}</td>
                      <td>{d.lastStatusCode ?? c.t('noResponse')}</td>
                      <td>
                        <Button variant="ghost" onClick={() => setSelected(d.id)}>
                          {c.t('openDetail')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              ) : (
                <EmptyState
                  title={c.t('emptyDeliveries')}
                  action={
                    <a className="text-link" href="/pay/developer/webhooks">
                      {c.t('endpointsTitle')}
                    </a>
                  }
                >
                  {c.t('emptyDeliveriesBody')}
                </EmptyState>
              )}
              <WindowExport
                name="webhook-deliveries"
                at={at}
                headers={[
                  'delivery_id',
                  'endpoint_id',
                  'event_id',
                  'event_type',
                  'status',
                  'attempts',
                  'last_status_code',
                  'created_at',
                  'delivered_at',
                ]}
                rows={rows.map((d) => [
                  d.id,
                  d.endpointId,
                  d.eventId,
                  d.eventType,
                  d.status,
                  d.attempts,
                  d.lastStatusCode,
                  d.createdAt,
                  d.deliveredAt,
                ])}
              />
              {selected && (
                <PaySection
                  title={c.t('deliveryFacts')}
                  action={
                    <Button variant="ghost" onClick={() => setSelected('')}>
                      {c.t('closeDetail')}
                    </Button>
                  }
                >
                  {detail ? (
                    <>
                      <CopyReference value={detail.id} />
                      <PayDetails
                        values={[
                          [c.t('eventId'), detail.eventId],
                          [c.t('status'), <RecordChip status={detail.status} />],
                          [c.t('response'), String(detail.lastStatusCode ?? c.t('noResponse'))],
                          [c.t('attempts'), String(detail.attempts)],
                          [
                            c.t('nextAttempt'),
                            detail.status === 'pending' || detail.status === 'failed' ? <PayTime value={detail.nextAttemptAt} /> : '—',
                          ],
                        ]}
                      />
                      <Timeline
                        label={c.t('history')}
                        items={[
                          { at: detail.createdAt, title: c.t('deliveryQueued') },
                          ...(detail.deliveredAt ? [{ at: detail.deliveredAt, title: c.t('deliveryAccepted') }] : []),
                        ]}
                      />
                    </>
                  ) : (
                    <EmptyState title={c.t('missingRecord')}>{c.t('missingBody')}</EmptyState>
                  )}
                </PaySection>
              )}
            </>
          );
        }}
      </Gate>
      <Arrives>{c.t('deliveryGap')}</Arrives>
    </div>
  );
}
