import { useState } from 'react';
import { EmptyState, Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { Facts, Gate } from '../../components';
import { AuditPanel } from '../../ui/AuditPanel';
import { CopyReference } from '../../ui/CopyReference';
import { DateTime } from '../../ui/DateTime';
import { DetailHeader } from '../../ui/DetailHeader';
import { PortalReview } from '../../ui/PortalReview';
import { RelatedLinks } from '../../ui/RelatedLinks';
import { StatusChip } from '../../ui/StatusChip';
import { Timeline } from '../../ui/Timeline';
import { newRequestId } from '../../model';
import { useResource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { DeliveryList } from './Deliveries';
import { developersCopy as c } from './copy';
import { shownEndpointUrl, webhookUrlProblem } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { Endpoint as EndpointRow, Health } from './schemas';

/** One webhook endpoint: its state, its recent deliveries and the three things you can do with it. */
export function EndpointPage({ api, endpointId, canManage }: { api: SettingsBApi; endpointId: string; canManage: boolean }) {
  const { t } = c.useCopy();
  const found = useResource((signal) => api.endpointsList(undefined, '', endpointId, signal), `dev:endpoint:${endpointId}`);
  const health = useResource((signal) => api.webhookHealth(signal), 'dev:endpoint:health');
  return (
    <Gate resource={found.resource} retry={found.reload}>
      {(page) => {
        const row = page.items.find((e) => e.id === endpointId);
        return row ? (
          <EndpointView
            api={api}
            endpoint={row}
            health={health.resource.status === 'ready' ? health.resource.data : null}
            canManage={canManage}
            reload={() => {
              found.reload();
              health.reload();
            }}
          />
        ) : (
          <EmptyState
            title={t('endpointMissing')}
            action={
              <a className="text-link" href="/pay/developer/webhooks">
                {t('backToEndpoints')}
              </a>
            }
          >
            {t('endpointMissingBody')}
          </EmptyState>
        );
      }}
    </Gate>
  );
}

export function EndpointView({
  api,
  endpoint,
  health,
  canManage,
  reload,
}: {
  api: SettingsBApi;
  endpoint: EndpointRow;
  health: Health | null;
  canManage: boolean;
  reload: () => void;
}) {
  const { t } = c.useCopy();
  const [revealed, setRevealed] = useState<Revealed>(null);
  const mine = health?.endpoints.find((e) => e.endpointId === endpoint.id);
  return (
    <div className="stack">
      <DetailHeader
        back={{ href: '/pay/developer/webhooks', label: t('backToEndpoints') }}
        title={<span className="pp-wrap">{shownEndpointUrl(endpoint.url)}</span>}
        status={<StatusChip entity="endpoint" value={endpoint.status} />}
        subtitle={endpoint.status === 'disabled' ? t('disabledSubtitle') : t('activeSubtitle')}
      />
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      {!canManage && (
        <p className="pp-callout" role="status">
          {t('readOnlyRole')}
        </p>
      )}
      <PaySection title={t('endpointFacts')}>
        <Facts
          items={[
            [t('colReference'), <CopyReference key="id" value={endpoint.id} what={t('colReference')} />],
            [t('colFailuresInRow'), String(endpoint.consecutiveFailures)],
            [t('colLastDelivered'), mine?.lastDeliveredAt ? <DateTime key="l" value={mine.lastDeliveredAt} /> : t('noneYet')],
            ...(endpoint.status === 'disabled'
              ? ([
                  [
                    t('colWhyOff'),
                    endpoint.disabledReason ? t('whyOff', { reason: endpoint.disabledReason.replaceAll('_', ' ') }) : t('whyOffUnknown'),
                  ],
                ] as const)
              : []),
            ...(mine
              ? ([
                  [t('deliveredTile'), String(mine.deliveries.delivered)],
                  [t('waitingTile'), String(mine.deliveries.pending)],
                  [t('failedTile'), String(mine.deliveries.failed)],
                  [t('gaveUpTile'), String(mine.deliveries.dead)],
                ] as const)
              : []),
          ]}
        />
        <p className="muted">{t('queryHidden')}</p>
        <AuditPanel who={null} at={endpoint.updatedAt} />
      </PaySection>
      <PaySection title={t('manageTitle')} description={t('manageBody')}>
        <div data-testid="form-stack" className="form-stack pp-form">
          <ChangeAddress api={api} endpoint={endpoint} canManage={canManage} onDone={reload} />
          <RotateEndpointSecret
            api={api}
            endpointId={endpoint.id}
            canManage={canManage}
            onSecret={(secret) => setRevealed({ title: t('endpointSecretNewTitle'), secret, what: t('endpointSecretWhat') })}
          />
          {endpoint.status === 'active' ? (
            <PortalReview
              title={t('disableAction')}
              description={t('disableReview')}
              disabled={!canManage}
              disabledReason={t('readOnlyRole')}
              review={
                <p>
                  <strong className="pp-wrap">{shownEndpointUrl(endpoint.url)}</strong> {t('disableEffect')}
                </p>
              }
              perform={() => api.endpointDisable(endpoint.id)}
              onConfirmed={reload}
            />
          ) : (
            <p className="muted">{t('cannotReEnable')}</p>
          )}
        </div>
      </PaySection>
      <PaySection title={t('history')}>
        <Timeline
          label={t('history')}
          items={[
            ...(endpoint.updatedAt !== endpoint.createdAt ? [{ at: endpoint.updatedAt, title: t('lastChange') }] : []),
            { at: endpoint.createdAt, title: t('endpointAdded') },
          ]}
        />
      </PaySection>
      <PaySection title={t('deliveriesTitle')} description={t('endpointDeliveriesBody')}>
        <DeliveryList api={api} canManage={canManage} endpointId={endpoint.id} />
      </PaySection>
      <RelatedLinks
        links={[{ href: `/pay/developer/deliveries?endpoint=${encodeURIComponent(endpoint.id)}`, label: t('allDeliveriesFor') }]}
      />
    </div>
  );
}

function ChangeAddress({
  api,
  endpoint,
  canManage,
  onDone,
}: {
  api: Pick<SettingsBApi, 'endpointUpdate'>;
  endpoint: EndpointRow;
  canManage: boolean;
  onDone: () => void;
}) {
  const { t } = c.useCopy();
  // Starts empty on purpose: the saved address may hold a private token in its query string, which is never printed.
  const [url, setUrl] = useState('');
  const problem = url.trim() ? webhookUrlProblem(url) : null;
  const same = url.trim() === endpoint.url;
  return (
    <>
      <Field
        label={t('changeAddressLabel')}
        type="url"
        value={url}
        disabled={!canManage}
        error={problem ? t(`errUrl_${problem}`) : undefined}
        onChange={(e) => setUrl(e.target.value)}
      />
      <PortalReview
        title={t('changeAddress')}
        description={t('changeAddressReview')}
        disabled={!canManage || same || !url.trim() || Boolean(problem)}
        disabledReason={canManage ? t('urlFixFirst') : t('readOnlyRole')}
        review={
          <dl className="pay-details">
            <div>
              <dt>{t('from')}</dt>
              <dd className="pp-wrap">{shownEndpointUrl(endpoint.url)}</dd>
            </div>
            <div>
              <dt>{t('to')}</dt>
              <dd className="pp-wrap">{shownEndpointUrl(url.trim())}</dd>
            </div>
          </dl>
        }
        perform={() => api.endpointUpdate(endpoint.id, url.trim())}
        onConfirmed={onDone}
      />
    </>
  );
}

function RotateEndpointSecret({
  api,
  endpointId,
  canManage,
  onSecret,
}: {
  api: Pick<SettingsBApi, 'endpointRotate'>;
  endpointId: string;
  canManage: boolean;
  onSecret: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  // One id per review: if the reply is lost and the request is sent again, the secret is not rotated twice.
  const [requestId, setRequestId] = useState(newRequestId);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <PortalReview
        title={t('rotateEndpointAction')}
        description={t('rotateEndpointReview')}
        disabled={!canManage}
        disabledReason={t('readOnlyRole')}
        review={<p>{t('rotateEndpointEffect')}</p>}
        perform={() => api.endpointRotate(endpointId, requestId)}
        onConfirmed={(result) => {
          setRequestId(newRequestId());
          if (result.secret) {
            setNote(null);
            onSecret(result.secret);
          } else setNote(t('rotateAlreadyDone'));
        }}
      />
      {note && (
        <p className="pp-callout" role="status">
          {note}
        </p>
      )}
    </>
  );
}
