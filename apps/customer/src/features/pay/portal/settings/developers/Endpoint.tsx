// volt-room: /pay/developer/webhooks/:endpointId
// volt-room: portal:developer-endpoint
import { useState } from 'react';
import { Field } from '@intafaced/ui/lit';
import { DateTime } from '../../ui/DateTime';
import { uiCopy } from '../../ui/copy';
import { AuditPanel, CopyReference, Empty, Facts, Gate, Section, StatusChip, Timeline } from '../../volt/parts';
import { RecordListRoom } from '../../volt/RecordListRoom';
import { Review as PortalReview } from '../../volt/Review';
import { newRequestId } from '../../model';
import { useResource } from '../../../../../shared/resource';
import { useSettingsBApi, type SettingsBApi } from '../b-client';
import { DeliveryList } from './Deliveries';
import { DeveloperNav } from './DeveloperNav';
import { developersCopy as c } from './copy';
import { canManageWebhooks, shownEndpointUrl, webhookUrlProblem } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { Endpoint as EndpointRow, Health } from './schemas';

/** `/pay/developer/webhooks/:endpointId` on the record-list template: one endpoint's own page, under the developer pages' row. */
export function EndpointRoom({ endpointId }: { endpointId: string }) {
  return (
    <RecordListRoom>
      {({ role }) => ({
        detail: (
          <div className="lt-stack">
            <DeveloperNav room="developer-endpoint" />
            <LiveEndpoint endpointId={endpointId} canManage={canManageWebhooks(role)} />
          </div>
        ),
      })}
    </RecordListRoom>
  );
}

function LiveEndpoint({ endpointId, canManage }: { endpointId: string; canManage: boolean }) {
  return <EndpointPage api={useSettingsBApi()} endpointId={endpointId} canManage={canManage} />;
}

