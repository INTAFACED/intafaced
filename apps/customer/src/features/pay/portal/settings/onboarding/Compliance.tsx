import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { MerchantActivation } from '@intafaced/contracts/merchant-activation';
import { useResource, type Resource } from '../../../../../shared/resource';
import { useCursorList, type ListState } from '../../hooks';
import type { PortalApi } from '../../api';
import { kybCurrentSchema, type KybEvent, type MemberRole } from '../../schemas';
import { DateTime } from '../../ui/DateTime';
import { useReadAt } from '../../hooks';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { SettingsRoom } from '../../volt/SettingsRoom';
import { extensionCopy as c, portalCopy } from '../copy';
import { kybWord } from './kyb-word';
import { BusinessCategory } from './Category';
import { InformationRequests } from './Requests';
import { Chip, CopyReference, Freshness, Gate, ListShell, MoreFooter, NotLive, Section, Timeline } from '../../volt/parts';
import { Button } from '@intafaced/ui/lit';

type Kyb = z.infer<typeof kybCurrentSchema>;

/** `/pay/compliance`: where your business verification stands and what INTAFACED still needs. Screening results are never shown here. */
function Compliance({ portal, merchantId, role }: { portal: PortalApi; merchantId: string; role: MemberRole }) {
  const current = useResource((signal) => portal.kybCurrent(signal), 'portal:compliance-current');
  const activation = useResource((signal) => portal.activation(signal), 'portal:compliance-activation');
  const history = useCursorList(
    (cursor, signal) => portal.kybHistory(cursor, signal),
    'portal:compliance-history',
    (e) => e.seq,
  );
  return (
    <ComplianceView
      current={current.resource}
      activation={activation.resource}
      retryActivation={activation.reload}
      history={history.state}
      loadMore={history.loadMore}
      reload={() => {
        current.reload();
        activation.reload();
        history.reload();
      }}
      category={<BusinessCategory portal={portal} merchantId={merchantId} role={role} />}
      requests={<InformationRequests portal={portal} merchantId={merchantId} role={role} />}
    />
  );
}

export function ComplianceView({
  current,
  activation,
  retryActivation,
  history,
  loadMore,
  reload,
  category,
  requests,
}: {
  current: Resource<Kyb>;
  /** svc-pay's own activation record; its own read, so a failure here never hides the verification record. */
  activation: Resource<MerchantActivation>;
  /** Re-reads the activation alone, so a failed activation read never drops the loaded history. Defaults to `reload`. */
  retryActivation?: () => void;
  history: ListState<KybEvent>;
  loadMore: () => void;
  reload: () => void;
  /** The business category and the table it chooses from; rendered after the record. */
  category?: ReactNode;
  /** What INTAFACED asked the business for; rendered between the record and the history. */
  requests?: ReactNode;
}) {
  const { t } = accountCopy.useCopy();
  const { t: p } = portalCopy.useCopy();
  const at = useReadAt(current.status === 'ready', current);
  const activationAt = useReadAt(activation.status === 'ready', activation);
  return (
    <div>
      <Section
        title={c.t('currentRecord')}
        action={
          <Button tone="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <Gate resource={current} retry={reload}>
          {(record) => (
            <>
              <dl data-testid="pp-facts" className="lt-kv">
                <div>
                  <dt>{c.t('verificationStatus')}</dt>
                  <dd>
                    <Chip kind="kyb" value={record.kybStatus} />
                  </dd>
                </div>
                <div>
                  <dt>{c.t('verificationReference')}</dt>
                  <dd>
                    {record.kybRef ? <CopyReference value={record.kybRef} what={c.t('verificationReference')} /> : c.t('noReference')}
                  </dd>
                </div>
                <div>
                  <dt>{t('compScreening')}</dt>
                  <dd>{t('compScreeningValue')}</dd>
                </div>
              </dl>
              <Freshness asOf={at} />
              <p className="lt-hint">{t('compNotScreening')}</p>
              <p>
                <a className="lt-link" href="/pay/onboarding/verification">
                  {c.t('verificationAction')}
                </a>
              </p>
            </>
          )}
        </Gate>
      </Section>
      <Section title={c.t('activationTitle')} description={c.t('activationBody')}>
        <Gate resource={activation} retry={retryActivation ?? reload} rows={2}>
          {(a) => (
            <>
              <ActivationFacts activation={a} />
              <Freshness asOf={activationAt} />
            </>
          )}
        </Gate>
      </Section>
      {category}
      {requests}
      <Section title={t('compNextTitle')} description={t('compNextBody')}>
        <NotLive reason={notLive('reasonDocuments')} needs="document check provider" title={t('docsHeading')}>
          {t('docsBlocked')}
        </NotLive>
      </Section>
      <Section title={c.t('complianceHistory')} description={t('compHistoryBody')}>
        <ListShell
          state={history}
          retry={reload}
          empty={{
            title: c.t('complianceEmpty'),
            body: t('compEmptyBody'),
            action: (
              <a className="lt-link" href="/pay/onboarding/verification">
                {c.t('verificationAction')}
              </a>
            ),
          }}
        >
          {(events) => (
            <>
              <Timeline
                label={c.t('complianceHistory')}
                items={events.map((e) => ({
                  at: e.at,
                  title: `${c.t('complianceChange')}: ${kybWord(e.fromStatus, p)} → ${kybWord(e.toStatus, p)}`,
                  detail: c.t(e.decidedBy === 'merchant' ? 'changedByMerchant' : 'changedByIntafaced'),
                }))}
              />
              {history.status === 'ready' && <MoreFooter state={history} onMore={loadMore} />}
            </>
          )}
        </ListShell>
      </Section>
    </div>
  );
}

/** Confirmed with the recorded time, or "Unconfirmed" with why. Never a screening outcome, never inferred from verification. */
export function ActivationFacts({ activation }: { activation: MerchantActivation }) {
  return (
    <>
      <dl data-testid="pp-activation" className="lt-kv">
        <div>
          <dt>{c.t('activationLabel')}</dt>
          <dd>{c.t(activation.activation === 'confirmed' ? 'activationConfirmed' : 'activationUnconfirmed')}</dd>
        </div>
        {activation.activation === 'confirmed' ? (
          <div>
            <dt>{c.t('activationAt')}</dt>
            <dd>
              <DateTime value={activation.activatedAt} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{c.t('activationAccountStatus')}</dt>
          <dd>
            <Chip kind="merchant" value={activation.status} />
          </dd>
        </div>
      </dl>
      {activation.activation === 'unconfirmed' ? <p>{c.t(`activationWhy_${activation.reason}`)}</p> : null}
      <p className="lt-hint">{c.t('activationNotScreening')}</p>
    </>
  );
}

/** `/pay/compliance` on the settings template. */
export function ComplianceRoom({ portal }: { portal: PortalApi }) {
  const { t } = accountCopy.useCopy();
  return (
    <SettingsRoom explain={<p>{t('complianceExplain')}</p>}>
      {({ merchantId, role }) => <Compliance portal={portal} merchantId={merchantId} role={role} />}
    </SettingsRoom>
  );
}
