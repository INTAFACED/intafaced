import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { ListShell, MoreFooter, SelectField } from '../../components';
import { EntityList } from '../../ui/EntityList';
import { DateTime } from '../../ui/DateTime';
import { Freshness } from '../../ui/Freshness';
import { KpiStrip } from '../../ui/Kpi';
import { PortalReview } from '../../ui/PortalReview';
import { StatusChip } from '../../ui/StatusChip';
import { useUrlParam } from '../../hooks';
import { useServerList } from '../../ui/useServerList';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { endpointNeedsAttention, shownEndpointUrl, webhookUrlProblem } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { Endpoint, Health } from './schemas';

type HealthResource = Resource<Health>;

export function Webhooks({ api, canManage }: { api: SettingsBApi; canManage: boolean }) {
  const { t } = c.useCopy();
  const [q, setQ] = useUrlParam('q');
  const [status, setStatus] = useUrlParam('status');
  const [revealed, setRevealed] = useState<Revealed>(null);
  const health = useResource((signal) => api.webhookHealth(signal), 'dev:health');
  const list = useServerList<Endpoint, { status: string; q: string }>(
    (f, cursor, signal) => api.endpointsList(cursor, f.status, f.q.trim(), signal),
    { status, q },
    (e) => e.id,
  );
  const reloadAll = () => {
    list.reload();
    health.reload();
  };
  return (
    <div className="stack">
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      <HealthStrip resource={health.resource} />
      <PaySection
        title={t('endpointsTitle')}
        description={t('endpointsBody')}
        action={
          <Button variant="secondary" onClick={reloadAll}>
            {t('refresh')}
          </Button>
        }
      >
        <div className="pp-filter-row" role="search" aria-label={t('endpointsTitle')}>
          <Field label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} hint={t('endpointSearchHint')} />
          <SelectField
            label={t('colStatus')}
            value={status}
            onChange={setStatus}
            options={[
              ['', t('allStatuses')],
              ['active', t('endpointOn')],
              ['disabled', t('endpointOff')],
            ]}
          />
        </div>
        <ListShell
          state={list.state}
          retry={list.reload}
          empty={{
            title: q || status ? t('noEndpointsMatch') : t('noEndpointsTitle'),
            body: q || status ? t('noEndpointsMatchBody') : t('noEndpointsBody'),
            action:
              q || status ? undefined : (
                <a className="text-link" href="#add">
                  {t('addEndpoint')}
                </a>
              ),
          }}
        >
          {(rows) => (
            <>
              <EntityList
                label={t('endpointsTitle')}
                rows={rows}
                rowKey={(e) => e.id}
                href={(e) => `/pay/developer/webhooks/${encodeURIComponent(e.id)}`}
                columns={[
                  {
                    header: t('colAddress'),
                    cell: (e) => (
                      <>
                        <strong className="pp-wrap">{shownEndpointUrl(e.url)}</strong>
                        {endpointNeedsAttention(e) && (
                          <small className="pay-cell-note">{t('failingNote', { n: e.consecutiveFailures })}</small>
                        )}
                      </>
                    ),
                  },
                  { header: t('colStatus'), cell: (e) => <StatusChip entity="endpoint" value={e.status} /> },
                  {
                    header: t('colLastDelivered'),
                    cell: (e) => {
                      const at = lastDelivered(health.resource, e.id);
                      return at ? <DateTime value={at} /> : <span className="muted">{t('noneYet')}</span>;
                    },
                  },
                  { header: t('colChanged'), cell: (e) => <DateTime value={e.updatedAt} /> },
                ]}
                card={(e) => ({
                  title: <span className="pp-wrap">{shownEndpointUrl(e.url)}</span>,
                  time: endpointNeedsAttention(e) ? t('failingNote', { n: e.consecutiveFailures }) : undefined,
                  status: <StatusChip entity="endpoint" value={e.status} />,
                })}
              />
              {list.state.status === 'ready' && <MoreFooter state={list.state} onMore={list.loadMore} />}
            </>
          )}
        </ListShell>
      </PaySection>
      <div id="add">
        <AddEndpoint
          api={api}
          canManage={canManage}
          onCreated={(secret) => {
            setRevealed({ title: t('endpointSecretTitle'), secret, what: t('endpointSecretWhat') });
            reloadAll();
          }}
        />
      </div>
    </div>
  );
}

function lastDelivered(resource: HealthResource, endpointId: string): string | null {
  return resource.status === 'ready' ? (resource.data.endpoints.find((e) => e.endpointId === endpointId)?.lastDeliveredAt ?? null) : null;
}

/** Counts across every endpoint, read at the time shown. Each tile opens the delivery list with the same status. */
export function HealthStrip({ resource }: { resource: HealthResource }) {
  const { t } = c.useCopy();
  if (resource.status === 'loading') return null;
  if (resource.status === 'failed')
    return (
      <p className="muted" role="status">
        {t('healthUnavailable')}
      </p>
    );
  const total = (key: 'pending' | 'delivered' | 'failed' | 'dead') => resource.data.endpoints.reduce((n, e) => n + e.deliveries[key], 0);
  const period = t('allEndpoints');
  return (
    <>
      <KpiStrip
        label={t('healthTitle')}
        tiles={[
          { label: t('deliveredTile'), period, href: '/pay/developer/deliveries?status=delivered', value: total('delivered') },
          { label: t('waitingTile'), period, href: '/pay/developer/deliveries?status=pending', value: total('pending') },
          {
            label: t('failedTile'),
            period,
            href: '/pay/developer/deliveries?status=failed',
            value: total('failed'),
            ...(total('failed') > 0 ? { tone: 'attention' as const } : {}),
          },
          {
            label: t('gaveUpTile'),
            period,
            href: '/pay/developer/deliveries?status=dead',
            value: total('dead'),
            ...(total('dead') > 0 ? { tone: 'attention' as const } : {}),
          },
        ]}
      />
      <Freshness asOf={resource.data.asOf} />
    </>
  );
}

export function AddEndpoint({
  api,
  canManage,
  onCreated,
}: {
  api: Pick<SettingsBApi, 'endpointCreate'>;
  canManage: boolean;
  onCreated: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  const [url, setUrl] = useState('');
  const problem = url.trim() ? webhookUrlProblem(url) : null;
  return (
    <PaySection title={t('addEndpoint')} description={t('addEndpointBody')}>
      {!canManage && (
        <p className="pp-callout" role="status">
          {t('readOnlyRole')}
        </p>
      )}
      <div data-testid="form-stack" className="form-stack pp-form">
        <Field
          label={t('urlLabel')}
          hint={t('urlHint')}
          type="url"
          inputMode="url"
          value={url}
          disabled={!canManage}
          error={problem ? t(`errUrl_${problem}`) : undefined}
          onChange={(e) => setUrl(e.target.value)}
        />
        <PortalReview
          title={t('addEndpointAction')}
          variant="primary"
          description={t('addEndpointReview')}
          disabled={!canManage || !url.trim() || Boolean(problem)}
          disabledReason={canManage ? t('urlFixFirst') : t('readOnlyRole')}
          review={
            <dl data-testid="pay-details" className="pay-details">
              <div>
                <dt>{t('colAddress')}</dt>
                <dd className="pp-wrap">{shownEndpointUrl(url.trim())}</dd>
              </div>
              <div>
                <dt>{t('colEvents')}</dt>
                <dd>{t('allEventTypes')}</dd>
              </div>
            </dl>
          }
          perform={() => api.endpointCreate(url.trim())}
          onConfirmed={(created) => {
            setUrl('');
            onCreated(created.secret);
          }}
        />
      </div>
    </PaySection>
  );
}