/** One webhook endpoint: its state, its recent deliveries and the three things you can do with it. */
function EndpointPage({ api, endpointId, canManage }: { api: SettingsBApi; endpointId: string; canManage: boolean }) {
  const { t } = c.useCopy();
  const found = useResource((signal) => api.endpointsList(undefined, '', endpointId, signal), `dev:endpoint:${endpointId}`);
  const health = useResource((signal) => api.webhookHealth(signal), 'dev:endpoint:health');
  // Held here, above the reload: a new secret is shown once, and reloading the endpoint after a roll must not lose it.
  const [revealed, setRevealed] = useState<Revealed>(null);
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
            revealed={revealed}
            setRevealed={setRevealed}
            reload={() => {
              found.reload();
              health.reload();
            }}
          />
        ) : (
          <Empty
            title={t('endpointMissing')}
            action={
              <a className="lt-link" href="/pay/developer/webhooks">
                {t('backToEndpoints')}
              </a>
            }
          >
            {t('endpointMissingBody')}
          </Empty>
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
  revealed: heldRevealed,
  setRevealed: setHeldRevealed,
}: {
  api: SettingsBApi;
  endpoint: EndpointRow;
  health: Health | null;
  canManage: boolean;
  reload: () => void;
  revealed?: Revealed;
  setRevealed?: (next: Revealed) => void;
}) {
  const { t } = c.useCopy();
  const { t: u } = uiCopy.useCopy();
  const [ownRevealed, setOwnRevealed] = useState<Revealed>(null);
  const revealed = setHeldRevealed ? (heldRevealed ?? null) : ownRevealed;
  const setRevealed = setHeldRevealed ?? setOwnRevealed;
  const mine = health?.endpoints.find((e) => e.endpointId === endpoint.id);
  return (
    <div className="lt-stack">
      <header className="lt-stack">
        <a className="lt-link" href="/pay/developer/webhooks">
          {t('backToEndpoints')}
        </a>
        <h2>
          <span className="lt-wrap">{shownEndpointUrl(endpoint.url)}</span> <StatusChip entity="endpoint" value={endpoint.status} />
        </h2>
        <p className="lt-muted">{endpoint.status === 'disabled' ? t('disabledSubtitle') : t('activeSubtitle')}</p>
      </header>
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      {!canManage && (
        <p className="lt-hint" role="status">
          {t('readOnlyRole')}
        </p>
      )}
      <Section title={t('endpointFacts')}>
        <Facts
          items={[
            [t('colReference'), <CopyReference key="id" value={endpoint.id} what={t('colReference')} />],
            [t('colEvents'), endpoint.eventTypes ? endpoint.eventTypes.join(', ') : t('allEventTypes')],
            [t('colFailuresInRow'), String(endpoint.consecutiveFailures)],
            ...(endpoint.previousSecretUntil
              ? ([[t('colOverlapUntil'), <DateTime key="o" value={endpoint.previousSecretUntil} />]] as const)
              : []),
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
        {endpoint.previousSecretUntil && <p className="lt-muted">{t('overlapNote')}</p>}
        <p className="lt-muted">{t('queryHidden')}</p>
        <AuditPanel who={null} at={endpoint.updatedAt} />
      </Section>
      <Section title={t('manageTitle')} description={t('manageBody')}>
        <div data-testid="form-stack" className="lt-stack">
          <ChangeAddress api={api} endpoint={endpoint} canManage={canManage} onDone={reload} />
          <RotateEndpointSecret
            api={api}
            endpointId={endpoint.id}
            canManage={canManage}
            onSecret={(secret) => {
              setRevealed({ title: t('endpointSecretNewTitle'), secret, what: t('endpointSecretWhat') });
              reload();
            }}
          />
          {endpoint.status === 'active' ? (
            <PortalReview
              title={t('disableAction')}
              description={t('disableReview')}
              disabled={!canManage}
              disabledReason={t('readOnlyRole')}
              review={
                <p>
                  <strong className="lt-wrap">{shownEndpointUrl(endpoint.url)}</strong> {t('disableEffect')}
                </p>
              }
              perform={() => api.endpointDisable(endpoint.id)}
              onConfirmed={reload}
            />
          ) : (
            <p className="lt-muted">{t('cannotReEnable')}</p>
          )}
        </div>
      </Section>
      <Section title={t('history')}>
        <Timeline
          label={t('history')}
          items={[
            ...(endpoint.updatedAt !== endpoint.createdAt ? [{ at: endpoint.updatedAt, title: t('lastChange') }] : []),
            { at: endpoint.createdAt, title: t('endpointAdded') },
          ]}
        />
      </Section>
      <Section title={t('deliveriesTitle')} description={t('endpointDeliveriesBody')}>
        <DeliveryList api={api} canManage={canManage} endpointId={endpoint.id} />
      </Section>
      <nav aria-label={u('related')}>
        <h3>{u('related')}</h3>
        <ul>
          <li>
            <a className="lt-link" href={`/pay/developer/deliveries?endpoint=${encodeURIComponent(endpoint.id)}`}>
              {t('allDeliveriesFor')}
            </a>
          </li>
        </ul>
      </nav>
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
          <dl className="lt-kv">
            <div>
              <dt>{t('from')}</dt>
              <dd className="lt-wrap">{shownEndpointUrl(endpoint.url)}</dd>
            </div>
            <div>
              <dt>{t('to')}</dt>
              <dd className="lt-wrap">{shownEndpointUrl(url.trim())}</dd>
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
  api: Pick<SettingsBApi, 'endpointRotate' | 'webhookPolicy'>;
  endpointId: string;
  canManage: boolean;
  onSecret: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  // One id per review: if the reply is lost and the request is sent again, the secret is not rotated twice.
  const [requestId, setRequestId] = useState(newRequestId);
  const [note, setNote] = useState<string | null>(null);
  const [overlap, setOverlap] = useState('0');
  const policy = useResource((signal) => api.webhookPolicy(signal), 'dev:policy');
  const max = policy.resource.status === 'ready' ? policy.resource.data.overlapMaxSeconds : undefined;
  const seconds = /^\d+$/.test(overlap.trim()) ? Number(overlap.trim()) : null;
  // The service is the judge (a blank maximum refuses any overlap); this only keeps an obvious typo off the wire.
  const overlapError =
    seconds === null ? t('overlapInvalid') : typeof max === 'number' && seconds > max ? t('overlapTooLong', { max }) : undefined;
  return (
    <>
      <Field
        label={t('overlapLabel')}
        hint={typeof max === 'number' ? t('overlapHint', { max }) : max === null ? t('overlapHintUnset') : undefined}
        inputMode="numeric"
        value={overlap}
        disabled={!canManage}
        error={overlapError}
        onChange={(e) => setOverlap(e.target.value)}
      />
      <PortalReview
        title={t('rotateEndpointAction')}
        description={t('rotateEndpointReview')}
        disabled={!canManage || Boolean(overlapError)}
        disabledReason={canManage ? (overlapError ?? '') : t('readOnlyRole')}
        review={<p>{seconds ? t('overlapEffect', { n: seconds }) : t('rotateEndpointEffect')}</p>}
        perform={() => api.endpointRotate(endpointId, requestId, seconds ?? 0)}
        onConfirmed={(result) => {
          setRequestId(newRequestId());
          if (result.secret) {
            setNote(null);
            onSecret(result.secret);
          } else setNote(t('rotateAlreadyDone'));
        }}
      />
      {note && (
        <p className="lt-hint" role="status">
          {note}
        </p>
      )}
    </>
  );
}
