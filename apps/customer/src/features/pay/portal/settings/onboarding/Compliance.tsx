import type { ReactNode } from 'react';
import type { z } from 'zod';
import { Button } from '@intafaced/ui';
import { useResource, type Resource } from '../../../../../shared/resource';
import { PaySection } from '../../../components';
import { Chip, Gate, ListShell, MoreFooter } from '../../components';
import { useCursorList, type ListState } from '../../hooks';
import type { PortalApi } from '../../api';
import { kybCurrentSchema, type KybEvent, type MemberRole } from '../../schemas';
import { CopyReference } from '../../ui/CopyReference';
import { Freshness } from '../../ui/Freshness';
import { Timeline } from '../../ui/Timeline';
import { useReadAt } from '../../hooks';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { Blocker } from '../account/ui';
import { extensionCopy as c, portalCopy } from '../copy';
import { kybWord } from './Onboarding';
import { BusinessCategory } from './Category';
import { InformationRequests } from './Requests';

type Kyb = z.infer<typeof kybCurrentSchema>;

/** `/pay/compliance`: where your business verification stands and what INTAFACED still needs. Screening results are never shown here. */
export function Compliance({ portal, merchantId, role }: { portal: PortalApi; merchantId: string; role: MemberRole }) {
  const current = useResource((signal) => portal.kybCurrent(signal), 'portal:compliance-current');
  const history = useCursorList(
    (cursor, signal) => portal.kybHistory(cursor, signal),
    'portal:compliance-history',
    (e) => e.seq,
  );
  return (
    <ComplianceView
      current={current.resource}
      history={history.state}
      loadMore={history.loadMore}
      reload={() => {
        current.reload();
        history.reload();
      }}
      category={<BusinessCategory portal={portal} merchantId={merchantId} role={role} />}
      requests={<InformationRequests portal={portal} merchantId={merchantId} role={role} />}
    />
  );
}

export function ComplianceView({
  current,
  history,
  loadMore,
  reload,
  category,
  requests,
}: {
  current: Resource<Kyb>;
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
  return (
    <div className="stack">
      <PaySection
        title={c.t('currentRecord')}
        action={
          <Button variant="secondary" onClick={reload}>
            {c.t('refresh')}
          </Button>
        }
      >
        <Gate resource={current} retry={reload}>
          {(record) => (
            <>
              <dl data-testid="pp-facts" className="pp-facts">
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
              <p className="pp-callout">{t('compNotScreening')}</p>
              <p>
                <a className="text-link" href="/pay/onboarding/verification">
                  {c.t('verificationAction')}
                </a>
              </p>
            </>
          )}
        </Gate>
      </PaySection>
      {category}
      {requests}
      <PaySection title={t('compNextTitle')} description={t('compNextBody')}>
        <Blocker reason={notLive('reasonDocuments')} needs="document check provider" title={t('docsHeading')}>
          {t('docsBlocked')}
        </Blocker>
      </PaySection>
      <PaySection title={c.t('complianceHistory')} description={t('compHistoryBody')}>
        <ListShell
          state={history}
          retry={reload}
          empty={{
            title: c.t('complianceEmpty'),
            body: t('compEmptyBody'),
            action: (
              <a className="text-link" href="/pay/onboarding/verification">
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
      </PaySection>
    </div>
  );
}
