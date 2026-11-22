import { useState } from 'react';
import { DateTime } from '../../ui/DateTime';
import { useUrlParam } from '../../hooks';
import { useServerList } from '../../ui/useServerList';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { DeveloperRoom } from './DeveloperRoom';
import { canManageWebhooks } from './model';
import { endpointNeedsAttention, shownEndpointUrl, webhookUrlProblem } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { Endpoint, Health } from './schemas';
import { Button, Checkbox, Field } from '@intafaced/ui/lit';
import { EntityList, Freshness, KpiStrip, ListShell, MoreFooter, Section, SelectField, StatusChip } from '../../volt/parts';
import { Review } from '../../volt/Review';

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
    <div>
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      <HealthStrip resource={health.resource} />
      <Section
        title={t('endpointsTitle')}
        description={t('endpointsBody')}
        action={
          <Button tone="secondary" onClick={reloadAll}>
            {t('refresh')}
          </Button>
        }
      >
        <div className="lt-toolbar" role="search" aria-label={t('endpointsTitle')}>
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
                <a className="lt-link" href="#add">
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
                        <strong className="lt-mono">{shownEndpointUrl(e.url)}</strong>
                        {endpointNeedsAttention(e) && <small className="lt-hint">{t('failingNote', { n: e.consecutiveFailures })}</small>}
                      </>
                    ),
                  },
                  {
                    header: t('colEvents'),
                    cell: (e) => <span className="lt-mono">{e.eventTypes ? e.eventTypes.join(', ') : t('allEventTypes')}</span>,
                  },
                  { header: t('colStatus'), cell: (e) => <StatusChip entity="endpoint" value={e.status} /> },
                  {
                    header: t('colLastDelivered'),
                    cell: (e) => {
                      const at = lastDelivered(health.resource, e.id);
                      return at ? <DateTime value={at} /> : <span className="lt-hint">{t('noneYet')}</span>;
                    },
                  },
                  { header: t('colChanged'), cell: (e) => <DateTime value={e.updatedAt} /> },
                ]}
              />
              {list.state.status === 'ready' && <MoreFooter state={list.state} onMore={list.loadMore} />}
            </>
          )}
        </ListShell>
      </Section>
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
      <p className="lt-hint" role="status">
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
  api: Pick<SettingsBApi, 'endpointCreate' | 'webhookCatalogue' | 'webhookPolicy'>;
  canManage: boolean;
  onCreated: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  const [url, setUrl] = useState('');
  // Every type starts ticked, as before subscriptions existed; untick what this address should not get.
  const [unticked, setUnticked] = useState<readonly string[]>([]);
  const catalogue = useResource((signal) => api.webhookCatalogue(signal), 'dev:catalogue');
  const policy = useResource((signal) => api.webhookPolicy(signal), 'dev:policy');
  const types = catalogue.resource.status === 'ready' ? catalogue.resource.data.events.map((e) => e.type) : [];
  const chosen = types.filter((type) => !unticked.includes(type));
  const problem = url.trim() ? webhookUrlProblem(url) : null;
  const cap = policy.resource.status === 'ready' ? policy.resource.data.endpointCap : undefined;
  return (
    <Section title={t('addEndpoint')} description={t('addEndpointBody')}>
      {!canManage && (
        <p className="lt-hint" role="status">
          {t('readOnlyRole')}
        </p>
      )}
      {cap === null && (
        <p className="lt-hint" role="status" data-testid="webhook-cap-unset">
          {t('capUnset')}
        </p>
      )}
      {typeof cap === 'number' && <p className="lt-hint">{t('capShown', { n: cap })}</p>}
      <div data-testid="form-stack">
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
        <fieldset disabled={!canManage} data-testid="webhook-event-types">
          <legend>{t('eventTypesLabel')}</legend>
          <p className="lt-hint">{t('eventTypesHint')}</p>
          {catalogue.resource.status === 'loading' && <p className="lt-hint">{t('eventTypesLoading')}</p>}
          {catalogue.resource.status === 'failed' && (
            <p className="lt-hint" role="status">
              {t('eventTypesUnavailable')}
            </p>
          )}
          {types.map((type) => (
            <Checkbox
              key={type}
              checked={chosen.includes(type)}
              onCheckedChange={(on) => setUnticked(on ? unticked.filter((x) => x !== type) : [...new Set([...unticked, type])])}
            >
              {type}
            </Checkbox>
          ))}
        </fieldset>
        <Review
          title={t('addEndpointAction')}
          variant="primary"
          description={t('addEndpointReview')}
          disabled={!canManage || !url.trim() || Boolean(problem) || chosen.length === 0}
          disabledReason={!canManage ? t('readOnlyRole') : chosen.length === 0 ? t('eventTypesPickOne') : t('urlFixFirst')}
          review={
            <dl className="lt-kv">
              <div>
                <dt>{t('colAddress')}</dt>
                <dd className="lt-mono">{shownEndpointUrl(url.trim())}</dd>
              </div>
              <div>
                <dt>{t('colEvents')}</dt>
                <dd data-testid="webhook-review-events">{chosen.length === types.length ? t('allEventTypes') : chosen.join(', ')}</dd>
              </div>
            </dl>
          }
          perform={() => api.endpointCreate(url.trim(), chosen)}
          onConfirmed={(created) => {
            setUrl('');
            setUnticked([]);
            onCreated(created.secret);
          }}
        />
      </div>
    </Section>
  );
}

/** `/pay/developer/webhooks` on the settings template. */
export function WebhooksRoom() {
  const { t } = c.useCopy();
  return (
    <DeveloperRoom room="developer-webhooks" explain={<p>{t('webhooksExplain')}</p>}>
      {(api, { role }) => <Webhooks api={api} canManage={canManageWebhooks(role)} />}
    </DeveloperRoom>
  );
}
